// btc-bip157-errors.test.ts — 적대적 피어·장애 상황에서 BIP157 스캐너가
// "조용히 틀리지 않고 시끄럽게 실패하는가"를 검증한다. 네트워크 없음 — 모의 ByteTransport.
//
// 각 테스트는 **기대 동작을 먼저 적고** 실제와 비교한다.
// 핵심 판정 기준 세 가지:
//   1) 무한 대기가 없는가 (모든 실패 경로가 유한 시간에 reject 되는가)
//   2) 무한 루프가 없는가 (피어가 진행 없는 응답을 반복해도 스캐너가 멈추는가)
//   3) 메모리 폭주가 없는가 (피어가 크기·개수를 제어해 힙을 밀어올릴 수 있는가)
//
// [VULN] 로 시작하는 테스트는 **의도적으로 실패한다.**
// 구현이 위험하게 동작하므로 테스트를 구현에 맞추지 않고, 올바른 기대값을 그대로 둔 것이다.
// 실패 = 미수정 취약점 1건. 통과하도록 고치는 것은 구현 쪽의 몫이다.

import { describe, expect, it } from 'vitest';
import type { ByteTransport, ByteTransportOptions } from '../src/btc-history/transport.js';
import type { ScanOptions } from '../src/btc-history/bip157/index.js';
import {
  ByteWriter,
  MAINNET_MAGIC,
  P2PFrameDecoder,
  SERVICE_NODE_COMPACT_FILTERS,
  SERVICE_NODE_NETWORK,
  SERVICE_NODE_WITNESS,
  TESTNET_MAGIC,
  bip157Scan,
  buildVersionPayload,
  bytesToHex,
  computeFilterHash,
  decodeCfHeaders,
  decodeCfilter,
  decodeHeadersMessage,
  dsha256,
  encodeGcsFilter,
  encodeMessage,
  filterKeyFromBlockHash,
  type P2PMessage,
} from '../src/btc-history/bip157/index.js';

// ---------------------------------------------------------------------------
// 모의 전송 — 바이트를 직접 밀어 넣고, 우리가 보낸 프레임을 관찰한다.
// ---------------------------------------------------------------------------

class MockTransport implements ByteTransport {
  /** 우리(SDK)가 피어에게 보낸 메시지 — 디코드된 상태. */
  readonly sent: P2PMessage[] = [];
  connected = false;
  closeCount = 0;
  /** 우리가 보낸 메시지에 대한 피어의 반응. */
  react: (msg: P2PMessage, t: MockTransport) => void = () => undefined;

  private dataCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: ((e?: Error) => void) | null = null;
  private readonly decoder = new P2PFrameDecoder(MAINNET_MAGIC);

  async connect(_host: string, _port: number, _opts?: ByteTransportOptions): Promise<void> {
    this.connected = true;
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error('mock: send on closed transport');
    for (const msg of this.decoder.push(bytes)) {
      this.sent.push(msg);
      this.react(msg, this);
    }
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.connected = false;
  }

  // --- 피어 쪽 조작 --------------------------------------------------------
  /** 원시 바이트를 스트림에 밀어 넣는다 (프레이밍 무시 — 조각·쓰레기 주입용). */
  feed(bytes: Uint8Array): void {
    this.dataCb?.(bytes);
  }

  feedMsg(command: string, payload: Uint8Array, magic: Uint8Array = MAINNET_MAGIC): void {
    this.feed(encodeMessage(command, payload, magic));
  }

  /** 연결 끊김 통보. */
  drop(err?: Error): void {
    this.closeCb?.(err);
  }

  commands(): string[] {
    return this.sent.map((m) => m.command);
  }
}

// ---------------------------------------------------------------------------
// 결정적 가짜 체인 (PoW 무효 — 스캐너가 PoW 를 보지 않는다는 사실 자체가 검증 대상)
// ---------------------------------------------------------------------------

const CHECKPOINT_HEIGHT = 100;
const CHECKPOINT_HASH = new Uint8Array(32).fill(0xa7);
const CHECKPOINT_FILTER_HEADER = new Uint8Array(32).fill(0xb3);

/** 우리가 감시하는 스크립트 (P2PKH 25바이트). */
const WATCH_SCRIPT = new Uint8Array([
  0x76, 0xa9, 0x14, ...new Uint8Array(20).fill(0x11), 0x88, 0xac,
]);
/** 남의 스크립트 — 필터에 우리 것이 없을 때 채우는 용도. */
const FOREIGN_SCRIPT = new Uint8Array([
  0x76, 0xa9, 0x14, ...new Uint8Array(20).fill(0x22), 0x88, 0xac,
]);

interface FakeHeader {
  raw: Uint8Array;
  hash: Uint8Array;
}

function buildHeader(prev: Uint8Array, nonce: number): FakeHeader {
  const raw = new ByteWriter()
    .writeU32LE(1)
    .writeBytes(prev)
    .writeBytes(new Uint8Array(32).fill(nonce & 0xff))
    .writeU32LE(1_700_000_000 + nonce)
    .writeU32LE(0x1d00ffff)
    .writeU32LE(nonce)
    .toBytes();
  return { raw, hash: dsha256(raw) };
}

