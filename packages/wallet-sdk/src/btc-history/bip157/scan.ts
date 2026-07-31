// scan.ts — BIP157/158 주소 이력 스캔 오케스트레이션.
//
// 흐름: 핸드셰이크(NODE_COMPACT_FILTERS 요구) → 헤더 체인 따라가기 →
//       cfheaders 로 필터 헤더 체인 검증 → cfilter 를 관심 scriptPubKey 로 매칭 →
//       매칭 블록만 getdata 로 받아 tx 스캔.
//
// 제3자 인덱서 의존 0 — 상대는 임의의 BIP157 풀노드면 된다.
// 전송은 ByteTransport 계약(../transport.ts)으로 주입받는다.
//
// 재조직(reorg) 처리 — 단순 롤백:
//   headers 응답이 현재 끝(tip)에 연결되지 않으면, 새 헤더의 prev 를 이미 아는
//   체인에서 찾아 그 지점(마지막 공통 조상)까지 되감고 이어 붙인다.
//   한계 (의도적 단순화):
//     - 체크포인트보다 깊은 재조직은 처리하지 않고 예외를 던진다.
//     - PoW 목표(bits) 검증·누적 난이도 비교를 하지 않는다 — 연결성만 본다.
//       악의적 피어가 가짜 저난이도 체인을 줄 수 있으므로, 실전에서는 복수 피어
//       교차 확인 또는 체크포인트 갱신 정책을 위에 얹어야 한다.

import type { ByteTransport } from '../transport.js';
import {
  BlockHeader,
  DecodedTx,
  FILTER_TYPE_BASIC,
  INV_BLOCK,
  MAX_CFHEADERS_PER_REQUEST,
  MAX_CFILTERS_PER_REQUEST,
  bytesEqual,
  bytesToHex,
  decodeBlock,
  decodeCfHeaders,
  decodeCfilter,
  decodeHeadersMessage,
  encodeGetCfHeaders,
  encodeGetCfilters,
  encodeGetData,
  encodeGetHeaders,
  internalHashToDisplay,
  isCoinbase,
} from './messages.js';
import {
  MAINNET_MAGIC,
  P2PFrameDecoder,
  P2PMessage,
  buildPongPayload,
  buildVersionPayload,
  encodeMessage,
  hasCompactFilters,
  parsePingPayload,
  parseVersionPayload,
} from './p2p.js';
import {
  computeFilterHash,
  computeFilterHeader,
  filterKeyFromBlockHash,
  gcsMatchAny,
} from './gcs.js';

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

/** 스캔 시작점 — 이 블록 "다음"부터 스캔한다. */
export interface ScanCheckpoint {
  height: number;
  /** internal 순서 블록해시. */
  blockHash: Uint8Array;
  /** 이 블록의 basic filter header (internal). 제네시스부터면 32바이트 0 + height -1 대신
   *  제네시스 블록해시·필터헤더를 넣는다. */
  filterHeader: Uint8Array;
}

export interface ScanOptions {
  host: string;
  port: number;
  /** 관심 scriptPubKey 원문 (주소를 스크립트로 변환해 넣는다). */
  watchScripts: Uint8Array[];
  checkpoint: ScanCheckpoint;
  /** 이미 보유로 아는 outpoint ("txid display hex:vout") — 지출 감지 시드. */
  knownOutpoints?: string[];
  /** 이 높이까지만 스캔 (기본: 피어의 최신까지). */
  stopAtHeight?: number;
  magic?: Uint8Array;
  userAgent?: string;
  /** 메시지 응답 대기 상한 (ms). 기본 20000. */
  messageTimeoutMs?: number;
  /** getdata 한 번에 요청할 블록 수. 기본 16. */
  blockBatchSize?: number;
  tls?: boolean;
  connectTimeoutMs?: number;
}

export interface ScanTxRecord {
  height: number;
  /** display hex. */
  blockHash: string;
  /** display hex. */
  txid: string;
  timestamp: number;
  /** 우리 스크립트로 들어온 출력. */
  receivedOutputs: { vout: number; value: bigint; scriptPubKeyHex: string }[];
  /** 우리 outpoint 를 소비한 입력. */
  spentOutpoints: { txid: string; vout: number }[];
}

export interface ScanResult {
  tipHeight: number;
  /** display hex. */
  tipHash: string;
  records: ScanTxRecord[];
  matchedBlockCount: number;
  scannedFilterCount: number;
  /** 스캔 후 보유 outpoint 집합 ("txid:vout") — 다음 스캔의 knownOutpoints 로. */
  ownedOutpoints: string[];
}

