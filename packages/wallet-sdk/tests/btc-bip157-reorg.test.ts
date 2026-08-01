// btc-bip157-reorg.test.ts — bip157Scan() 의 재조직(reorg) 롤백 경로 결정적 테스트.
//
// 대상: src/btc-history/bip157/scan.ts 의 appendHeader() 롤백 분기(279–302행)와
//       그것을 돌리는 헤더 추적 루프(304–321행).
//
// 방법: 네트워크 없음. ByteTransport 를 구현한 MockPeerTransport 가 실제 BIP157
//       피어처럼 응답한다 — version/verack, getheaders→headers(스크립트된 라운드),
//       getcfheaders→cfheaders, getcfilters→cfilter, getdata→block.
//       필터 헤더 체인은 모의 노드가 체크포인트부터 prev 링크를 따라 실제로 계산하므로
//       (computeFilterHash/computeFilterHeader) 스캔의 검증을 통과하는 "정직한 피어"다.
//       거짓말은 헤더 연결성 시나리오에서만 의도적으로 넣는다.
//
// 모든 응답은 send() 안에서 동기적으로 전달된다 — 타이머·경합 없음, 완전 결정적.
//
// 재조직을 스캔 도중에 일으키려면 헤더 라운드가 두 번 이상 돌아야 하고,
// scan.ts 320행이 `headers.length < 2000` 이면 루프를 끊으므로 1라운드는 정확히
// 2000개여야 한다. 그래서 아래 BRANCH_A 는 2000블록이다 (실제 피어 동작과 동일).

import { describe, expect, it } from 'vitest';
import type { ByteTransport, ByteTransportOptions } from '../src/btc-history/transport.js';
import type { ScanOptions, ScanResult } from '../src/btc-history/bip157/index.js';
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

// ---------------------------------------------------------------------------
// 가짜 체인 만들기 (PoW 없음 — scan.ts 는 연결성만 보므로 유효한 시험 대상)
// ---------------------------------------------------------------------------

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const CP_HEIGHT = 100;
const CP_HASH = dsha256(utf8('byeorin-bip157-reorg-checkpoint'));
const CP_FILTER_HEADER = dsha256(utf8('byeorin-bip157-reorg-cp-filter-header'));

/** 관심 scriptPubKey (P2WPKH 형태). */
const WATCH_SCRIPT = hexToBytes('0014' + 'a1'.repeat(20));
const OTHER_SCRIPT = hexToBytes('0014' + 'b2'.repeat(20));

/** 블록마다 다른 더미 스크립트 — 필터가 서로 달라지도록. */
function uniqueScript(tag: number): Uint8Array {
  const s = new Uint8Array(22);
  s[0] = 0x00;
  s[1] = 0x14;
  s[2] = tag & 0xff;
  s[3] = (tag >> 8) & 0xff;
  s[4] = (tag >> 16) & 0xff;
  s[5] = (tag >>> 24) & 0xff;
  s[6] = 0x5a;
  return s;
}

interface TxIn {
  prevTxid: Uint8Array;
  prevVout: number;
  scriptSig: Uint8Array;
  sequence?: number;
}
interface TxOut {
  value: bigint;
  script: Uint8Array;
}

/** 비-segwit 직렬화 — decodeTx 의 stripped 재직렬화와 바이트가 같아 txid = dsha256(이것). */
function serializeTx(inputs: TxIn[], outputs: TxOut[], version = 2, lockTime = 0): Uint8Array {
  const w = new ByteWriter().writeU32LE(version).writeVarint(inputs.length);
  for (const i of inputs) {
    w.writeBytes(i.prevTxid)
      .writeU32LE(i.prevVout)
      .writeVarBytes(i.scriptSig)
      .writeU32LE(i.sequence ?? 0xffffffff);
  }
  w.writeVarint(outputs.length);
  for (const o of outputs) w.writeU64LE(o.value).writeVarBytes(o.script);
  w.writeU32LE(lockTime);
  return w.toBytes();
}

const txidOf = (txBytes: Uint8Array): Uint8Array => dsha256(txBytes);
const txidDisplay = (txBytes: Uint8Array): string => internalHashToDisplay(txidOf(txBytes));