function buildChain(n: number, from: Uint8Array = CHECKPOINT_HASH): FakeHeader[] {
  const out: FakeHeader[] = [];
  let prev = from;
  for (let i = 1; i <= n; i++) {
    const h = buildHeader(prev, i);
    out.push(h);
    prev = h.hash;
  }
  return out;
}

function headersPayload(hs: FakeHeader[]): Uint8Array {
  const w = new ByteWriter().writeVarint(hs.length);
  for (const h of hs) w.writeBytes(h.raw).writeU8(0);
  return w.toBytes();
}

function emptyHeaders(): Uint8Array {
  return new ByteWriter().writeVarint(0).toBytes();
}

function cfHeadersPayload(
  stopHash: Uint8Array,
  prevFilterHeader: Uint8Array,
  hashes: Uint8Array[],
): Uint8Array {
  const w = new ByteWriter()
    .writeU8(0)
    .writeBytes(stopHash)
    .writeBytes(prevFilterHeader)
    .writeVarint(hashes.length);
  for (const h of hashes) w.writeBytes(h);
  return w.toBytes();
}

function cfilterPayload(blockHash: Uint8Array, filterBytes: Uint8Array): Uint8Array {
  return new ByteWriter().writeU8(0).writeBytes(blockHash).writeVarBytes(filterBytes).toBytes();
}

/** 코인베이스 tx 하나 — 출력 스크립트를 지정할 수 있다. */
function coinbaseTx(scriptPubKey: Uint8Array, value: bigint): Uint8Array {
  return new ByteWriter()
    .writeU32LE(1)
    .writeVarint(1)
    .writeBytes(new Uint8Array(32))
    .writeU32LE(0xffffffff)
    .writeVarBytes(new Uint8Array([0x51]))
    .writeU32LE(0xffffffff)
    .writeVarint(1)
    .writeU64LE(value)
    .writeVarBytes(scriptPubKey)
    .writeU32LE(0)
    .toBytes();
}

function blockPayload(header: FakeHeader, txs: Uint8Array[]): Uint8Array {
  const w = new ByteWriter().writeBytes(header.raw).writeVarint(txs.length);
  for (const t of txs) w.writeBytes(t);
  return w.toBytes();
}

function peerVersion(services: bigint): Uint8Array {
  return buildVersionPayload({
    services,
    timestampSec: 1_753_900_000n,
    nonce: 42n,
    userAgent: '/mock-peer:1/',
    startHeight: CHECKPOINT_HEIGHT,
    relay: false,
  });
}

const GOOD_SERVICES = SERVICE_NODE_NETWORK | SERVICE_NODE_WITNESS | SERVICE_NODE_COMPACT_FILTERS;

interface Scenario {
  chain: FakeHeader[];
  filters: Uint8Array[];
  filterHashes: Uint8Array[];
  /** 감시 스크립트를 포함하는 블록 인덱스. */
  matchIdx: number[];
}

function makeScenario(blocks: number, matchIdx: number[] = []): Scenario {
  const chain = buildChain(blocks);
  const filters = chain.map((h, i) =>
    encodeGcsFilter(
      matchIdx.includes(i) ? [WATCH_SCRIPT, FOREIGN_SCRIPT] : [FOREIGN_SCRIPT],
      filterKeyFromBlockHash(h.hash),
    ),
  );
  return { chain, filters, filterHashes: filters.map(computeFilterHash), matchIdx };
}

/** 규격을 지키는 피어. stage 별 훅으로 한 지점만 오염시킨다. */
interface PeerHooks {
  services?: bigint;
  onVersion?: (t: MockTransport) => boolean; // true = 처리 완료(기본 동작 생략)
  onGetHeaders?: (t: MockTransport, n: number) => boolean;
  onGetCfHeaders?: (t: MockTransport) => boolean;
  onGetCfilters?: (t: MockTransport) => boolean;
  onGetData?: (t: MockTransport, hashes: Uint8Array[]) => boolean;
}

function installPeer(t: MockTransport, s: Scenario, hooks: PeerHooks = {}): void {
  let getHeadersCount = 0;
  t.react = (msg, tr) => {
    switch (msg.command) {
      case 'version': {
        if (hooks.onVersion?.(tr)) return;
        tr.feedMsg('version', peerVersion(hooks.services ?? GOOD_SERVICES));
        tr.feedMsg('verack', new Uint8Array(0));
        return;
      }
      case 'getheaders': {
        getHeadersCount++;
        if (hooks.onGetHeaders?.(tr, getHeadersCount)) return;
        tr.feedMsg('headers', getHeadersCount === 1 ? headersPayload(s.chain) : emptyHeaders());
        return;
      }
      case 'getcfheaders': {
        if (hooks.onGetCfHeaders?.(tr)) return;
        tr.feedMsg(
          'cfheaders',
          cfHeadersPayload(s.chain[s.chain.length - 1]!.hash, CHECKPOINT_FILTER_HEADER, s.filterHashes),
        );
        return;
      }
      case 'getcfilters': {
        if (hooks.onGetCfilters?.(tr)) return;
        for (let i = 0; i < s.chain.length; i++) {
          tr.feedMsg('cfilter', cfilterPayload(s.chain[i]!.hash, s.filters[i]!));
        }
        return;
      }
      case 'getdata': {
        const hashes: Uint8Array[] = [];
        const count = msg.payload[0]!; // 요청 수가 253 미만이라 varint 1바이트
        for (let i = 0; i < count; i++) {
          hashes.push(msg.payload.subarray(1 + i * 36 + 4, 1 + i * 36 + 36));
        }
        if (hooks.onGetData?.(tr, hashes)) return;
        for (const h of hashes) {
          const idx = s.chain.findIndex((c) => bytesToHex(c.hash) === bytesToHex(h));
          if (idx < 0) continue;
          tr.feedMsg(
            'block',
            blockPayload(s.chain[idx]!, [coinbaseTx(WATCH_SCRIPT, 5_000_000_000n)]),
          );
        }
        return;
      }
      default:
        return;
    }
  };
}

