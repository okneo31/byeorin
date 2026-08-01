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
  computeMerkleRoot,
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
  /** 이미 보유로 아는 outpoint ("txid display hex:vout") — 지출 감지 시드.
   *  체크포인트 시점의 미지출 outpoint 를 전부 넣어야 한다. 빠뜨리면 그 지출은
   *  이력에서 누락되고, 해당 블록은 emptyMatchedBlockHeights 로만 나타난다. */
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
  /** 필터는 매칭됐는데 레코드가 0건인 블록 높이 — GCS 오탐(희박) 또는
   *  knownOutpoints 미시드로 인한 지출 누락 신호. 다른 트랙 재검증 후보. */
  emptyMatchedBlockHeights: number[];
}

// ---------------------------------------------------------------------------
// 피어 래퍼 — 메시지 큐 + 요청/응답 대기. ping 자동 pong, 협상 메시지 무시.
// ---------------------------------------------------------------------------

/** next() 로 소비하는 응답 명령 전집합 — 이 밖의 명령은 큐잉하지 않는다.
 *  미지 명령 무시는 P2P 규격의 표준 동작이고, 여기서 큐잉해 봐야 소비자가 없다
 *  (협상·릴레이 메시지 sendheaders/inv/addr 류도 같은 이유로 여기서 걸러진다). */
const RESPONSE_COMMANDS = new Set([
  'version',
  'verack',
  'headers',
  'cfheaders',
  'cfilter',
  'block',
  'notfound',
]);

/** 큐 백스톱 — 정직한 최대 백로그(getcfilters 1회 = 1000통)의 2배. */
const MAX_QUEUE_MESSAGES = 2048;
/** cfilter 1000개 배치(메인넷 수십 KB/개)는 통과시키되 무한 축적은 차단. */
const MAX_QUEUE_BYTES = 64 * 1024 * 1024;

