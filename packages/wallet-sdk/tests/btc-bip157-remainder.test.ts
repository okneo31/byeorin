// btc-bip157-remainder.test.ts — 잔여 결함 R1~R4 의 회귀 테스트.
//
// 기존 3파일(btc-bip157 / -errors / -reorg)은 손대지 않는다. 여기 있는 것은
// "설계가 정한 동작 계약"을 코드가 아니라 테스트로 못 박는 용도다.
//
//   R1 큐 오버플로로 닫힌 뒤 잔여 프레임을 계속 처리하지 않는다 (close 반복 X)
//   R2 우리가 직접 요청한 대용량 블록 배치는 정직한 피어라도 죽이지 않는다
//   R3 라운드당 소배치로만 답하는 정직한 피어도 팁까지 완주한다
//   R4 locator 창(8) 밖 깊이의 재조직도 정직한 피어와 회복한다
//   그리고 위 완화가 적대적 방어를 깎지 않았는지 대조한다.
//
// 모의 피어는 locator 를 **실제로 해석한다** — R4 는 그렇지 않으면 시험 자체가
// 성립하지 않는다. 헤더의 merkleRoot 는 서빙할 tx 목록에서 실제로 계산한다
// (D1 머클 검증 아래에서 "정직한 피어"로 남으려면 필수).

import { describe, expect, it } from 'vitest';
import type { ByteTransport, ByteTransportOptions } from '../src/btc-history/transport.js';
import type { ScanOptions } from '../src/btc-history/bip157/index.js';
import {
  ByteReader,
  ByteWriter,
  MAINNET_MAGIC,
  P2PFrameDecoder,
  SERVICE_NODE_COMPACT_FILTERS,
  SERVICE_NODE_NETWORK,
  SERVICE_NODE_WITNESS,
  ZERO_HASH,
  bip157Scan,
  buildVersionPayload,
  bytesToHex,
  computeFilterHash,
  computeFilterHeader,
  computeMerkleRoot,
  concatBytes,
  dsha256,
  encodeGcsFilter,
  encodeMessage,
  filterKeyFromBlockHash,
  hexToBytes,
  internalHashToDisplay,
} from '../src/btc-history/bip157/index.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const CP_HEIGHT = 100;
const CP_HASH = dsha256(utf8('byeorin-bip157-remainder-cp'));
const CP_FILTER_HEADER = dsha256(utf8('byeorin-bip157-remainder-cp-filter-header'));

const WATCH_SCRIPT = hexToBytes('0014' + 'c3'.repeat(20));

function uniqueScript(tag: number): Uint8Array {
  const s = new Uint8Array(22);
  s[0] = 0x00;
  s[1] = 0x14;
  s[2] = tag & 0xff;
  s[3] = (tag >> 8) & 0xff;
  s[4] = (tag >> 16) & 0xff;
  s[5] = (tag >>> 24) & 0xff;
  s[6] = 0x77;
  return s;
}

interface TxIn {
  prevTxid: Uint8Array;
  prevVout: number;
  scriptSig: Uint8Array;
}
interface TxOut {
  value: bigint;
  script: Uint8Array;
}

/** 비-segwit 직렬화 — decodeTx 의 재직렬화와 바이트가 같아 txid = dsha256(이것). */
function serializeTx(inputs: TxIn[], outputs: TxOut[]): Uint8Array {
  const w = new ByteWriter().writeU32LE(2).writeVarint(inputs.length);
  for (const i of inputs) {
    w.writeBytes(i.prevTxid).writeU32LE(i.prevVout).writeVarBytes(i.scriptSig).writeU32LE(0xffffffff);
  }
  w.writeVarint(outputs.length);
  for (const o of outputs) w.writeU64LE(o.value).writeVarBytes(o.script);
  return w.writeU32LE(0).toBytes();
}

const txidOf = (tx: Uint8Array): Uint8Array => dsha256(tx);

interface FakeBlock {
  height: number;
  hash: Uint8Array;
  prevHash: Uint8Array;
  raw: Uint8Array;
  txs: Uint8Array[];
  filterItems: Uint8Array[];
}