// ---------------------------------------------------------------------------
// 피어 래퍼 — 메시지 큐 + 요청/응답 대기. ping 자동 pong, 협상 메시지 무시.
// ---------------------------------------------------------------------------

/** 스캔에 안 쓰는 협상·릴레이 메시지 — 받으면 조용히 버린다 (sendheaders 포함). */
const IGNORED_COMMANDS = new Set([
  'sendheaders',
  'sendcmpct',
  'wtxidrelay',
  'sendaddrv2',
  'addr',
  'addrv2',
  'inv',
  'tx',
  'feefilter',
  'getheaders',
  'getaddr',
  'alert',
  'pong',
]);

class Peer {
  private readonly decoder: P2PFrameDecoder;
  private queue: P2PMessage[] = [];
  private waiter: {
    commands: Set<string>;
    resolve: (m: P2PMessage) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private closedErr: Error | null = null;

  constructor(
    private readonly transport: ByteTransport,
    private readonly magic: Uint8Array,
    private readonly timeoutMs: number,
  ) {
    this.decoder = new P2PFrameDecoder(magic);
    transport.onData((chunk) => this.handleChunk(chunk));
    transport.onClose((err) => this.handleClose(err ?? new Error('peer closed connection')));
  }

  private handleChunk(chunk: Uint8Array): void {
    let messages: P2PMessage[];
    try {
      messages = this.decoder.push(chunk);
    } catch (e) {
      this.handleClose(e instanceof Error ? e : new Error(String(e)));
      void this.transport.close().catch(() => undefined);
      return;
    }
    for (const msg of messages) {
      if (msg.command === 'ping') {
        // ping → 같은 nonce 로 pong (응답 대기 없음)
        void this.send('pong', buildPongPayload(parsePingPayload(msg.payload))).catch(
          () => undefined,
        );
        continue;
      }
      if (IGNORED_COMMANDS.has(msg.command)) continue;
      this.queue.push(msg);
      this.tryDeliver();
    }
  }

  private handleClose(err: Error): void {
    if (this.closedErr) return;
    this.closedErr = err;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(err);
      this.waiter = null;
    }
  }

  private tryDeliver(): void {
    if (!this.waiter) return;
    const idx = this.queue.findIndex((m) => this.waiter!.commands.has(m.command));
    if (idx < 0) return;
    const msg = this.queue.splice(idx, 1)[0]!;
    clearTimeout(this.waiter.timer);
    const { resolve } = this.waiter;
    this.waiter = null;
    resolve(msg);
  }

  async send(command: string, payload: Uint8Array): Promise<void> {
    await this.transport.send(encodeMessage(command, payload, this.magic));
  }

  /** commands 중 하나가 올 때까지 대기 (동시에 하나의 대기만 지원 — 순차 프로토콜). */
  next(...commands: string[]): Promise<P2PMessage> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    if (this.waiter) return Promise.reject(new Error('peer: concurrent next() not supported'));
    return new Promise<P2PMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.waiter = null;
          reject(new Error(`peer: timeout waiting for [${commands.join(', ')}]`));
        },
        this.timeoutMs,
      );
      this.waiter = { commands: new Set(commands), resolve, reject, timer };
      this.tryDeliver();
    });
  }
}

// ---------------------------------------------------------------------------
// 스캔 본체
// ---------------------------------------------------------------------------

interface ChainEntry {
  height: number;
  hash: Uint8Array; // internal
  header: BlockHeader | null; // 체크포인트 항목은 null
}

/**
 * BIP157 주소 이력 스캔 — 단일 피어, 체크포인트 이후 구간.
 * 성공/실패와 무관하게 transport 는 닫고 반환한다.
 */