class Peer {
  private readonly decoder: P2PFrameDecoder;
  private queue: P2PMessage[] = [];
  private queueBytes = 0;
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
        // BIP31 이전 ping 은 페이로드가 없을 수 있다 — 파싱 실패는 위반이 아니라
        // 구식 노드이므로 pong 만 생략하고 연결은 유지한다. handleChunk 전체를
        // 감싸면 waiter.resolve 의 동기 continuation 예외까지 삼키므로 여기만 감싼다.
        try {
          void this.send('pong', buildPongPayload(parsePingPayload(msg.payload))).catch(
            () => undefined,
          );
        } catch {
          // nonce 없는 ping — 응답 불가, 무시
        }
        continue;
      }
      if (!RESPONSE_COMMANDS.has(msg.command)) continue;
      if (
        this.queue.length >= MAX_QUEUE_MESSAGES ||
        this.queueBytes + msg.payload.length > MAX_QUEUE_BYTES
      ) {
        // 순차 프로토콜에서 이만한 백로그는 정상 경로에 없다 — 오래된 것을 조용히
        // 버리면 진짜 응답이 사라져 타임아웃까지 침묵하므로, 끊고 예외로 드러낸다.
        const err = new Error(
          `peer: message queue overflow — peer flooding (${this.queue.length} msgs / ${this.queueBytes} bytes)`,
        );
        this.handleClose(err);
        void this.transport.close().catch(() => undefined);
        return;
      }
      this.queue.push(msg);
      this.queueBytes += msg.payload.length;
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
    this.queueBytes -= msg.payload.length;
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

    // 피어가 version 에 알린 높이 기준 라운드 상한 — 정상 동기 라운드 수의 2배에
    // 규격상 허용되는 소배치 응답 여유 8을 더한다. 이 상한을 넘는 요청은
    // 피어 상태와 무관하게 클라이언트 쪽 이상이다.
    const expectedRounds = Math.max(
      1,
      Math.ceil(Math.max(remote.startHeight - opts.checkpoint.height, 1) / 2000),
    );
    const maxRounds = expectedRounds * 2 + 8;
    let rounds = 0;

    for (;;) {
      rounds += 1;
      if (rounds > maxRounds) {
        throw new Error(
          `scan: 헤더 동기 라운드 상한 ${maxRounds} 초과 (peer height ${remote.startHeight})`,
        );
      }
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
      const lenBefore = chain.length;
      const tipBefore = chain[chain.length - 1]!.hash;
      for (const h of headers) appendHeader(h);
      // 무진전 = locator 창(끝 8 + 체크포인트) 밖 갈림점이거나 악의적 반복 —
      // 같은 locator 를 다시 보내 봐야 같은 응답이라 재시도는 의미가 없다.
      // 즉시 끊고 예외로 드러낸다 (다음 스캔이 새 체크포인트로 다시 시도한다).
      if (
        chain.length === lenBefore &&
        bytesEqual(chain[chain.length - 1]!.hash, tipBefore)
      ) {
        throw new Error('scan: 무진전 — 헤더 응답에 체인 진전 없음, 동기 중단');
      }
      if (opts.stopAtHeight !== undefined && chain[chain.length - 1]!.height >= opts.stopAtHeight)
        break;
      // 규격상 소배치도 허용 — 소배치이면서 피어가 알린 팁에 닿았을 때만 끝으로 본다
      if (headers.length < 2000 && chain[chain.length - 1]!.height >= remote.startHeight) break;
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
      emptyMatchedBlockHeights: [],
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
    const matched: ChainEntry[] = [];

    for (let i = 0; i < newBlocks.length; i += MAX_CFILTERS_PER_REQUEST) {
      const batch = newBlocks.slice(i, i + MAX_CFILTERS_PER_REQUEST);
      const stop = batch[batch.length - 1]!;
      await peer.send('getcfilters', encodeGetCfilters(batch[0]!.height, stop.hash));
      // 배치 전용 맵 — 요청 범위 밖 cfilter 가 seen 을 부풀려 수신 루프를
      // 조기 종료시키는 것을 막는다. getcfilters 는 순차 1건씩이므로
      // 배치 밖 응답은 전부 unsolicited — 즉시 끊는다.
      const batchByHash = new Map<string, ChainEntry>();
      for (const e of batch) batchByHash.set(bytesToHex(e.hash), e);
      const seen = new Set<number>();
      while (seen.size < batch.length) {
        const msg = await peer.next('cfilter');
        const cf = decodeCfilter(msg.payload);
        if (cf.filterType !== FILTER_TYPE_BASIC) throw new Error('scan: unexpected filter type');
        const entry = batchByHash.get(bytesToHex(cf.blockHash));
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
      // 도착 순서는 피어 재량 — 지출 블록이 수신 블록보다 먼저 스캔되면 owned 에
      // outpoint 가 아직 없어 지출이 통째로 빠진다. 배치를 전부 모은 뒤 높이
      // 오름차순으로 스캔한다. matched 는 정렬돼 있고 배치는 그 연속 슬라이스라
      // 배치 간 순서는 이미 보장된다.
      const collected = new Map<string, DecodedTx[]>();
      while (pending.size > 0) {
        const msg = await peer.next('block', 'notfound');
        if (msg.command === 'notfound') throw new Error('scan: peer has no block data (pruned?)');
        const block = decodeBlock(msg.payload);
        const hashHex = bytesToHex(block.header.hash);
        const entry = pending.get(hashHex);
        if (!entry) continue; // 요청 안 한 블록 — 무시
        // 헤더 자체는 cfheader 체인으로 신뢰를 얻지만 tx 목록은 아니다 — 머클루트로
        // 헤더에 못 박아야 피어가 입금 tx 를 빼거나 지어내는 조작이 여기서 걸린다.
        const merkleRoot = computeMerkleRoot(block.transactions.map((tx) => tx.txid));
        if (!bytesEqual(merkleRoot, block.header.merkleRoot)) {
          throw new Error(
            `scan: block merkle root mismatch at height ${entry.height} — peer lied`,
          );
        }
        pending.delete(hashHex);
        collected.set(hashHex, block.transactions);
      }
      for (const entry of batch) {
        const before = result.records.length;
        for (const tx of collected.get(bytesToHex(entry.hash))!) scanTx(tx, entry);
        // 필터가 맞았는데 레코드 0 — 오탐이거나 미시드 지출. 호출자 재검증용 신호.
        if (result.records.length === before) result.emptyMatchedBlockHeights.push(entry.height);
      }
    }

    result.ownedOutpoints = [...owned];
    return result;
  } finally {
    await transport.close().catch(() => undefined);
  }
}