type Registry = Map<string, FakeBlock>;

interface BlockPlan {
  txs: Uint8Array[];
  filterItems: Uint8Array[];
}

function mine(opts: {
  registry: Registry;
  prevHash: Uint8Array;
  startHeight: number;
  count: number;
  branch: number;
  plan?: (height: number) => BlockPlan | null;
}): FakeBlock[] {
  const out: FakeBlock[] = [];
  let prev = opts.prevHash;
  for (let k = 0; k < opts.count; k++) {
    const height = opts.startHeight + k;
    const seed = opts.branch * 1_000_000 + height;
    const cbScript = uniqueScript(seed);
    const coinbase = serializeTx(
      [{ prevTxid: ZERO_HASH, prevVout: 0xffffffff, scriptSig: new Uint8Array([0x03, seed & 0xff]) }],
      [{ value: 625_000_000n, script: cbScript }],
    );
    const planned = opts.plan?.(height) ?? null;
    const txs = [coinbase, ...(planned?.txs ?? [])];
    const raw = new ByteWriter()
      .writeU32LE(0x20000000)
      .writeBytes(prev)
      .writeBytes(computeMerkleRoot(txs.map(txidOf)))
      .writeU32LE(1_700_000_000 + height * 600 + opts.branch)
      .writeU32LE(0x1d00ffff)
      .writeU32LE(seed)
      .toBytes();
    const hash = dsha256(raw);
    const block: FakeBlock = {
      height,
      hash,
      prevHash: prev,
      raw,
      txs,
      filterItems: [cbScript, ...(planned?.filterItems ?? [])],
    };
    opts.registry.set(bytesToHex(hash), block);
    out.push(block);
    prev = hash;
  }
  return out;
}

// ---------------------------------------------------------------------------
// locator 를 실제로 해석하는 모의 피어
// ---------------------------------------------------------------------------

interface LiveNodeConfig {
  registry: Registry;
  /** getheaders 횟수(1부터)를 받아 그 시점 피어의 최선 체인을 돌려준다. */
  bestChain: (round: number) => FakeBlock[];
  /** 한 라운드에 돌려줄 헤더 수 상한 (규격 상한 2000 이하 아무 값이나 허용된다). */
  headersPerRound: number;
  /** version 에 알릴 높이. */
  startHeight: number;
  /** locator 를 무시하고 항상 체인 앞에서부터 같은 응답을 반복한다 (적대적 재생). */
  ignoreLocator?: boolean;
  /** 이 횟수를 넘는 getheaders 가 오면 피어가 끊는다 — 테스트가 매달리지 않게. */
  maxGetheaders?: number;
}

class LiveMockPeer implements ByteTransport {
  getheadersCount = 0;
  closeCount = 0;
  forcedClose = false;
  readonly getheadersPayloads: Uint8Array[] = [];

  private dataCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: ((e?: Error) => void) | null = null;
  private readonly decoder = new P2PFrameDecoder(MAINNET_MAGIC);
  private outbox: Uint8Array[] = [];
  private pendingHangup = false;
  private closed = false;
  private readonly filterBytesMemo = new Map<string, Uint8Array>();
  private readonly filterHeaderMemo = new Map<string, Uint8Array>();

  constructor(private readonly cfg: LiveNodeConfig) {
    this.filterHeaderMemo.set(bytesToHex(CP_HASH), CP_FILTER_HEADER);
  }

  async connect(_h: string, _p: number, _o?: ByteTransportOptions): Promise<void> {}

  async send(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('mock peer: send after close');
    for (const m of this.decoder.push(bytes)) this.handle(m.command, m.payload);
    this.flush();
  }

