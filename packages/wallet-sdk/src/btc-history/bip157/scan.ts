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
  /** getdata 한 번에 요청할 블록 수. 기본 16, 1..64 로 클램프.
   *  최악 상주 메모리 = 이 값 × 4MB (기본 64MB). */
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

// 상한의 목적은 "아무도 기다리지 않는 메시지의 무제한 축적" 차단이다. 요청한
// 응답까지 같은 잣대로 세면, 우리가 직접 64블록을 요청해 놓고 그 응답에 죽는다.
// 그래서 예산은 방금 보낸 요청에서 계산한다 — 피어의 주장이 아니라.
const MAX_QUEUE_MESSAGES = 2048;
const MAX_QUEUE_BYTES_HARD = 268_800_000;
/** Core 의 MAX_PROTOCOL_MESSAGE_LENGTH — 정직한 피어의 1블록 상한. */
const MAX_BLOCK_SERIALIZED_BYTES = 4_000_000;

export interface QueueBudget {
  msgs: number;
  bytes: number;
}

/** 통수 하한 — 요청 밖 응답을 통수로 끊으면 "무시하고 타임아웃" 이라는 기존
 *  계약이 깨진다. 실제 메모리 경계는 bytes 가 잡으므로 통수는 백스톱으로만 둔다. */
const MIN_BUDGET_MESSAGES = 256;

function clampBudget(b: QueueBudget): QueueBudget {
  return {
    msgs: Math.min(Math.max(b.msgs, MIN_BUDGET_MESSAGES), MAX_QUEUE_MESSAGES),
    bytes: Math.min(b.bytes, MAX_QUEUE_BYTES_HARD),
  };
}

/** 요청 없는 상태의 예산 — 현행 단일 상한보다 좁다(적대적 축적을 더 빨리 끊는다). */
const IDLE_BUDGET: QueueBudget = { msgs: 256, bytes: 8 * 1024 * 1024 };
const HEADER_BUDGET: QueueBudget = { msgs: 64, bytes: 4 * 1024 * 1024 };

/** 계산식 자체를 테스트가 고정할 수 있도록 순수 함수로 뺀다. */
export function blockBatchBudget(batchSize: number): QueueBudget {
  return clampBudget({
    msgs: 2 * batchSize + 16,
    bytes: Math.ceil(batchSize * MAX_BLOCK_SERIALIZED_BYTES * 1.05),
  });
}

export function cfilterBudget(count: number): QueueBudget {
  return clampBudget({
    msgs: count + 64,
    bytes: Math.min(64 * 1024 * 1024, count * 512 * 1024),
  });
}