function buildHeaderRaw(
  prevHash: Uint8Array,
  seed: number,
  timestamp: number,
  merkleRoot: Uint8Array,
): Uint8Array {
  return new ByteWriter()
    .writeU32LE(0x20000000)
    .writeBytes(prevHash)
    .writeBytes(merkleRoot)
    .writeU32LE(timestamp)
    .writeU32LE(0x1d00ffff)
    .writeU32LE(seed)
    .toBytes();
}

interface FakeBlock {
  height: number;
  /** internal 순서. */
  hash: Uint8Array;
  prevHash: Uint8Array;
  /** 80바이트 헤더. */
  raw: Uint8Array;
  timestamp: number;
  /** 블록 바디 tx 직렬화 (0번은 코인베이스). */
  txs: Uint8Array[];
  /** 이 블록 basic filter 에 넣을 항목. */
  filterItems: Uint8Array[];
}

interface BlockPlan {
  txs: Uint8Array[];
  filterItems: Uint8Array[];
}

type Registry = Map<string, FakeBlock>;

function mine(opts: {
  registry: Registry;
  prevHash: Uint8Array;
  startHeight: number;
  count: number;
  /** 분기 식별자 — 같은 높이라도 해시가 갈리게 한다. */
  branch: number;
  plan?: (height: number) => BlockPlan | null;
}): FakeBlock[] {
  const out: FakeBlock[] = [];
  let prev = opts.prevHash;
  for (let k = 0; k < opts.count; k++) {
    const height = opts.startHeight + k;
    const seed = opts.branch * 1_000_000 + height;
    const timestamp = 1_700_000_000 + height * 600 + opts.branch;
    const planned = opts.plan?.(height) ?? null;
    const cbScript = uniqueScript(seed);
    const coinbase = serializeTx(
      [
        {
          prevTxid: ZERO_HASH,
          prevVout: 0xffffffff,
          scriptSig: new Uint8Array([0x03, seed & 0xff, (seed >> 8) & 0xff]),
        },
      ],
      [{ value: 625_000_000n, script: cbScript }],
    );
    // D1 검증이 들어온 뒤에도 이 모의 피어가 "정직한 피어"로 남으려면 헤더의
    // merkleRoot 가 실제 서빙할 tx 목록에서 계산돼야 한다 — 그래서 tx 를 먼저 만든다.
    const txs = [coinbase, ...(planned?.txs ?? [])];
    const raw = buildHeaderRaw(prev, seed, timestamp, computeMerkleRoot(txs.map(txidOf)));
    const hash = dsha256(raw);
    const block: FakeBlock = {
      height,
      hash,
      prevHash: prev,
      raw,
      timestamp,
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
// 모의 BIP157 피어 (ByteTransport 구현)
// ---------------------------------------------------------------------------

interface NodeConfig {
  registry: Registry;
  /** getheaders 요청 n번째에 돌려줄 헤더 목록. */
  rounds: FakeBlock[][];
  /** rounds 소진 뒤 마지막 라운드를 계속 되풀이할지 (재생 루프 재현용). */
  repeatLastRound?: boolean;
  /** 이 횟수를 넘는 getheaders 가 오면 피어가 연결을 끊는다 (테스트가 매달리지 않게). */
  maxGetheaders?: number;
}

class MockPeerTransport implements ByteTransport {
  readonly commandsReceived: string[] = [];
  readonly getheadersPayloads: Uint8Array[] = [];
  readonly cfilterServed = new Set<string>();
  readonly blocksServed = new Set<string>();
  getheadersCount = 0;
  closeCount = 0;
  /** 클라이언트가 멈추지 않아 피어 쪽에서 끊었으면 true. */
  forcedClose = false;
  connectArgs: { host: string; port: number; opts?: ByteTransportOptions } | null = null;

  private dataCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: ((e?: Error) => void) | null = null;
  private readonly decoder = new P2PFrameDecoder(MAINNET_MAGIC);
  private outbox: Uint8Array[] = [];
  private pendingHangup = false;
  private closed = false;
  private readonly filterBytesMemo = new Map<string, Uint8Array>();
  private readonly filterHeaderMemo = new Map<string, Uint8Array>();

  constructor(private readonly cfg: NodeConfig) {
    this.filterHeaderMemo.set(bytesToHex(CP_HASH), CP_FILTER_HEADER);
  }

  // --- ByteTransport ---------------------------------------------------------

  async connect(host: string, port: number, opts?: ByteTransportOptions): Promise<void> {
    this.connectArgs = { host, port, opts };
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('mock peer: send after close');
    for (const m of this.decoder.push(bytes)) {
      this.commandsReceived.push(m.command);
      this.handle(m.command, m.payload);
    }
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

  // --- 내부 -----------------------------------------------------------------

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
            services:
              SERVICE_NODE_NETWORK | SERVICE_NODE_WITNESS | SERVICE_NODE_COMPACT_FILTERS,
            timestampSec: 1_700_000_000n,
            nonce: 0x5151515151515151n,
            userAgent: '/mock-bip157:1.0/',
            startHeight: 0,
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
        return; // pong 등 무시
    }
  }

  private handleGetHeaders(payload: Uint8Array): void {
    this.getheadersCount++;
    this.getheadersPayloads.push(payload);
    if (this.cfg.maxGetheaders !== undefined && this.getheadersCount > this.cfg.maxGetheaders) {
      this.pendingHangup = true;
      return;
    }
    const idx = this.getheadersCount - 1;
    let round: FakeBlock[] = [];
    if (idx < this.cfg.rounds.length) {
      round = this.cfg.rounds[idx]!;
    } else if (this.cfg.repeatLastRound && this.cfg.rounds.length > 0) {
      round = this.cfg.rounds[this.cfg.rounds.length - 1]!;
    }
    const w = new ByteWriter().writeVarint(round.length);
    for (const b of round) w.writeBytes(b.raw).writeU8(0);
    this.reply('headers', w.toBytes());
  }

  /** stopHash 에서 prev 를 따라 startHeight 까지 되감아 오름차순 목록으로. */
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

  /** 체크포인트 필터 헤더에서 prev 링크를 따라 실제로 계산 (반복문 — 스택 안전). */
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
    const first = range[0]!;
    const w = new ByteWriter()
      .writeU8(filterType)
      .writeBytes(stopHash)
      .writeBytes(this.filterHeaderOf(first.prevHash))
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
      this.cfilterServed.add(bytesToHex(b.hash));
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
      r.readU32LE(); // inv type
      const hash = new Uint8Array(r.readBytes(32));
      const b = this.cfg.registry.get(bytesToHex(hash));
      if (b === undefined) {
        this.reply('notfound', payload);
        continue;
      }
      this.blocksServed.add(bytesToHex(hash));
      const w = new ByteWriter().writeBytes(b.raw).writeVarint(b.txs.length);
      for (const tx of b.txs) w.writeBytes(tx);
      this.reply('block', w.toBytes());
    }
  }
}