  onData(cb: (b: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (e?: Error) => void): void {
    this.closeCb = cb;
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.closed = true;
  }

  private reply(command: string, payload: Uint8Array): void {
    this.outbox.push(encodeMessage(command, payload, MAINNET_MAGIC));
  }

  private flush(): void {
    if (this.outbox.length > 0) {
      const chunk = concatBytes(...this.outbox);
      this.outbox = [];
      this.dataCb?.(chunk);
    }
    if (this.pendingHangup) {
      this.pendingHangup = false;
      this.closed = true;
      this.forcedClose = true;
      this.closeCb?.(new Error('mock peer: hung up — client kept asking with no progress'));
    }
  }

  private handle(command: string, payload: Uint8Array): void {
    switch (command) {
      case 'version':
        this.reply(
          'version',
          buildVersionPayload({
            services: SERVICE_NODE_NETWORK | SERVICE_NODE_WITNESS | SERVICE_NODE_COMPACT_FILTERS,
            timestampSec: 1_700_000_000n,
            nonce: 0x3131313131313131n,
            userAgent: '/mock-live:1.0/',
            startHeight: this.cfg.startHeight,
            relay: false,
          }),
        );
        return;
      case 'verack':
        this.reply('verack', new Uint8Array(0));
        return;
      case 'getheaders':
        this.handleGetHeaders(payload);
        return;
      case 'getcfheaders':
        this.handleGetCfHeaders(payload);
        return;
      case 'getcfilters':
        this.handleGetCfilters(payload);
        return;
      case 'getdata':
        this.handleGetData(payload);
        return;
      default:
        return;
    }
  }

  private handleGetHeaders(payload: Uint8Array): void {
    this.getheadersCount++;
    this.getheadersPayloads.push(payload);
    if (this.cfg.maxGetheaders !== undefined && this.getheadersCount > this.cfg.maxGetheaders) {
      this.pendingHangup = true;
      return;
    }
    const chain = this.cfg.bestChain(this.getheadersCount);
    let from = 0; // locator 매치가 없으면 체인 앞에서부터 (= 체크포인트 다음)
    if (!this.cfg.ignoreLocator) {
      const r = new ByteReader(payload);
      r.readU32LE();
      const n = Number(r.readVarint());
      const pos = new Map<string, number>();
      for (let i = 0; i < chain.length; i++) pos.set(bytesToHex(chain[i]!.hash), i);
      // locator 는 tip → 과거 순서라 첫 매치가 곧 최고 높이 공통점이다.
      for (let i = 0; i < n; i++) {
        const h = bytesToHex(new Uint8Array(r.readBytes(32)));
        const idx = pos.get(h);
        if (idx !== undefined) {
          from = idx + 1;
          break;
        }
        if (h === bytesToHex(CP_HASH)) {
          from = 0;
          break;
        }
      }
    }
    const round = chain.slice(from, from + this.cfg.headersPerRound);
    const w = new ByteWriter().writeVarint(round.length);
    for (const b of round) w.writeBytes(b.raw).writeU8(0);
    this.reply('headers', w.toBytes());
  }

  private walkBack(stopHash: Uint8Array, startHeight: number): FakeBlock[] {
    const out: FakeBlock[] = [];
    let cur = this.cfg.registry.get(bytesToHex(stopHash));
    if (cur === undefined) throw new Error('mock peer: getcf* for unknown stop hash');
    while (cur !== undefined && cur.height >= startHeight) {
      out.push(cur);
      cur = this.cfg.registry.get(bytesToHex(cur.prevHash));
    }
    out.reverse();
    return out;
  }

  private filterBytesOf(b: FakeBlock): Uint8Array {
    const key = bytesToHex(b.hash);
    const memo = this.filterBytesMemo.get(key);
    if (memo !== undefined) return memo;
    const bytes = encodeGcsFilter(b.filterItems, filterKeyFromBlockHash(b.hash));
    this.filterBytesMemo.set(key, bytes);
    return bytes;
  }

  private filterHeaderOf(hash: Uint8Array): Uint8Array {
    const path: FakeBlock[] = [];
    let key = bytesToHex(hash);
    while (!this.filterHeaderMemo.has(key)) {
      const b = this.cfg.registry.get(key);
      if (b === undefined) throw new Error(`mock peer: no filter header path for ${key}`);
      path.push(b);
      key = bytesToHex(b.prevHash);
    }
    let acc = this.filterHeaderMemo.get(key)!;
    for (let i = path.length - 1; i >= 0; i--) {
      const b = path[i]!;
      acc = computeFilterHeader(computeFilterHash(this.filterBytesOf(b)), acc);
      this.filterHeaderMemo.set(bytesToHex(b.hash), acc);
    }
    return acc;
  }

  private handleGetCfHeaders(payload: Uint8Array): void {
    const r = new ByteReader(payload);
    const filterType = r.readU8();
    const startHeight = r.readU32LE();
    const stopHash = new Uint8Array(r.readBytes(32));
    const range = this.walkBack(stopHash, startHeight);
    const w = new ByteWriter()
      .writeU8(filterType)
      .writeBytes(stopHash)
      .writeBytes(this.filterHeaderOf(range[0]!.prevHash))
      .writeVarint(range.length);
    for (const b of range) w.writeBytes(computeFilterHash(this.filterBytesOf(b)));
    this.reply('cfheaders', w.toBytes());
  }

  private handleGetCfilters(payload: Uint8Array): void {
    const r = new ByteReader(payload);
    const filterType = r.readU8();
    const startHeight = r.readU32LE();
    const stopHash = new Uint8Array(r.readBytes(32));
    for (const b of this.walkBack(stopHash, startHeight)) {
      this.reply(
        'cfilter',
        new ByteWriter()
          .writeU8(filterType)
          .writeBytes(b.hash)
          .writeVarBytes(this.filterBytesOf(b))
          .toBytes(),
      );
    }
  }

  private handleGetData(payload: Uint8Array): void {
    const r = new ByteReader(payload);
    const count = Number(r.readVarint());
    for (let i = 0; i < count; i++) {
      r.readU32LE();
      const hash = new Uint8Array(r.readBytes(32));
      const b = this.cfg.registry.get(bytesToHex(hash));
      if (b === undefined) {
        this.reply('notfound', payload);
        continue;
      }
      const w = new ByteWriter().writeBytes(b.raw).writeVarint(b.txs.length);
      for (const tx of b.txs) w.writeBytes(tx);
      this.reply('block', w.toBytes());
    }
  }
}

function scanOpts(extra: Partial<ScanOptions> = {}): ScanOptions {
  return {
    host: 'mock.invalid',
    port: 8333,
    watchScripts: [WATCH_SCRIPT],
    checkpoint: { height: CP_HEIGHT, blockHash: CP_HASH, filterHeader: CP_FILTER_HEADER },
    messageTimeoutMs: 5_000,
    ...extra,
  };
}

// ===========================================================================
// R1 — 큐 오버플로로 닫힌 뒤에는 잔여 프레임을 처리하지 않는다
// ===========================================================================

/** 오버플로만 유도하는 최소 전송 — 핸드셰이크 뒤 화이트리스트 명령을 쏟아붓는다. */
class FloodTransport implements ByteTransport {
  closeCount = 0;
  private dataCb: ((b: Uint8Array) => void) | null = null;
  private readonly decoder = new P2PFrameDecoder(MAINNET_MAGIC);
  private closed = false;