class Peer {
  private readonly decoder: P2PFrameDecoder;
  private queue: P2PMessage[] = [];
  private queueBytes = 0;
  private budget: QueueBudget = IDLE_BUDGET;
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
    // 닫힌 뒤 도착분은 소비자가 없다 — next() 가 이미 무조건 reject 하므로
    // 디코드·큐잉·재차단 모두 순수 낭비다. 진입부에서 끊는다.
    if (this.closedErr) return;
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
        this.queue.length >= this.budget.msgs ||
        this.queueBytes + msg.payload.length > this.budget.bytes
      ) {
        // 순차 프로토콜에서 이만한 백로그는 정상 경로에 없다 — 오래된 것을 조용히
        // 버리면 진짜 응답이 사라져 타임아웃까지 침묵하므로, 끊고 예외로 드러낸다.
        const err = new Error(
          `peer: message queue overflow — peer flooding (${this.queue.length} msgs / ${this.queueBytes} bytes exceeds budget ${this.budget.msgs}/${this.budget.bytes})`,
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

  private async send(command: string, payload: Uint8Array): Promise<void> {
    await this.transport.send(encodeMessage(command, payload, this.magic));
  }

  /** 예산 없이 나가는 요청이 있으면 유휴 예산에 정상 응답이 걸린다 — 호출부가
   *  예산을 빼먹지 못하게 send 대신 이 문만 노출한다. 리셋은 하지 않는다:
   *  늦게 도착한 중복 응답도 직전 요청의 예산으로 세야 정상 경로가 산다. */
  async request(command: string, payload: Uint8Array, budget: QueueBudget): Promise<void> {
    this.budget = clampBudget(budget);
    await this.send(command, payload);
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
  // 큐 상주 메모리 = batch × 4MB. 64 초과는 순차 소비라 이득 없이 상주만 늘린다.
  const blockBatchSize = Math.max(1, Math.min(64, opts.blockBatchSize ?? 16));

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
    await peer.request(
      'version',
      buildVersionPayload({ userAgent: opts.userAgent, relay: false }),
      IDLE_BUDGET,
    );
    const versionMsg = await peer.next('version');
    const remote = parseVersionPayload(versionMsg.payload);
    if (!hasCompactFilters(remote.services)) {
      throw new Error(
        `scan: peer lacks NODE_COMPACT_FILTERS (services=0x${remote.services.toString(16)})`,
      );
    }
    await peer.request('verack', new Uint8Array(0), IDLE_BUDGET);
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

    // 라운드 상한을 "라운드당 2000헤더" 가정에서 뗀다 — 규격은 피어가 더 작은
    // 배치로 답하는 것을 허용하고, 그런 피어도 진전 중이면 죽이면 안 된다.
    // 그래서 세는 단위는 라운드가 아니라 실제로 붙은 헤더 수다.
    const headerSpan = Math.max(remote.startHeight - opts.checkpoint.height, 1);
    // 4000 = 되감기 여유(mainnet 최대 실측 재조직 53블록의 75배), 144 = 동기 중 새로 채굴될 1일치
    const maxAppends = headerSpan + 4000 + 144;
    // 16 = 정직한 구현이 결코 밑돌지 않는 평균 배치 하한(규격 상한 2000의 1/125).
    // 이보다 잘게 끊는 피어는 진전을 핑계로 라운드만 태우는 것이다.
    const MIN_AVG_BATCH = 16;
    const maxRounds = Math.ceil(maxAppends / MIN_AVG_BATCH) + 12;
    let rounds = 0;
    let totalAppends = 0;
    let widenUsed = 0; // 무진전일 때만 쓰는 locator 넓힘 예산 (상한 2)
    let anchorLowHeight = opts.checkpoint.height; // 피어와 일치가 확인된 최고 높이

    const entryAt = (h: number): ChainEntry | undefined => {
      const idx = h - opts.checkpoint.height;
      return idx >= 0 && idx < chain.length ? chain[idx] : undefined;
    };
    // 평시 모양(끝 8 + 체크포인트)은 손대지 않는다 — 평시에 넓히면 정상 재조직
    // 경로의 요청 크기만 커진다. 넓힘은 무진전 라운드에서만 발동한다.
    const buildLocator = (): Uint8Array[] => {
      const out: Uint8Array[] = [];
      if (widenUsed === 0) {
        for (let i = chain.length - 1; i >= 0 && out.length < 8; i -= 1) out.push(chain[i]!.hash);
      } else {
        // 1회차는 확인된 하한(anchorLowHeight)~tip 구간만, 2회차는 체크포인트까지
        // 전부 — 2회차가 이미 최대 해상도라 3회차가 줄 새 정보는 0이다.
        const low = widenUsed === 1
          ? Math.max(anchorLowHeight, opts.checkpoint.height)
          : opts.checkpoint.height;
        let h = chain[chain.length - 1]!.height;
        let step = 1;
        let n = 0;
        while (h > low) {
          const e = entryAt(h);
          if (e) out.push(e.hash);
          n += 1;
          if (n > 10) step *= 2;
          h -= step;
        }
        const lowEntry = entryAt(low);
        if (lowEntry) out.push(lowEntry.hash);
      }
      if (!out.some((x) => bytesEqual(x, opts.checkpoint.blockHash))) {
        out.push(opts.checkpoint.blockHash);
      }
      return out;
    };

    for (;;) {
      rounds += 1;
      if (rounds > maxRounds) {
        throw new Error(
          `scan: 헤더 동기 라운드 상한 ${maxRounds} 초과 (peer height ${remote.startHeight})`,
        );
      }
      // 진전 대비 라운드 소모가 바닥을 밑돌면, 피어가 진전을 핑계로 라운드만
      // 태우는 것이다 — span 만큼 끌려다니지 않도록 여기서 끊는다.
      if (rounds > 8 && totalAppends < (rounds - 8 - widenUsed - 1) * MIN_AVG_BATCH) {
        throw new Error(`scan: 헤더 동기 생산성 미달 (${rounds}라운드에 ${totalAppends}헤더)`);
      }
      // locator: tip 쪽 몇 개 + 체크포인트 (재조직 시 공통 조상 탐색용)
      const locator = buildLocator();
      await peer.request('getheaders', encodeGetHeaders(locator), HEADER_BUDGET);
      const headersMsg = await peer.next('headers');
      const headers = decodeHeadersMessage(headersMsg.payload);
      if (headers.length === 0) break;
      const lenBefore = chain.length;
      const tipBefore = chain[chain.length - 1]!.hash;
      for (const h of headers) appendHeader(h);
      const grew = chain.length - lenBefore;
      const progressed = grew !== 0 || !bytesEqual(chain[chain.length - 1]!.hash, tipBefore);
      if (progressed) {
        totalAppends += Math.max(grew, 1);
        widenUsed = 0;
        anchorLowHeight = chain[chain.length - 1]!.height;
      } else {
        // 무진전 — 갈림길은 하나뿐이다: 이 응답에 우리가 모르는 갈림 구간이
        // 남아 있는가. 피어가 우리 tip 을 아는 지점부터 답했다면 locator 를
        // 넓혀도 새 정보가 0 이므로 재시도가 수학적으로 무의미하다.
        let topKnown = -1;
        for (const h of headers) {
          const idx = knownIndex.get(bytesToHex(h.hash));
          if (idx !== undefined) topKnown = Math.max(topKnown, chain[idx]!.height);
        }
        if (topKnown < 0 || topKnown >= chain[chain.length - 1]!.height) {
          throw new Error('scan: 무진전 — 헤더 응답에 체인 진전 없음, 동기 중단');
        }
        if (widenUsed >= 2) {
          throw new Error('scan: 무진전 — locator 를 최대로 넓혀도 공통 조상 없음, 동기 중단');
        }
        // locator 창 밖에서 갈라진 정직한 깊은 재조직 후보 — 넓혀 재시도한다.
        widenUsed += 1;
        anchorLowHeight = topKnown;
        continue;
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
      await peer.request(
        'getcfheaders',
        encodeGetCfHeaders(batch[0]!.height, stop.hash),
        HEADER_BUDGET,
      );
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
      await peer.request(
        'getcfilters',
        encodeGetCfilters(batch[0]!.height, stop.hash),
        cfilterBudget(batch.length),
      );
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
      await peer.request(
        'getdata',
        encodeGetData(batch.map((e) => ({ type: INV_BLOCK, hash: e.hash }))),
        blockBatchBudget(batch.length),
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