function baseOpts(over: Partial<ScanOptions> = {}): ScanOptions {
  return {
    host: 'mock.invalid',
    port: 8333,
    watchScripts: [WATCH_SCRIPT],
    checkpoint: {
      height: CHECKPOINT_HEIGHT,
      blockHash: CHECKPOINT_HASH,
      filterHeader: CHECKPOINT_FILTER_HEADER,
    },
    messageTimeoutMs: 120,
    ...over,
  };
}

/** 스캔이 유한 시간에 끝나는지 보장하는 래퍼 — 무한 대기면 여기서 잡힌다. */
async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DEADLINE EXCEEDED (${label}) — 무한 대기 의심`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 스캔이 핸드셰이크를 마치고 headers 를 기다리는 상태까지 진행시킨다. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// ===========================================================================
// 정상 경로 — 아래 적대 테스트들의 대조군. 하네스가 규격을 지킨다는 증거.
// ===========================================================================

describe('bip157/scan — 대조군 (정상 피어)', () => {
  it('기대: 정상 피어면 스캔이 완주하고 매칭 블록의 수취를 기록한다', async () => {
    const s = makeScenario(3, [1]);
    const t = new MockTransport();
    installPeer(t, s);
    const res = await withDeadline(bip157Scan(t, baseOpts()), 5000, 'happy path');

    expect(res.tipHeight).toBe(CHECKPOINT_HEIGHT + 3);
    expect(res.scannedFilterCount).toBe(3);
    expect(res.matchedBlockCount).toBe(1);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]!.height).toBe(CHECKPOINT_HEIGHT + 2);
    expect(res.records[0]!.receivedOutputs[0]!.value).toBe(5_000_000_000n);
    expect(t.closeCount).toBeGreaterThanOrEqual(1); // 성공해도 전송은 닫는다
  });
});

// ===========================================================================
// (a) 핸드셰이크 도중 연결 끊김
// ===========================================================================

describe('(a) 핸드셰이크 도중 연결 끊김', () => {
  it('기대: version 대기 중 끊기면 즉시 reject (무한 대기 X)', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onVersion: (tr) => {
        tr.drop(new Error('ECONNRESET'));
        return true;
      },
    });
    // 실제: peer.next() 가 closedErr 로 즉시 reject → 타임아웃(120ms)보다 훨씬 빠름
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'a1')).rejects.toThrow(/ECONNRESET/);
    expect(t.closeCount).toBeGreaterThanOrEqual(1);
  });

  it('기대: verack 대기 중 끊기면 reject — 사유 없는 종료도 Error 로', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onVersion: (tr) => {
        tr.feedMsg('version', peerVersion(GOOD_SERVICES));
        tr.drop(); // err 없이 정상 종료 — verack 은 영영 안 온다
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'a2')).rejects.toThrow(
      /peer closed connection/,
    );
  });

  it('기대: 이미 끊긴 뒤 스캔이 이어지면 즉시 reject (재시도·재연결 없음)', async () => {
    const t = new MockTransport();
    const s = makeScenario(2);
    installPeer(t, s, {
      onGetHeaders: (tr) => {
        tr.drop(new Error('socket hang up'));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'a3')).rejects.toThrow(
      /socket hang up/,
    );
  });
});

// ===========================================================================
// (b) 응답 없음 (타임아웃)
// ===========================================================================

describe('(b) 응답 없음 — 타임아웃', () => {
  it('기대: 핸드셰이크 무응답이면 messageTimeoutMs 후 timeout 예외', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, { onVersion: () => true }); // 침묵
    const started = Date.now();
    await expect(withDeadline(bip157Scan(t, baseOpts({ messageTimeoutMs: 80 })), 3000, 'b1')).rejects
      .toThrow(/timeout waiting for \[version\]/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.closeCount).toBeGreaterThanOrEqual(1);
  });

  it('기대: 핸드셰이크 후 headers 무응답도 timeout 으로 끝난다', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, { onGetHeaders: () => true });
    await expect(
      withDeadline(bip157Scan(t, baseOpts({ messageTimeoutMs: 80 })), 3000, 'b2'),
    ).rejects.toThrow(/timeout waiting for \[headers\]/);
  });

  it('기대: cfilter 를 일부만 주고 침묵해도 timeout — 무한 while 루프 X', async () => {
    const s = makeScenario(3);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetCfilters: (tr) => {
        tr.feedMsg('cfilter', cfilterPayload(s.chain[0]!.hash, s.filters[0]!)); // 3개 중 1개만
        return true;
      },
    });
    await expect(
      withDeadline(bip157Scan(t, baseOpts({ messageTimeoutMs: 80 })), 3000, 'b3'),
    ).rejects.toThrow(/timeout waiting for \[cfilter\]/);
  });
});

// ===========================================================================
// (c) 잘못된 매직 바이트
// ===========================================================================

describe('(c) 잘못된 매직 바이트', () => {
  it('기대: 다른 네트워크 매직이면 스트림 동기 상실로 즉시 실패 + 연결 종료', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onVersion: (tr) => {
        tr.feedMsg('version', peerVersion(GOOD_SERVICES), TESTNET_MAGIC);
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'c1')).rejects.toThrow(
      /bad magic — stream out of sync/,
    );
    expect(t.connected).toBe(false);
  });

  it('기대: 프레임 앞에 쓰레기 바이트가 끼어도 침묵 재동기화 X — 예외', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onVersion: (tr) => {
        tr.feed(new Uint8Array(24).fill(0x5a)); // 헤더 크기의 쓰레기
        tr.feedMsg('version', peerVersion(GOOD_SERVICES));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'c2')).rejects.toThrow(/bad magic/);
  });
});

// ===========================================================================
// (d) 체크섬 틀린 프레임
// ===========================================================================

describe('(d) 체크섬 틀린 프레임', () => {
  it('기대: 페이로드 1바이트만 훼손돼도 조용히 쓰지 않고 예외', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onVersion: (tr) => {
        const frame = encodeMessage('version', peerVersion(GOOD_SERVICES));
        frame[frame.length - 1] = frame[frame.length - 1]! ^ 0xff;
        tr.feed(frame);
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'd1')).rejects.toThrow(
      /bad checksum for 'version'/,
    );
    expect(t.connected).toBe(false);
  });

  it('기대: 체크섬만 훼손해도 동일 (내용은 멀쩡해 보여도 신뢰 X)', () => {
    const frame = encodeMessage('headers', emptyHeaders());
    frame[20] = frame[20]! ^ 0x01; // checksum 첫 바이트
    expect(() => new P2PFrameDecoder().push(frame)).toThrow(/bad checksum/);
  });

  it('기대: 체크섬 실패 프레임 뒤의 정상 프레임도 처리되지 않는다 (동기 상실)', () => {
    const bad = encodeMessage('ping', new ByteWriter().writeU64LE(1n).toBytes());
    bad[bad.length - 1] = 0xff;
    const good = encodeMessage('verack', new Uint8Array(0));
    const dec = new P2PFrameDecoder();
    expect(() => dec.push(new Uint8Array([...bad, ...good]))).toThrow(/checksum/);
  });
});

// ===========================================================================
// (e) length 필드가 거대 — 메모리 폭탄 시도
// ===========================================================================

describe('(e) 거대 length — 메모리 폭탄', () => {
  /** 헤더만 있고 페이로드가 없는 프레임 (length 는 거짓말). */
  function lyingHeader(command: string, declaredLength: number): Uint8Array {
    const w = new ByteWriter()
      .writeBytes(MAINNET_MAGIC)
      .writeBytes(new Uint8Array(12).map((_, i) => command.charCodeAt(i) || 0))
      .writeU32LE(declaredLength)
      .writeBytes(new Uint8Array(4)); // 체크섬은 어차피 검사 전에 걸러져야 한다
    return w.toBytes();
  }

  it('기대: length 상한이 존재하고, 페이로드가 오기 전 헤더 단계에서 거부', () => {
    const dec = new P2PFrameDecoder();
    // 4 GiB - 1 — u32 최대
    expect(() => dec.push(lyingHeader('headers', 0xffffffff))).toThrow(/payload too large/);
  });

  it('기대: 상한 경계가 32 MiB — 그보다 1바이트 크면 거부', () => {
    const MAX = 32 * 1024 * 1024;
    expect(() => new P2PFrameDecoder().push(lyingHeader('block', MAX + 1))).toThrow(
      /payload too large \(33554433\)/,
    );
    // 경계 이하는 통과(=버퍼링 대기). 실제로 32 MiB 를 할당하지는 않는다.
    const dec = new P2PFrameDecoder();
    expect(dec.push(lyingHeader('block', MAX))).toEqual([]);
  });

  it('기대: 거대 length 선언 후 데이터를 흘려도 힙이 선언값만큼 부풀지 않는다', () => {
    const dec = new P2PFrameDecoder();
    dec.push(lyingHeader('block', 32 * 1024 * 1024));
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 64; i++) dec.push(new Uint8Array(1024)); // 총 64 KiB 만 전송
    const after = process.memoryUsage().arrayBuffers;
    // 선언은 32 MiB 지만 실제 도착분(64 KiB) 이상 잡지 않아야 한다
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
  });

  it('기대: 스캔 중 거대 length 를 만나면 연결을 끊고 예외 (조용한 정지 X)', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onVersion: (tr) => {
        tr.feed(lyingHeader('version', 0x7fffffff));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'e4')).rejects.toThrow(
      /payload too large/,
    );
    expect(t.connected).toBe(false);
  });

  it('기대: headers 의 varint 개수가 거대해도 유한 시간에 실패 (선할당 X)', () => {
    // count = 0xffffffffffffffff, 뒤에는 헤더 하나도 없음
    const payload = new Uint8Array([0xff, ...new Uint8Array(8).fill(0xff)]);
    const started = Date.now();
    expect(() => decodeHeadersMessage(payload)).toThrow(/reader: need/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('기대: cfheaders 의 해시 개수가 거대해도 유한 시간에 실패', () => {
    const payload = new Uint8Array([
      0,
      ...new Uint8Array(32).fill(1),
      ...new Uint8Array(32).fill(2),
      0xfe,
      0xff,
      0xff,
      0xff,
      0xff,
    ]);
    const started = Date.now();
    expect(() => decodeCfHeaders(payload)).toThrow(/reader: need 32/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ===========================================================================
// (f) 요청 안 한 메시지 폭주
// ===========================================================================

describe('(f) 요청 안 한 메시지 폭주', () => {
  it('기대: 무시 목록(sendheaders 등) 폭주는 버려지고 스캔은 정상 진행', async () => {
    const s = makeScenario(2);
    const t = new MockTransport();
    installPeer(t, s, {
      onVersion: (tr) => {
        for (let i = 0; i < 2000; i++) tr.feedMsg('sendheaders', new Uint8Array(0));
        tr.feedMsg('version', peerVersion(GOOD_SERVICES));
        tr.feedMsg('verack', new Uint8Array(0));
        return true;
      },
    });
    const res = await withDeadline(bip157Scan(t, baseOpts()), 5000, 'f1');
    expect(res.tipHeight).toBe(CHECKPOINT_HEIGHT + 2);
  });

  it('[VULN] 기대: 무시 목록 밖 메시지 폭주도 큐 상한에 걸려 힙이 폭주하지 않는다', async () => {
    const s = makeScenario(1);
    const t = new MockTransport();
    installPeer(t, s, { onGetHeaders: () => true }); // headers 는 안 준다 — 계속 대기
    const scan = bip157Scan(t, baseOpts({ messageTimeoutMs: 10_000 }));
    scan.catch(() => undefined); // 아래에서 정리
    await settle(); // 핸드셰이크 완료, headers 대기 상태

    // 'reject' 는 IGNORED_COMMANDS 에 없다 → 큐에 그대로 쌓인다.
    // 부수 관찰: 대기자가 있는 동안 매 메시지마다 queue.findIndex 를 도므로 O(n²).
    // 측정은 arrayBuffers — Uint8Array 백킹스토어는 heapUsed 에 잡히지 않는다.
    const junk = new Uint8Array(4000).fill(0x7e);
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 15_000; i++) t.feedMsg('reject', junk); // 페이로드 합계 약 57 MiB
    const after = process.memoryUsage().arrayBuffers;
    const grewMiB = (after - before) / (1024 * 1024);

    // 정리 — 힙 측정 뒤에 연결을 끊어 스캔을 끝낸다
    t.drop(new Error('test teardown'));
    await expect(scan).rejects.toThrow();

    // 올바른 기대: 대기 중 아무도 안 찾는 메시지는 상한을 두고 버려야 한다.
    // 실제: Peer.queue 에 무제한 축적 — 피어가 우리 힙 사용량을 직접 조종한다.
    expect(grewMiB, `unsolicited flood grew heap by ${grewMiB.toFixed(1)} MiB`).toBeLessThan(16);
  });

  it('기대: 폭주 중에도 진짜 응답은 여전히 전달된다 (기능 회귀 없음)', async () => {
    const s = makeScenario(2);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetHeaders: (tr, n) => {
        if (n > 1) return false;
        for (let i = 0; i < 500; i++) tr.feedMsg('reject', new Uint8Array([1, 2, 3]));
        tr.feedMsg('headers', headersPayload(s.chain));
        return true;
      },
    });
    const res = await withDeadline(bip157Scan(t, baseOpts()), 5000, 'f3');
    expect(res.tipHeight).toBe(CHECKPOINT_HEIGHT + 2);
  });

  it('[VULN] 기대: 망가진 ping 페이로드는 데이터 콜백 밖으로 예외를 흘리지 않는다', async () => {
    const s = makeScenario(1);
    const t = new MockTransport();
    installPeer(t, s, { onGetHeaders: () => true });
    const scan = bip157Scan(t, baseOpts({ messageTimeoutMs: 300 }));
    scan.catch(() => undefined);
    await settle();

    // BIP31 이전 ping 은 페이로드가 없다. 적대 피어는 아무 길이나 보낼 수 있다.
    // 올바른 기대: 무시하거나 연결을 끊는다 — 어느 쪽이든 onData 콜백은 throw 하지 않는다.
    // 실제: scan.ts 의 parsePingPayload 가 try 블록 밖에서 throw →
    //       소켓 'data' 핸들러로 예외가 튀어나간다 (노드 셸에서 uncaught).
    let escaped: unknown = null;
    try {
      t.feedMsg('ping', new Uint8Array(0));
    } catch (e) {
      escaped = e;
    }
    t.drop(new Error('test teardown'));
    await expect(scan).rejects.toThrow();
    expect(escaped, `ping 예외가 전송 계층으로 탈출: ${String(escaped)}`).toBeNull();
  });
});

// ===========================================================================
// (g) cfilter 가 cfheader 와 불일치 (위조)
// ===========================================================================

describe('(g) cfilter 위조', () => {
  it('기대: 필터 해시가 cfheaders 와 다르면 "peer lied" 로 중단', async () => {
    const s = makeScenario(3);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetCfilters: (tr) => {
        for (let i = 0; i < s.chain.length; i++) {
          const bytes =
            i === 1
              ? encodeGcsFilter([FOREIGN_SCRIPT, WATCH_SCRIPT], filterKeyFromBlockHash(s.chain[1]!.hash))
              : s.filters[i]!;
          tr.feedMsg('cfilter', cfilterPayload(s.chain[i]!.hash, bytes));
        }
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 5000, 'g1')).rejects.toThrow(
      /cfilter hash mismatch at height 102 — peer lied/,
    );
  });

  it('기대: cfheaders 가 체크포인트 필터헤더에 안 붙으면 중단', async () => {
    const s = makeScenario(2);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetCfHeaders: (tr) => {
        tr.feedMsg(
          'cfheaders',
          cfHeadersPayload(s.chain[1]!.hash, new Uint8Array(32).fill(0xee), s.filterHashes),
        );
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 5000, 'g2')).rejects.toThrow(
      /filter header chain does not connect to checkpoint/,
    );
  });

  it('기대: cfheaders 개수가 요청 구간과 다르면 중단', async () => {
    const s = makeScenario(3);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetCfHeaders: (tr) => {
        tr.feedMsg(
          'cfheaders',
          cfHeadersPayload(s.chain[2]!.hash, CHECKPOINT_FILTER_HEADER, s.filterHashes.slice(0, 2)),
        );
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 5000, 'g3')).rejects.toThrow(
      /cfheaders count 2 != expected 3/,
    );
  });

  it('기대: stopHash 가 요청과 다르면 중단', async () => {
    const s = makeScenario(2);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetCfHeaders: (tr) => {
        tr.feedMsg(
          'cfheaders',
          cfHeadersPayload(new Uint8Array(32).fill(9), CHECKPOINT_FILTER_HEADER, s.filterHashes),
        );
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 5000, 'g4')).rejects.toThrow(
      /cfheaders stop mismatch/,
    );
  });

  it('기대: 모르는 블록의 cfilter·중복 cfilter 는 중단', async () => {
    const s = makeScenario(2);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetCfilters: (tr) => {
        tr.feedMsg('cfilter', cfilterPayload(new Uint8Array(32).fill(0xcd), s.filters[0]!));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 5000, 'g5')).rejects.toThrow(
      /cfilter for unknown block/,
    );

    const s2 = makeScenario(2);
    const t2 = new MockTransport();
    installPeer(t2, s2, {
      onGetCfilters: (tr) => {
        tr.feedMsg('cfilter', cfilterPayload(s2.chain[0]!.hash, s2.filters[0]!));
        tr.feedMsg('cfilter', cfilterPayload(s2.chain[0]!.hash, s2.filters[0]!));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t2, baseOpts()), 5000, 'g5b')).rejects.toThrow(
      /duplicate cfilter/,
    );
  });

  it('설계 한계 기록: 체크포인트 이후를 일관되게 위조하면 단일 피어로는 못 잡는다', async () => {
    // 피어가 "우리 스크립트가 안 든 빈 필터"를 만들고 cfheaders 도 그에 맞게 계산하면
    // 모든 내부 검증을 통과한다. 결과는 "이력 없음" — 조용한 오답.
    // BIP157 구조상 단일 피어로는 탐지 불가 (복수 피어 교차 확인 또는 PoW 앵커가 필요).
    // scan.ts 주석(15-17행)이 PoW 미검증을 명시하고 있으므로 알려진 한계로 고정한다.
    const chain = buildChain(3);
    const emptyFilters = chain.map(() => new Uint8Array([0x00]));
    const s: Scenario = {
      chain,
      filters: emptyFilters,
      filterHashes: emptyFilters.map(computeFilterHash),
      matchIdx: [],
    };
    const t = new MockTransport();
    installPeer(t, s);
    const res = await withDeadline(bip157Scan(t, baseOpts()), 5000, 'g6');
    expect(res.records).toEqual([]);
    expect(res.matchedBlockCount).toBe(0);
    expect(res.scannedFilterCount).toBe(3); // "검사했다"고 보고하지만 내용은 피어가 지어낸 것
  });

  it('설계 한계 기록: PoW 를 검증하지 않으므로 난이도 0 짜리 가짜 체인도 수용한다', async () => {
    // buildHeader 는 PoW 를 전혀 만족하지 않는다. 그런데도 tip 으로 채택된다.
    const s = makeScenario(2);
    const t = new MockTransport();
    installPeer(t, s);
    const res = await withDeadline(bip157Scan(t, baseOpts()), 5000, 'g7');
    expect(res.tipHeight).toBe(CHECKPOINT_HEIGHT + 2);
  });
});

// ===========================================================================
// (h) 잘린 varint
// ===========================================================================

describe('(h) 잘린 varint', () => {
  it('기대: headers 의 count varint 가 잘리면 예외', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onGetHeaders: (tr) => {
        tr.feedMsg('headers', new Uint8Array([0xfd, 0x01])); // 0xfd 뒤 2바이트 필요, 1바이트뿐
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'h1')).rejects.toThrow(
      /varint: truncated/,
    );
  });

  it('기대: headers 본문이 중간에 잘리면 예외', async () => {
    const t = new MockTransport();
    const s = makeScenario(2);
    installPeer(t, s, {
      onGetHeaders: (tr) => {
        const full = headersPayload(s.chain);
        tr.feedMsg('headers', full.subarray(0, full.length - 30)); // 마지막 헤더 절단
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'h2')).rejects.toThrow(
      /reader: need/,
    );
  });

  it('기대: cfilter 의 varbytes 길이가 남은 바이트보다 크면 예외', () => {
    const payload = new Uint8Array([0, ...new Uint8Array(32).fill(3), 0xfd, 0xff, 0xff, 1, 2, 3]);
    expect(() => decodeCfilter(payload)).toThrow(/varbytes: truncated/);
  });

  it('기대: 잘린 varint 를 담은 cfilter 는 스캔을 중단시킨다', async () => {
    const s = makeScenario(2);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetCfilters: (tr) => {
        tr.feedMsg(
          'cfilter',
          new Uint8Array([0, ...s.chain[0]!.hash, 0xfe, 0xff, 0xff, 0xff, 0xff, 0x00]),
        );
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'h4')).rejects.toThrow(
      /varbytes: truncated/,
    );
  });
});

// ===========================================================================
// (i) 빈 응답
// ===========================================================================

describe('(i) 빈 응답', () => {
  it('기대: 0바이트 조각을 계속 흘려도 진행도, 예외도 없이 타임아웃', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onVersion: (tr) => {
        for (let i = 0; i < 100; i++) tr.feed(new Uint8Array(0));
        return true;
      },
    });
    await expect(
      withDeadline(bip157Scan(t, baseOpts({ messageTimeoutMs: 80 })), 3000, 'i1'),
    ).rejects.toThrow(/timeout/);
  });

  it('기대: 빈 version 페이로드는 파싱 예외 (기본값으로 넘어가지 않는다)', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onVersion: (tr) => {
        tr.feedMsg('version', new Uint8Array(0));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'i2')).rejects.toThrow(
      /reader: need 4, have 0/,
    );
  });

  it('기대: 빈 headers 페이로드는 varint 범위 초과 예외', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onGetHeaders: (tr) => {
        tr.feedMsg('headers', new Uint8Array(0));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'i3')).rejects.toThrow(
      /varint: out of bounds/,
    );
  });

  it('기대: headers count=0 은 정상 종료 신호 (체크포인트가 곧 tip)', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, {
      onGetHeaders: (tr) => {
        tr.feedMsg('headers', emptyHeaders());
        return true;
      },
    });
    const res = await withDeadline(bip157Scan(t, baseOpts()), 3000, 'i4');
    expect(res.tipHeight).toBe(CHECKPOINT_HEIGHT);
    expect(res.records).toEqual([]);
    expect(res.scannedFilterCount).toBe(0);
  });

  it('기대: 빈 cfheaders 페이로드도 예외', async () => {
    const s = makeScenario(2);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetCfHeaders: (tr) => {
        tr.feedMsg('cfheaders', new Uint8Array(0));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'i5')).rejects.toThrow(
      /reader: need 1, have 0/,
    );
  });
});

// ===========================================================================
// (j) NODE_COMPACT_FILTERS 미광고 피어
// ===========================================================================

describe('(j) NODE_COMPACT_FILTERS 미광고', () => {
  it('기대: 필터 비트가 없으면 요청 한 번 보내기 전에 중단', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, { services: SERVICE_NODE_NETWORK | SERVICE_NODE_WITNESS });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'j1')).rejects.toThrow(
      /peer lacks NODE_COMPACT_FILTERS \(services=0x9\)/,
    );
    expect(t.commands()).toEqual(['version']); // getcfheaders 까지 가지 않는다
    expect(t.closeCount).toBeGreaterThanOrEqual(1);
  });

  it('기대: services=0 (아무것도 광고 안 함) 도 동일하게 거부', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, { services: 0n });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'j2')).rejects.toThrow(
      /peer lacks NODE_COMPACT_FILTERS/,
    );
  });

  it('기대: 필터 비트만 있으면 통과 (다른 비트는 요구하지 않는다)', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    installPeer(t, s, { services: SERVICE_NODE_COMPACT_FILTERS });
    const res = await withDeadline(bip157Scan(t, baseOpts()), 5000, 'j3');
    expect(res.tipHeight).toBe(CHECKPOINT_HEIGHT + 1);
  });
});

// ===========================================================================
// (l) 진행 없는 헤더 응답 반복 — 무한 루프
// ===========================================================================

describe('(l) 진행 없는 응답 반복', () => {
  it('[VULN] 기대: 같은 헤더 2000개를 계속 줘도 스캐너가 진행 없음을 감지하고 멈춘다', async () => {
    // 배경: scan.ts 의 헤더 루프는 headers.length < 2000 일 때만 빠져나온다.
    // 이미 아는 헤더는 appendHeader 가 조용히 무시하므로 체인은 자라지 않는다.
    // → 피어가 같은 2000개를 무한 반복하면 getheaders 요청도 무한 반복된다.
    const chain = buildChain(2000);
    const payload = headersPayload(chain);
    let rounds = 0;
    const t = new MockTransport();
    const s: Scenario = { chain: [], filters: [], filterHashes: [], matchIdx: [] };
    installPeer(t, s, {
      onGetHeaders: (tr, n) => {
        rounds = n;
        // 테스트가 영영 안 끝나는 것을 막기 위한 탈출구 — 실제 피어는 안 멈춘다.
        if (n > 10) tr.feedMsg('headers', emptyHeaders());
        else tr.feedMsg('headers', payload);
        return true;
      },
      onGetCfHeaders: (tr) => {
        tr.drop(new Error('stop after header loop'));
        return true;
      },
    });
    await withDeadline(bip157Scan(t, baseOpts()), 10_000, 'l1').catch(() => undefined);

    // 올바른 기대: 진행이 없으면 늦어도 두 번째 응답에서 중단해야 한다.
    // 실제: 탈출구를 넣어 준 11회까지 계속 요청 — 탈출구가 없으면 무한.
    expect(rounds, `getheaders 를 ${rounds}회 반복 — 진행 없음 감지 실패`).toBeLessThanOrEqual(2);
  });

  it('기대: 연결되지 않는 헤더는 즉시 중단 (조용한 무시 X)', async () => {
    const t = new MockTransport();
    const s = makeScenario(1);
    const orphan = buildChain(2, new Uint8Array(32).fill(0xfe));
    installPeer(t, s, {
      onGetHeaders: (tr) => {
        tr.feedMsg('headers', headersPayload(orphan));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 3000, 'l2')).rejects.toThrow(
      /reorg deeper than checkpoint/,
    );
  });
});

// ===========================================================================
// (m) 블록 다운로드 단계의 적대 응답
// ===========================================================================

describe('(m) getdata 단계', () => {
  it('기대: notfound 면 중단 (조용히 이력 누락 X)', async () => {
    const s = makeScenario(2, [0]);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetData: (tr) => {
        tr.feedMsg('notfound', new Uint8Array([0]));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 5000, 'm1')).rejects.toThrow(
      /peer has no block data/,
    );
  });

  it('기대: 요청 안 한 블록만 계속 줘도 무한 루프가 아니라 타임아웃', async () => {
    const s = makeScenario(2, [0]);
    const other = buildChain(1, new Uint8Array(32).fill(0x99));
    const t = new MockTransport();
    installPeer(t, s, {
      onGetData: (tr) => {
        for (let i = 0; i < 200; i++) {
          tr.feedMsg('block', blockPayload(other[0]!, [coinbaseTx(FOREIGN_SCRIPT, 1n)]));
        }
        return true;
      },
    });
    // 참고: 피어가 계속 보내는 한 매 메시지마다 타임아웃이 갱신된다.
    // 전체 스캔에 대한 마감 시한은 없다 — 여기서는 피어가 멈추므로 타임아웃으로 끝난다.
    await expect(
      withDeadline(bip157Scan(t, baseOpts({ messageTimeoutMs: 80 })), 5000, 'm2'),
    ).rejects.toThrow(/timeout waiting for \[block, notfound\]/);
  });

  it('기대: 헤더가 요청 블록과 다른 위조 블록은 무시되고 결국 타임아웃', async () => {
    const s = makeScenario(2, [0]);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetData: (tr) => {
        // 우리 스크립트로 5000 BTC 를 보낸 것처럼 보이는 블록이지만 해시가 다르다
        const fake = buildHeader(new Uint8Array(32).fill(0x77), 200);
        tr.feedMsg('block', blockPayload(fake, [coinbaseTx(WATCH_SCRIPT, 500_000_000_000n)]));
        return true;
      },
    });
    await expect(
      withDeadline(bip157Scan(t, baseOpts({ messageTimeoutMs: 80 })), 5000, 'm3'),
    ).rejects.toThrow(/timeout/);
  });

  it('기대: 요청한 블록의 tx 가 잘려 있으면 예외', async () => {
    const s = makeScenario(2, [0]);
    const t = new MockTransport();
    installPeer(t, s, {
      onGetData: (tr, hashes) => {
        const idx = s.chain.findIndex((c) => bytesToHex(c.hash) === bytesToHex(hashes[0]!));
        const full = blockPayload(s.chain[idx]!, [coinbaseTx(WATCH_SCRIPT, 1n)]);
        tr.feedMsg('block', full.subarray(0, full.length - 6));
        return true;
      },
    });
    await expect(withDeadline(bip157Scan(t, baseOpts()), 5000, 'm4')).rejects.toThrow(
      /varbytes: truncated|reader: need/,
    );
  });
});