  constructor(private readonly floodCount: number) {}

  async connect(): Promise<void> {}

  async send(bytes: Uint8Array): Promise<void> {
    if (this.closed) return;
    for (const m of this.decoder.push(bytes)) {
      if (m.command === 'version') {
        this.feedMsg(
          'version',
          buildVersionPayload({
            services: SERVICE_NODE_NETWORK | SERVICE_NODE_WITNESS | SERVICE_NODE_COMPACT_FILTERS,
            timestampSec: 1_700_000_000n,
            nonce: 1n,
            userAgent: '/flood:1/',
            startHeight: CP_HEIGHT,
            relay: false,
          }),
        );
        this.feedMsg('verack', new Uint8Array(0));
      } else if (m.command === 'getheaders') {
        // 요청한 적 없는 cfilter 를 계속 밀어 넣는다 — headers 는 영영 안 준다.
        const junk = new ByteWriter()
          .writeU8(0)
          .writeBytes(new Uint8Array(32).fill(0x5e))
          .writeVarBytes(new Uint8Array(64))
          .toBytes();
        for (let i = 0; i < this.floodCount; i++) this.feedMsg('cfilter', junk);
      }
    }
  }

  onData(cb: (b: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(): void {}

  async close(): Promise<void> {
    this.closeCount++;
    this.closed = true;
  }

  private feedMsg(command: string, payload: Uint8Array): void {
    this.dataCb?.(encodeMessage(command, payload, MAINNET_MAGIC));
  }
}

describe('R1 — 오버플로로 닫힌 뒤 잔여 프레임 처리', () => {
  it('오버플로 예외로 끝나되 close 호출은 상한 이하다 (수정 전 12,952/15,000)', async () => {
    const t = new FloodTransport(15_000);
    await expect(bip157Scan(t, scanOpts({ messageTimeoutMs: 500 }))).rejects.toThrow(
      /queue overflow/,
    );
    expect(t.closeCount).toBeGreaterThanOrEqual(1);
    expect(t.closeCount).toBeLessThanOrEqual(3);
  });
});

// ===========================================================================
// R2 — 우리가 직접 요청한 대용량 블록 배치는 정직한 피어라도 죽이지 않는다
// ===========================================================================

describe('R2 — 정직한 대용량 블록 배치', () => {
  const reg: Registry = new Map();
  const BIG = 2_200_000; // 블록당 약 2.2MB × 32 = 70.4MB > 현행 상한 64MiB
  const bigChain = mine({
    registry: reg,
    prevHash: CP_HASH,
    startHeight: 101,
    count: 32,
    branch: 11,
    plan: (h) => {
      const filler = serializeTx(
        [{ prevTxid: dsha256(utf8(`big-${h}`)), prevVout: 0, scriptSig: new Uint8Array([0x01, 0x51]) }],
        [
          { value: 10_000n, script: WATCH_SCRIPT },
          { value: 1n, script: new Uint8Array(BIG).fill(0x6a) },
        ],
      );
      return { txs: [filler], filterItems: [WATCH_SCRIPT] };
    },
  });

  it('blockBatchSize 32 로 4MB 급 블록이 몰려 와도 예외 없이 완주한다', async () => {
    const node = new LiveMockPeer({
      registry: reg,
      bestChain: () => bigChain,
      headersPerRound: 2000,
      startHeight: 132,
    });
    const res = await bip157Scan(node, scanOpts({ blockBatchSize: 32 }));

    expect(res.tipHeight).toBe(132);
    expect(res.scannedFilterCount).toBe(32);
    expect(res.matchedBlockCount).toBe(32);
    expect(res.records).toHaveLength(32);
    expect(res.records[0]!.receivedOutputs[0]!.value).toBe(10_000n);
    expect(res.emptyMatchedBlockHeights).toEqual([]);
  }, 60_000);
});

// ===========================================================================
// R3 — 라운드당 소배치로만 답하는 정직한 피어
// ===========================================================================

describe('R3 — 소배치로만 답하는 정직한 피어', () => {
  const reg: Registry = new Map();
  const chain = mine({
    registry: reg,
    prevHash: CP_HASH,
    startHeight: 101,
    count: 1000,
    branch: 12,
    plan: (h) =>
      h === 1099
        ? {
            txs: [
              serializeTx(
                [{ prevTxid: dsha256(utf8('r3-pay')), prevVout: 0, scriptSig: new Uint8Array([0x01, 0x51]) }],
                [{ value: 77_000n, script: WATCH_SCRIPT }],
              ),
            ],
            filterItems: [WATCH_SCRIPT],
          }
        : null,
  });

  it('라운드당 50개씩만 줘도 팁(1100)까지 완주한다', async () => {
    const node = new LiveMockPeer({
      registry: reg,
      bestChain: () => chain,
      headersPerRound: 50, // 1000/50 = 20라운드 — 옛 상한(라운드당 2000 가정)이면 죽는다
      startHeight: 1100,
      maxGetheaders: 60,
    });
    const res = await bip157Scan(node, scanOpts());

    expect(node.forcedClose).toBe(false);
    expect(res.tipHeight).toBe(1100);
    expect(node.getheadersCount).toBe(20);
    expect(res.scannedFilterCount).toBe(1000);
    expect(res.records.map((r) => r.height)).toEqual([1099]);
  }, 60_000);
});

// ===========================================================================
// R4 — locator 창(8) 밖 깊이의 재조직 회복
// ===========================================================================

describe('R4 — 깊이 50 재조직 회복 (정직한 피어)', () => {
  const reg: Registry = new Map();
  const branchA = mine({ registry: reg, prevHash: CP_HASH, startHeight: 101, count: 1000, branch: 13 });
  const B_TX = serializeTx(
    [{ prevTxid: dsha256(utf8('r4-pay')), prevVout: 0, scriptSig: new Uint8Array([0x01, 0x51]) }],
    [{ value: 123_000n, script: WATCH_SCRIPT }],
  );
  // 1050 에서 갈라진다 — 우리 tip(1100) 에서 깊이 50 > locator 창 8.
  const branchB = mine({
    registry: reg,
    prevHash: branchA[949]!.hash, // 높이 1050
    startHeight: 1051,
    count: 150,
    branch: 14,
    plan: (h) => (h === 1120 ? { txs: [B_TX], filterItems: [WATCH_SCRIPT] } : null),
  });
  const bChain = [...branchA.slice(0, 950), ...branchB];

  it('locator 를 넓혀 공통 조상을 찾아 새 분기로 완주한다', async () => {
    const node = new LiveMockPeer({
      registry: reg,
      // 3라운드부터 피어의 최선 체인이 B 로 바뀐다 (그 사이 재조직이 일어난 것).
      bestChain: (round) => (round >= 3 ? bChain : branchA),
      headersPerRound: 500,
      startHeight: 1200,
      maxGetheaders: 8,
    });
    const res = await bip157Scan(node, scanOpts());

    expect(node.forcedClose).toBe(false);
    expect(res.tipHeight).toBe(1200);
    expect(res.tipHash).toBe(internalHashToDisplay(branchB[149]!.hash));
    expect(node.getheadersCount).toBeLessThanOrEqual(6);
    expect(res.records.map((r) => r.height)).toEqual([1120]);
  }, 60_000);
});

// ===========================================================================
// 대조 — 적대적 방어가 유지되는가
// ===========================================================================

describe('대조 — 적대적 피어 방어 유지', () => {
  it('같은 헤더를 영원히 재생하는 피어는 유한 라운드에 예외로 끝난다', async () => {
    const reg: Registry = new Map();
    const chain = mine({ registry: reg, prevHash: CP_HASH, startHeight: 101, count: 500, branch: 15 });
    const node = new LiveMockPeer({
      registry: reg,
      bestChain: () => chain,
      headersPerRound: 500,
      startHeight: 5000, // 아직 멀었다고 주장해 루프 종료 조건을 피한다
      ignoreLocator: true, // locator 를 무시하고 같은 500개를 반복
      maxGetheaders: 6,
    });
    await expect(bip157Scan(node, scanOpts())).rejects.toThrow(/무진전/);
    expect(node.forcedClose).toBe(false);
    expect(node.getheadersCount).toBeLessThanOrEqual(3);
  }, 30_000);

  it('라운드당 1개씩만 흘리며 라운드를 태우는 피어도 유한 라운드에 끝난다', async () => {
    const reg: Registry = new Map();
    const chain = mine({ registry: reg, prevHash: CP_HASH, startHeight: 101, count: 60, branch: 16 });
    const node = new LiveMockPeer({
      registry: reg,
      bestChain: () => chain,
      headersPerRound: 1,
      startHeight: 1_000_000, // 상한을 크게 만들어 라운드를 끝없이 태우려 한다
      maxGetheaders: 40,
    });
    await expect(bip157Scan(node, scanOpts())).rejects.toThrow(/생산성|상한/);
    expect(node.forcedClose).toBe(false);
  }, 30_000);
});