// ---------------------------------------------------------------------------
// 공통 헬퍼
// ---------------------------------------------------------------------------

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

/** getheaders 페이로드에서 locator 해시 목록만 뽑는다. */
function decodeLocator(payload: Uint8Array): Uint8Array[] {
  const r = new ByteReader(payload);
  r.readU32LE(); // protocol version
  const count = Number(r.readVarint());
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) out.push(new Uint8Array(r.readBytes(32)));
  return out;
}

const matchedHeights = (res: ScanResult): number[] => res.records.map((rec) => rec.height);

// ---------------------------------------------------------------------------
// 공유 체인 — A 분기 2000블록 (높이 101..2100). 재조직 라운드를 일으키려면
// 1라운드가 정확히 2000개여야 하므로(scan.ts:320) 여기서 한 번만 만들어 재사용.
// 우리 스크립트로 들어오는 지급은 2096 / 2099 / 2100 세 곳.
// ---------------------------------------------------------------------------

const REG: Registry = new Map();

function payment(seed: number, value: bigint): Uint8Array {
  return serializeTx(
    [
      {
        prevTxid: dsha256(new Uint8Array([seed & 0xff, (seed >> 8) & 0xff, 0xaa, 0xbb])),
        prevVout: 0,
        scriptSig: new Uint8Array([0x02, seed & 0xff]),
      },
    ],
    [
      { value, script: WATCH_SCRIPT },
      { value: 1_000n, script: uniqueScript(seed ^ 0x5555) },
    ],
  );
}

const A2096_TX = payment(2096, 96_000n);
const A2099_TX = payment(2099, 99_000n);
const A2100_TX = payment(2100, 100_000n);

const BRANCH_A = mine({
  registry: REG,
  prevHash: CP_HASH,
  startHeight: 101,
  count: 2000,
  branch: 1,
  plan: (h) => {
    if (h === 2096) return { txs: [A2096_TX], filterItems: [WATCH_SCRIPT] };
    if (h === 2099) return { txs: [A2099_TX], filterItems: [WATCH_SCRIPT] };
    if (h === 2100) return { txs: [A2100_TX], filterItems: [WATCH_SCRIPT] };
    return null;
  },
});
/** 높이 → BRANCH_A 원소. */
const a = (height: number): FakeBlock => BRANCH_A[height - 101]!;