export async function bip157Scan(
  transport: ByteTransport,
  opts: ScanOptions,
): Promise<ScanResult> {
  const magic = opts.magic ?? MAINNET_MAGIC;
  const timeoutMs = opts.messageTimeoutMs ?? 20_000;
  const blockBatchSize = opts.blockBatchSize ?? 16;

  if (opts.watchScripts.length === 0) throw new Error('scan: watchScripts is empty');
  if (opts.checkpoint.blockHash.length !== 32 || opts.checkpoint.filterHeader.length !== 32) {
    throw new Error('scan: checkpoint hashes must be 32 bytes');
  }

  await transport.connect(opts.host, opts.port, {
    tls: opts.tls,
    timeoutMs: opts.connectTimeoutMs ?? 8000,
  });
  const peer = new Peer(transport, magic, timeoutMs);

  try {
    // --- 1. 핸드셰이크 -----------------------------------------------------
    await peer.send(
      'version',
      buildVersionPayload({ userAgent: opts.userAgent, relay: false }),
    );
    const versionMsg = await peer.next('version');
    const remote = parseVersionPayload(versionMsg.payload);
    if (!hasCompactFilters(remote.services)) {
      throw new Error(
        `scan: peer lacks NODE_COMPACT_FILTERS (services=0x${remote.services.toString(16)})`,
      );
    }
    await peer.send('verack', new Uint8Array(0));
    await peer.next('verack');

    // --- 2. 헤더 체인 따라가기 --------------------------------------------
    const chain: ChainEntry[] = [
      { height: opts.checkpoint.height, hash: opts.checkpoint.blockHash, header: null },
    ];
    const knownIndex = new Map<string, number>([[bytesToHex(opts.checkpoint.blockHash), 0]]);

    const appendHeader = (h: BlockHeader): void => {
      const tip = chain[chain.length - 1]!;
      if (!bytesEqual(h.prevBlockHash, tip.hash)) {
        if (knownIndex.has(bytesToHex(h.hash))) return; // 이미 아는 헤더 — 중복 무시
        // 재조직 — 마지막 공통 조상(prev 가 가리키는 지점)까지 단순 롤백
        const ancestorIdx = knownIndex.get(bytesToHex(h.prevBlockHash));
        if (ancestorIdx === undefined) {
          throw new Error(
            'scan: header does not connect — reorg deeper than checkpoint (unsupported)',
          );
        }
        for (let i = ancestorIdx + 1; i < chain.length; i++) {
          knownIndex.delete(bytesToHex(chain[i]!.hash));
        }
        chain.length = ancestorIdx + 1;
      }
      const entry: ChainEntry = {
        height: chain[chain.length - 1]!.height + 1,
        hash: h.hash,
        header: h,
      };
      chain.push(entry);
      knownIndex.set(bytesToHex(entry.hash), chain.length - 1);
    };

    for (;;) {
      // locator: tip 쪽 몇 개 + 체크포인트 (재조직 시 공통 조상 탐색용)
      const locator: Uint8Array[] = [];
      for (let i = chain.length - 1; i >= 0 && locator.length < 8; i -= 1) {
        locator.push(chain[i]!.hash);
      }
      if (!locator.some((h) => bytesEqual(h, opts.checkpoint.blockHash))) {
        locator.push(opts.checkpoint.blockHash);
      }
      await peer.send('getheaders', encodeGetHeaders(locator));
      const headersMsg = await peer.next('headers');
      const headers = decodeHeadersMessage(headersMsg.payload);
      if (headers.length === 0) break;
      for (const h of headers) appendHeader(h);
      if (opts.stopAtHeight !== undefined && chain[chain.length - 1]!.height >= opts.stopAtHeight)
        break;
      if (headers.length < 2000) break; // 끝까지 받음
    }

    // stopAtHeight 로 상한 자르기
    if (opts.stopAtHeight !== undefined) {
      while (chain.length > 1 && chain[chain.length - 1]!.height > opts.stopAtHeight) {
        knownIndex.delete(bytesToHex(chain[chain.length - 1]!.hash));
        chain.pop();
      }
    }

    const tip = chain[chain.length - 1]!;
    const newBlocks = chain.slice(1); // 체크포인트 다음부터
    const result: ScanResult = {
      tipHeight: tip.height,
      tipHash: internalHashToDisplay(tip.hash),
      records: [],
      matchedBlockCount: 0,
      scannedFilterCount: 0,
      ownedOutpoints: [...(opts.knownOutpoints ?? [])],
    };
    if (newBlocks.length === 0) return result;

    // --- 3. cfheaders — 필터 헤더 체인 검증 --------------------------------
    // filterHashByHeight: height → 검증된 filter_hash
    const filterHashByHeight = new Map<number, Uint8Array>();
    let prevFilterHeader = opts.checkpoint.filterHeader;
    for (let i = 0; i < newBlocks.length; i += MAX_CFHEADERS_PER_REQUEST) {
      const batch = newBlocks.slice(i, i + MAX_CFHEADERS_PER_REQUEST);
      const stop = batch[batch.length - 1]!;
      await peer.send('getcfheaders', encodeGetCfHeaders(batch[0]!.height, stop.hash));
      const msg = await peer.next('cfheaders');
      const cf = decodeCfHeaders(msg.payload);
      if (cf.filterType !== FILTER_TYPE_BASIC) throw new Error('scan: unexpected filter type');
      if (!bytesEqual(cf.stopHash, stop.hash)) throw new Error('scan: cfheaders stop mismatch');
      if (!bytesEqual(cf.previousFilterHeader, prevFilterHeader)) {
        throw new Error('scan: filter header chain does not connect to checkpoint');
      }
      if (cf.filterHashes.length !== batch.length) {
        throw new Error(
          `scan: cfheaders count ${cf.filterHashes.length} != expected ${batch.length}`,
        );
      }
      for (let j = 0; j < batch.length; j++) {
        filterHashByHeight.set(batch[j]!.height, cf.filterHashes[j]!);
        prevFilterHeader = computeFilterHeader(cf.filterHashes[j]!, prevFilterHeader);
      }
    }

    // --- 4. cfilter — 관심 스크립트 매칭 -----------------------------------
    const entryByHash = new Map<string, ChainEntry>();
    for (const e of newBlocks) entryByHash.set(bytesToHex(e.hash), e);
    const matched: ChainEntry[] = [];

    for (let i = 0; i < newBlocks.length; i += MAX_CFILTERS_PER_REQUEST) {
      const batch = newBlocks.slice(i, i + MAX_CFILTERS_PER_REQUEST);
      const stop = batch[batch.length - 1]!;
      await peer.send('getcfilters', encodeGetCfilters(batch[0]!.height, stop.hash));
      const seen = new Set<number>();
      while (seen.size < batch.length) {
        const msg = await peer.next('cfilter');
        const cf = decodeCfilter(msg.payload);
        const entry = entryByHash.get(bytesToHex(cf.blockHash));
        if (entry === undefined) throw new Error('scan: cfilter for unknown block');
        if (seen.has(entry.height)) throw new Error('scan: duplicate cfilter');
        seen.add(entry.height);
        const expectHash = filterHashByHeight.get(entry.height)!;
        if (!bytesEqual(computeFilterHash(cf.filterBytes), expectHash)) {
          throw new Error(`scan: cfilter hash mismatch at height ${entry.height} — peer lied`);
        }
        result.scannedFilterCount++;
        const key = filterKeyFromBlockHash(cf.blockHash);
        if (gcsMatchAny(cf.filterBytes, key, opts.watchScripts)) {
          matched.push(entry);
        }
      }
    }
    matched.sort((a, b) => a.height - b.height);
    result.matchedBlockCount = matched.length;

    // --- 5. 매칭 블록 다운로드 → tx 스캔 -----------------------------------
    const watchSet = new Set(opts.watchScripts.map((s) => bytesToHex(s)));
    const owned = new Set(result.ownedOutpoints);

    const scanTx = (tx: DecodedTx, entry: ChainEntry): void => {
      const receivedOutputs: ScanTxRecord['receivedOutputs'] = [];
      const spentOutpoints: ScanTxRecord['spentOutpoints'] = [];
      if (!isCoinbase(tx)) {
        for (const inp of tx.inputs) {
          const key = `${internalHashToDisplay(inp.prevTxid)}:${inp.prevVout}`;
          if (owned.has(key)) {
            owned.delete(key);
            spentOutpoints.push({
              txid: internalHashToDisplay(inp.prevTxid),
              vout: inp.prevVout,
            });
          }
        }
      }
      const txidDisplay = internalHashToDisplay(tx.txid);
      for (let vout = 0; vout < tx.outputs.length; vout++) {
        const out = tx.outputs[vout]!;
        if (watchSet.has(bytesToHex(out.scriptPubKey))) {
          receivedOutputs.push({
            vout,
            value: out.value,
            scriptPubKeyHex: bytesToHex(out.scriptPubKey),
          });
          owned.add(`${txidDisplay}:${vout}`);
        }
      }
      if (receivedOutputs.length > 0 || spentOutpoints.length > 0) {
        result.records.push({
          height: entry.height,
          blockHash: internalHashToDisplay(entry.hash),
          txid: txidDisplay,
          timestamp: entry.header?.timestamp ?? 0,
          receivedOutputs,
          spentOutpoints,
        });
      }
    };

    for (let i = 0; i < matched.length; i += blockBatchSize) {
      const batch = matched.slice(i, i + blockBatchSize);
      await peer.send(
        'getdata',
        encodeGetData(batch.map((e) => ({ type: INV_BLOCK, hash: e.hash }))),
      );
      const pending = new Map(batch.map((e) => [bytesToHex(e.hash), e]));
      while (pending.size > 0) {
        const msg = await peer.next('block', 'notfound');
        if (msg.command === 'notfound') throw new Error('scan: peer has no block data (pruned?)');
        const block = decodeBlock(msg.payload);
        const entry = pending.get(bytesToHex(block.header.hash));
        if (!entry) continue; // 요청 안 한 블록 — 무시
        pending.delete(bytesToHex(block.header.hash));
        for (const tx of block.transactions) scanTx(tx, entry);
      }
    }

    result.ownedOutpoints = [...owned];
    return result;
  } finally {
    await transport.close().catch(() => undefined);
  }
}