// ---------------------------------------------------------------------------
// (a) 정상 연장 — 재조직 없음
// ---------------------------------------------------------------------------

describe('bip157Scan — (a) 정상 연장', () => {
  const reg: Registry = new Map();
  const SEED_TXID = dsha256(utf8('byeorin-seed-utxo'));
  const seedOutpoint = `${internalHashToDisplay(SEED_TXID)}:0`;

  const receiveTx = payment(103, 250_000n);
  const spendTx = serializeTx(
    [{ prevTxid: SEED_TXID, prevVout: 0, scriptSig: new Uint8Array([0x01, 0x02]) }],
    [{ value: 90_000n, script: OTHER_SCRIPT }],
  );

  const chain = mine({
    registry: reg,
    prevHash: CP_HASH,
    startHeight: 101,
    count: 5,
    branch: 7,
    plan: (h) => {
      if (h === 103) return { txs: [receiveTx], filterItems: [WATCH_SCRIPT] };
      // BIP158 basic filter 는 "소비된 이전 출력 스크립트"도 포함한다 → 지출도 필터에 걸린다.
      if (h === 105) return { txs: [spendTx], filterItems: [OTHER_SCRIPT, WATCH_SCRIPT] };
      return null;
    },
  });

  it('한 라운드로 tip 까지 따라가고 수신·지출을 모두 잡는다', async () => {
    const node = new MockPeerTransport({ registry: reg, rounds: [chain] });
    const res = await bip157Scan(node, scanOpts({ knownOutpoints: [seedOutpoint] }));

    expect(node.connectArgs).toEqual({
      host: 'mock.invalid',
      port: 8333,
      opts: { tls: undefined, timeoutMs: 8000 },
    });
    expect(node.getheadersCount).toBe(1); // 5 < 2000 → 한 번에 끝
    expect(res.tipHeight).toBe(105);
    expect(res.tipHash).toBe(internalHashToDisplay(chain[4]!.hash));
    expect(res.scannedFilterCount).toBe(5);
    expect(res.matchedBlockCount).toBe(2);
    expect(matchedHeights(res)).toEqual([103, 105]);

    const received = res.records[0]!;
    expect(received.txid).toBe(txidDisplay(receiveTx));
    expect(received.blockHash).toBe(internalHashToDisplay(chain[2]!.hash));
    expect(received.timestamp).toBe(chain[2]!.timestamp);
    expect(received.receivedOutputs).toEqual([
      { vout: 0, value: 250_000n, scriptPubKeyHex: bytesToHex(WATCH_SCRIPT) },
    ]);
    expect(received.spentOutpoints).toEqual([]);

    const spent = res.records[1]!;
    expect(spent.txid).toBe(txidDisplay(spendTx));
    expect(spent.receivedOutputs).toEqual([]);
    expect(spent.spentOutpoints).toEqual([
      { txid: internalHashToDisplay(SEED_TXID), vout: 0 },
    ]);

    // 씨앗 outpoint 는 소비되어 빠지고, 103에서 받은 것이 남는다.
    expect(res.ownedOutpoints).toEqual([`${txidDisplay(receiveTx)}:0`]);
    expect(node.closeCount).toBeGreaterThanOrEqual(1);
  });

  it('아무 헤더도 없으면 체크포인트가 그대로 tip 이고 필터를 한 개도 안 받는다', async () => {
    const node = new MockPeerTransport({ registry: reg, rounds: [[]] });
    const res = await bip157Scan(node, scanOpts());
    expect(res.tipHeight).toBe(CP_HEIGHT);
    expect(res.tipHash).toBe(internalHashToDisplay(CP_HASH));
    expect(res.scannedFilterCount).toBe(0);
    expect(res.records).toEqual([]);
    expect(node.cfilterServed.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) 1블록 재조직
// ---------------------------------------------------------------------------

describe('bip157Scan — (b) 1블록 재조직', () => {
  // A2099 에서 갈라져 B2100', B2101' 로 이어진다 → A2100 만 되감긴다.
  const B_TX = payment(210_100, 222_222n);
  const branchB = mine({
    registry: REG,
    prevHash: a(2099).hash,
    startHeight: 2100,
    count: 2,
    branch: 2,
    plan: (h) => (h === 2101 ? { txs: [B_TX], filterItems: [WATCH_SCRIPT] } : null),
  });

  it('되감은 블록 하나만 버리고 새 분기로 이어 붙인다', async () => {
    const node = new MockPeerTransport({ registry: REG, rounds: [BRANCH_A, branchB] });
    const res = await bip157Scan(node, scanOpts());

    expect(node.getheadersCount).toBe(2);
    expect(res.tipHeight).toBe(2101);
    expect(res.tipHash).toBe(internalHashToDisplay(branchB[1]!.hash));
    // 체크포인트 다음 101..2101 = 2001 블록만 필터를 받는다 (되감긴 A2100 은 빠짐).
    expect(res.scannedFilterCount).toBe(2001);

    // 살아남은 A2096·A2099 는 그대로, 되감긴 A2100 은 사라지고, 새 B2101 이 들어온다.
    expect(matchedHeights(res)).toEqual([2096, 2099, 2101]);
    expect(res.records.map((r) => r.txid)).toEqual([
      txidDisplay(A2096_TX),
      txidDisplay(A2099_TX),
      txidDisplay(B_TX),
    ]);
    expect(res.matchedBlockCount).toBe(3);

    // 되감긴 블록은 필터도, 블록 본문도 요청되지 않는다.
    expect(node.cfilterServed.has(bytesToHex(a(2100).hash))).toBe(false);
    expect(node.blocksServed.has(bytesToHex(a(2100).hash))).toBe(false);
    expect(node.cfilterServed.has(bytesToHex(branchB[0]!.hash))).toBe(true);
  });

  it('2라운드 locator 는 tip 쪽 8개 + 체크포인트 = 9개다 (scan.ts:306–312)', async () => {
    const node = new MockPeerTransport({ registry: REG, rounds: [BRANCH_A, branchB] });
    await bip157Scan(node, scanOpts());

    const first = decodeLocator(node.getheadersPayloads[0]!);
    expect(first.map(bytesToHex)).toEqual([bytesToHex(CP_HASH)]);

    const second = decodeLocator(node.getheadersPayloads[1]!);
    expect(second).toHaveLength(9);
    expect(bytesToHex(second[0]!)).toBe(bytesToHex(a(2100).hash));
    expect(bytesToHex(second[7]!)).toBe(bytesToHex(a(2093).hash));
    expect(bytesToHex(second[8]!)).toBe(bytesToHex(CP_HASH));
    // 갈림점 A2099 가 locator 안에 있어야 정직한 피어가 새 분기를 보낼 수 있다.
    expect(second.some((h) => bytesToHex(h) === bytesToHex(a(2099).hash))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) 6블록 재조직
// ---------------------------------------------------------------------------

describe('bip157Scan — (c) 6블록 재조직', () => {
  // A2094 에서 갈라져 2095..2101 (7블록). A2095..A2100 여섯 개가 되감긴다.
  const C_TX = payment(209_700, 333_333n);
  const branchC = mine({
    registry: REG,
    prevHash: a(2094).hash,
    startHeight: 2095,
    count: 7,
    branch: 3,
    plan: (h) => (h === 2097 ? { txs: [C_TX], filterItems: [WATCH_SCRIPT] } : null),
  });

  it('여섯 블록을 되감고 새 분기 일곱 블록으로 갈아탄다', async () => {
    const node = new MockPeerTransport({ registry: REG, rounds: [BRANCH_A, branchC] });
    const res = await bip157Scan(node, scanOpts());

    expect(node.getheadersCount).toBe(2);
    expect(res.tipHeight).toBe(2101);
    expect(res.tipHash).toBe(internalHashToDisplay(branchC[6]!.hash));
    expect(res.scannedFilterCount).toBe(2001);

    // 되감긴 A2096·A2099·A2100 의 지급은 전부 사라지고 새 분기의 2097 만 남는다.
    expect(matchedHeights(res)).toEqual([2097]);
    expect(res.records[0]!.txid).toBe(txidDisplay(C_TX));
    expect(res.records[0]!.blockHash).toBe(internalHashToDisplay(branchC[2]!.hash));
    expect(res.records[0]!.receivedOutputs).toEqual([
      { vout: 0, value: 333_333n, scriptPubKeyHex: bytesToHex(WATCH_SCRIPT) },
    ]);
    expect(res.ownedOutpoints).toEqual([`${txidDisplay(C_TX)}:0`]);

    // 되감긴 여섯 블록은 어느 것도 필터 요청 대상이 아니다.
    for (let h = 2095; h <= 2100; h++) {
      expect(node.cfilterServed.has(bytesToHex(a(h).hash)), `A${h}`).toBe(false);
    }
    // 갈림점 아래(A2094)는 그대로 살아 있다.
    expect(node.cfilterServed.has(bytesToHex(a(2094).hash))).toBe(true);
  });

  it('갈림점 A2094 가 locator 8개 창 안에 들어 있다 (깊이 6 ≤ 8)', async () => {
    const node = new MockPeerTransport({ registry: REG, rounds: [BRANCH_A, branchC] });
    await bip157Scan(node, scanOpts());
    const second = decodeLocator(node.getheadersPayloads[1]!);
    expect(second.some((h) => bytesToHex(h) === bytesToHex(a(2094).hash))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (d) 체크포인트보다 깊은 재조직 — scan.ts 는 "미지원"으로 예외를 던진다
// ---------------------------------------------------------------------------

describe('bip157Scan — (d) 체크포인트 아래로 파고드는 재조직', () => {
  // 체크포인트(100)보다 낮은 높이 98 의 미지 블록에서 갈라진 분기.
  const GHOST_98 = dsha256(utf8('byeorin-pre-checkpoint-98'));
  const branchD = mine({
    registry: REG,
    prevHash: GHOST_98,
    startHeight: 99,
    count: 4,
    branch: 4,
  });

  it('예외를 던지고 전송을 닫는다 — 필터는 한 개도 받지 않는다', async () => {
    const node = new MockPeerTransport({ registry: REG, rounds: [BRANCH_A, branchD] });
    await expect(bip157Scan(node, scanOpts())).rejects.toThrow(
      /header does not connect — reorg deeper than checkpoint \(unsupported\)/,
    );
    expect(node.getheadersCount).toBe(2);
    expect(node.cfilterServed.size).toBe(0);
    expect(node.blocksServed.size).toBe(0);
    expect(node.closeCount).toBeGreaterThanOrEqual(1); // finally 에서 반드시 닫힘
  });

  it('갈림점이 정확히 체크포인트면 정상 처리된다 (경계값)', async () => {
    const branchCp = mine({
      registry: REG,
      prevHash: CP_HASH,
      startHeight: 101,
      count: 3,
      branch: 5,
    });
    const node = new MockPeerTransport({ registry: REG, rounds: [BRANCH_A, branchCp] });
    const res = await bip157Scan(node, scanOpts());
    // 2000블록 전부 되감기고 체크포인트 바로 위 3블록만 남는다.
    expect(res.tipHeight).toBe(103);
    expect(res.tipHash).toBe(internalHashToDisplay(branchCp[2]!.hash));
    expect(res.scannedFilterCount).toBe(3);
    expect(res.records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (e) 헤더가 아예 연결되지 않는 악성 피어
// ---------------------------------------------------------------------------

describe('bip157Scan — (e) 연결되지 않는 헤더를 주는 악성 피어', () => {
  const reg: Registry = new Map();
  const NOWHERE = dsha256(utf8('byeorin-unrelated-chain-root'));

  it('첫 응답부터 체크포인트에 안 붙으면 즉시 예외', async () => {
    const junk = mine({
      registry: reg,
      prevHash: NOWHERE,
      startHeight: 101,
      count: 3,
      branch: 6,
    });
    const node = new MockPeerTransport({ registry: reg, rounds: [junk] });
    await expect(bip157Scan(node, scanOpts())).rejects.toThrow(/header does not connect/);
    expect(node.cfilterServed.size).toBe(0);
    expect(node.closeCount).toBeGreaterThanOrEqual(1);
  });

  it('앞 몇 개만 붙고 중간부터 끊기면 그 지점에서 예외 — 부분 결과를 반환하지 않는다', async () => {
    const good = mine({
      registry: reg,
      prevHash: CP_HASH,
      startHeight: 101,
      count: 2,
      branch: 6,
    });
    const orphan = mine({
      registry: reg,
      prevHash: NOWHERE,
      startHeight: 103,
      count: 1,
      branch: 6,
    });
    const node = new MockPeerTransport({
      registry: reg,
      rounds: [[...good, ...orphan]],
    });
    await expect(bip157Scan(node, scanOpts())).rejects.toThrow(/header does not connect/);
    expect(node.cfilterServed.size).toBe(0);
  });

  it('필터 헤더 체인이 체크포인트에 안 이어지면 거부한다', async () => {
    const chain = mine({
      registry: reg,
      prevHash: CP_HASH,
      startHeight: 101,
      count: 3,
      branch: 8,
    });
    // 체크포인트 필터 헤더를 엉뚱한 값으로 주면 모의 노드의 정직한 cfheaders 와 어긋난다.
    const node = new MockPeerTransport({ registry: reg, rounds: [chain] });
    await expect(
      bip157Scan(
        node,
        scanOpts({
          checkpoint: {
            height: CP_HEIGHT,
            blockHash: CP_HASH,
            filterHeader: dsha256(utf8('wrong-filter-header')),
          },
        }),
      ),
    ).rejects.toThrow(/filter header chain does not connect to checkpoint/);
  });
});

// ---------------------------------------------------------------------------
// (f) 누적 작업량을 잃는 재조직 — scan.ts 가 "연결성만 본다"고 밝힌 한계 (15–17행)
// ---------------------------------------------------------------------------

describe('bip157Scan — (f) 더 짧은 분기로의 재조직 (문서화된 한계)', () => {
  // A2090 에서 갈라져 단 한 블록만 있는 분기 → tip 이 2100 에서 2091 로 떨어진다.
  const branchF = mine({
    registry: REG,
    prevHash: a(2090).hash,
    startHeight: 2091,
    count: 1,
    branch: 9,
  });

  it('작업량 비교 없이 더 짧은 체인을 그대로 받아들여 tip 이 낮아진다', async () => {
    const node = new MockPeerTransport({ registry: REG, rounds: [BRANCH_A, branchF] });
    const res = await bip157Scan(node, scanOpts());

    // 현재 구현의 실제 동작 — PoW/누적난이도 검증이 없으므로 그대로 통과한다.
    expect(res.tipHeight).toBe(2091);
    expect(res.tipHash).toBe(internalHashToDisplay(branchF[0]!.hash));
    expect(res.scannedFilterCount).toBe(1991); // 101..2091
    // 2096·2099·2100 의 지급이 전부 사라졌는데도 오류가 아니다.
    expect(res.records).toEqual([]);
    expect(res.matchedBlockCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (g) 진전 없는 헤더 라운드 — 종료 보장이 없다
// ---------------------------------------------------------------------------

describe('bip157Scan — (g) 갈림점이 locator 밖일 때의 종료성', () => {
  // 정직한 피어 시나리오:
  //   1라운드 101..2100, 2라운드 2101..4100 을 받아 tip = 4100.
  //   그 사이 피어가 4050 에서 재조직(깊이 50 > locator 창 8) →
  //   locator [A4100..A4093, 체크포인트] 중 피어의 최선 체인에 있는 것은 체크포인트뿐 →
  //   피어는 체크포인트 다음 2000개(=BRANCH_A, 양쪽 분기에 공통)를 보낸다.
  //   전부 이미 아는 헤더라 chain 은 한 칸도 자라지 않는데 headers.length === 2000 이라
  //   scan.ts:320 의 종료 조건에 걸리지 않는다 → 같은 요청·같은 응답이 무한 반복.
  //
  // 기대값: 진전이 없으면 스캔은 끝나야 한다 (지수 back-off locator 든, 무진전 감지든).
  //         모의 피어가 먼저 끊어야만 끝나는 건 실패다.
  const branchA2 = mine({
    registry: REG,
    prevHash: a(2100).hash,
    startHeight: 2101,
    count: 2000,
    branch: 1,
  });

  it('진전 없는 응답이 반복되면 스캔이 스스로 멈춘다', async () => {
    const node = new MockPeerTransport({
      registry: REG,
      rounds: [BRANCH_A, branchA2, BRANCH_A],
      repeatLastRound: true,
      maxGetheaders: 6,
    });
    await bip157Scan(node, scanOpts()).then(
      () => undefined,
      () => undefined,
    );
    expect(
      node.forcedClose,
      `스캔이 스스로 멈추지 않아 모의 피어가 ${node.getheadersCount}번째 getheaders 에서 연결을 끊었다 — scan.ts:304–321 에 무진전 종료 조건이 없다`,
    ).toBe(false);
  });
});
