#!/usr/bin/env node
// measure-cfilters.mjs — 실피어에서 BIP157 compact filter(cfilter) 본체 실측·검증.
//
// 왜: cfheader(32바이트 고정)는 비용이 뻔하다. 실사용 비용을 정하는 것은 필터 본체
//     크기이고, 그것은 블록의 스크립트 개수에 비례해 높이대별로 다르다. 2013년 블록과
//     최근 블록을 같은 방법으로 재서 그 차이를 숫자로 낸다.
//
// 하는 일:
//   1. DNS 시드(x49.* — NODE_NETWORK|WITNESS|COMPACT_FILTERS)로 피어를 찾아 핸드셰이크.
//   2. 제네시스부터 headers 를 걸어 전 높이의 블록해시·타임스탬프를 확보 (stopHash 필요).
//   3. 지정 구간마다 getcfheaders → getcfilters. 필터 본체 수신 바이트·시간 실측.
//   4. 정합성: 받은 각 필터의 dsha256 == 앞서 받은 cfheaders 의 filter_hash 인지 검사
//      (피어 위조 검출 경로). 비트 뒤집기 음성 시험으로 그 경로가 실제로 도는지 확인.
//      필터 헤더 체인을 이어 다음 구간 cfheaders 의 previous_filter_header 와 대조.
//   5. GCS 디코드로 필터 원소 개수(N)를 세고, 원소당 바이트를 낸다.
//   6. 확률표본(probe)으로 높이대별 곡선을 만들어 전체 체인 총량을 사다리꼴 적분으로 추정.
//
// 쓰기 금지 규칙: 이 스크립트는 파일을 만들지 않는다. 결과는 stdout 으로만.
//
// 실행:
//   node scripts/btc-p2p/measure-cfilters.mjs
//   node scripts/btc-p2p/measure-cfilters.mjs --host 1.2.3.4 --port 8333 --count 1000
//   node scripts/btc-p2p/measure-cfilters.mjs --window-a 250000 --probe-step 50000

import dns from 'node:dns/promises';
import { NodeTcpTransport } from './node-transport.mjs';
import {
  FILTER_TYPE_BASIC,
  MAINNET_MAGIC,
  P2PFrameDecoder,
  buildPongPayload,
  buildVersionPayload,
  bytesEqual,
  bytesToHex,
  computeFilterHash,
  computeFilterHeader,
  decodeCfHeaders,
  decodeCfilter,
  decodeGcsFilterValues,
  decodeHeadersMessage,
  displayHashToInternal,
  encodeGetCfHeaders,
  encodeGetCfilters,
  encodeGetHeaders,
  encodeMessage,
  hasCompactFilters,
  internalHashToDisplay,
  parsePingPayload,
  parseVersionPayload,
} from '../../packages/wallet-sdk/dist/btc-history.js';

// ---------------------------------------------------------------------------
// 상수 · 인자
// ---------------------------------------------------------------------------

/** mainnet 제네시스 (display hex) — headers 워크의 출발 locator. */
const GENESIS_DISPLAY =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

/** 서비스 비트 0x49 = NODE_NETWORK(1) | NODE_WITNESS(8) | NODE_COMPACT_FILTERS(0x40). */
const SEEDS = [
  'x49.seed.bitcoin.sipa.be',
  'x49.dnsseed.bluematt.me',
  'x49.seed.bitcoin.sprovoost.nl',
  'x49.dnsseed.emzy.de',
  'x49.seed.bitcoin.wiz.biz',
  'x49.seed.btc.petertodd.net',
  'x49.seed.bitcoinstats.com',
];

const IGNORED = new Set([
  'sendheaders', 'sendcmpct', 'wtxidrelay', 'sendaddrv2', 'addr', 'addrv2',
  'inv', 'tx', 'feefilter', 'getheaders', 'getaddr', 'alert', 'pong',
  'getblocks', 'mempool', 'reject', 'cmpctblock', 'blocktxn', 'getblocktxn',
  'merkleblock', 'filterload', 'filteradd', 'filterclear',
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = 'true';
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const num = (k, d) => (ARGS[k] === undefined ? d : Number(ARGS[k]));

const CFG = {
  host: ARGS.host ?? null,
  port: num('port', 8333),
  /** 주 구간 A — 2013년경. */
  windowA: num('window-a', 250_000),
  /** 주 구간 B — 최신. 지정 없으면 tip - count. */
  windowB: ARGS['window-b'] === undefined ? null : Number(ARGS['window-b']),
  count: num('count', 1000),
  probeStep: num('probe-step', 50_000),
  probeCount: num('probe-count', 200),
  timeoutMs: num('timeout-ms', 30_000),
  peerTries: num('peer-tries', 20),
};

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

// 조용한 종료를 잡아낸다 — 어떤 경로로 죽었는지 반드시 남긴다.
process.on('uncaughtException', (e) => {
  log('UNCAUGHT: ' + (e?.stack ?? e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log('UNHANDLED REJECTION: ' + (e?.stack ?? e));
  process.exit(1);
});

// ---------------------------------------------------------------------------
// 바이트 계수 전송 래퍼 — node-transport.mjs 를 건드리지 않고 감싼다.
// ---------------------------------------------------------------------------

class CountingTransport {
  bytesIn = 0;
  bytesOut = 0;

  constructor(inner) {
    this.inner = inner;
  }

  connect(host, port, opts) {
    return this.inner.connect(host, port, opts);
  }

  async send(bytes) {
    this.bytesOut += bytes.length;
    return this.inner.send(bytes);
  }

  onData(cb) {
    this.inner.onData((chunk) => {
      this.bytesIn += chunk.length;
      cb(chunk);
    });
  }

  onClose(cb) {
    this.inner.onClose(cb);
  }

  /**
   * NodeTcpTransport.close() 는 이미 destroy 된 소켓에서 end(cb) 의 콜백이 오지 않아
   * 영원히 pending 이 된다. 남은 핸들이 없으면 node 는 조용히 exit 0 으로 끝나 버린다
   * (연결 실패 후 다음 피어로 못 넘어감). 여기서 타이머로 끊는다. — SDK 밖 이슈,
   * node-transport.mjs 는 공유 파일이라 손대지 않는다.
   */
  close() {
    return Promise.race([
      this.inner.close().catch(() => undefined),
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }
}

// ---------------------------------------------------------------------------
// 피어 — scan.ts 의 Peer 와 같은 모양 (SDK 가 내보내지 않아 여기서 최소 재현).
// ---------------------------------------------------------------------------

class Peer {
  constructor(transport, magic, timeoutMs) {
    this.transport = transport;
    this.magic = magic;
    this.timeoutMs = timeoutMs;
    this.decoder = new P2PFrameDecoder(magic);
    this.queue = [];
    this.waiter = null;
    this.closedErr = null;
    transport.onData((chunk) => this.#onChunk(chunk));
    transport.onClose((e) => this.#onClose(e ?? new Error('peer closed connection')));
  }

  #onChunk(chunk) {
    let messages;
    try {
      messages = this.decoder.push(chunk);
    } catch (e) {
      this.#onClose(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    for (const msg of messages) {
      if (msg.command === 'ping') {
        void this.send('pong', buildPongPayload(parsePingPayload(msg.payload))).catch(
          () => undefined,
        );
        continue;
      }
      if (IGNORED.has(msg.command)) continue;
      this.queue.push(msg);
      this.#deliver();
    }
  }

  #onClose(err) {
    if (this.closedErr) return;
    this.closedErr = err;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(err);
      this.waiter = null;
    }
  }

  #deliver() {
    if (!this.waiter) return;
    const idx = this.queue.findIndex((m) => this.waiter.commands.has(m.command));
    if (idx < 0) return;
    const msg = this.queue.splice(idx, 1)[0];
    clearTimeout(this.waiter.timer);
    const { resolve } = this.waiter;
    this.waiter = null;
    resolve(msg);
  }

  async send(command, payload) {
    await this.transport.send(encodeMessage(command, payload, this.magic));
  }

  next(...commands) {
    if (this.closedErr) return Promise.reject(this.closedErr);
    if (this.waiter) return Promise.reject(new Error('peer: concurrent next()'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`peer: timeout waiting for [${commands.join(', ')}]`));
      }, this.timeoutMs);
      this.waiter = { commands: new Set(commands), resolve, reject, timer };
      this.#deliver();
    });
  }
}

// ---------------------------------------------------------------------------
// 피어 확보
// ---------------------------------------------------------------------------

async function candidateHosts() {
  if (CFG.host) return [CFG.host];
  const found = [];
  for (const seed of SEEDS) {
    try {
      const addrs = await dns.resolve4(seed);
      for (const a of addrs) if (!found.includes(a)) found.push(a);
      log(`seed ${seed}: ${addrs.length} addrs`);
    } catch (e) {
      log(`seed ${seed}: ${e.message}`);
    }
    if (found.length >= 40) break;
  }
  // 셔플 — 매번 같은 피어를 때리지 않는다.
  for (let i = found.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [found[i], found[j]] = [found[j], found[i]];
  }
  return found;
}

async function connectPeer() {
  const hosts = await candidateHosts();
  if (hosts.length === 0) throw new Error('no candidate peers (DNS seeds failed)');
  let lastErr = null;
  for (const host of hosts.slice(0, CFG.peerTries)) {
    const transport = new CountingTransport(new NodeTcpTransport());
    try {
      const t0 = Date.now();
      await transport.connect(host, CFG.port, { timeoutMs: 6000 });
      const peer = new Peer(transport, MAINNET_MAGIC, CFG.timeoutMs);
      await peer.send('version', buildVersionPayload({ relay: false }));
      const vm = await peer.next('version');
      const remote = parseVersionPayload(vm.payload);
      if (!hasCompactFilters(remote.services)) {
        throw new Error(`no NODE_COMPACT_FILTERS (services=0x${remote.services.toString(16)})`);
      }
      await peer.send('verack', new Uint8Array(0));
      await peer.next('verack');
      const handshakeMs = Date.now() - t0;
      log(`peer ${host}:${CFG.port} ok — ${remote.userAgent} h=${remote.startHeight} (${handshakeMs}ms)`);
      return { peer, transport, host, remote, handshakeMs };
    } catch (e) {
      lastErr = e;
      log(`peer ${host}: ${e.message}`);
      await transport.close().catch(() => undefined);
    }
  }
  throw new Error(`no usable peer; last: ${lastErr?.message}`);
}

// ---------------------------------------------------------------------------
// 헤더 워크 — 전 높이의 블록해시(32B)·타임스탬프를 확보한다.
// ---------------------------------------------------------------------------

class HashStore {
  constructor() {
    this.buf = new Uint8Array(32 * 1024);
    this.ts = new Uint32Array(1024);
    this.count = 0;
  }

  push(hash, timestamp) {
    if ((this.count + 1) * 32 > this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
      const nt = new Uint32Array(this.ts.length * 2);
      nt.set(this.ts);
      this.ts = nt;
    }
    this.buf.set(hash, this.count * 32);
    this.ts[this.count] = timestamp;
    this.count++;
  }

  /** height → internal 순서 블록해시 (사본 아님 — 읽기 전용으로만 쓴다). */
  get(h) {
    return this.buf.subarray(h * 32, h * 32 + 32);
  }
}

async function walkHeaders(peer, transport) {
  const store = new HashStore();
  store.push(displayHashToInternal(GENESIS_DISPLAY), 1231006505);
  const t0 = Date.now();
  const bytes0 = transport.bytesIn;
  let batches = 0;
  for (;;) {
    const locator = [new Uint8Array(store.get(store.count - 1))];
    await peer.send('getheaders', encodeGetHeaders(locator));
    const msg = await peer.next('headers');
    const headers = decodeHeadersMessage(msg.payload);
    batches++;
    if (headers.length === 0) break;
    for (const h of headers) {
      if (!bytesEqual(h.prevBlockHash, store.get(store.count - 1))) {
        throw new Error(`headers: link break at height ${store.count}`);
      }
      store.push(h.hash, h.timestamp);
    }
    if (batches % 50 === 0) log(`  headers… tip=${store.count - 1} (${batches} batches)`);
    if (headers.length < 2000) break;
  }
  return {
    store,
    tipHeight: store.count - 1,
    ms: Date.now() - t0,
    bytes: transport.bytesIn - bytes0,
    batches,
  };
}

// ---------------------------------------------------------------------------
// 한 구간 실측: getcfheaders → getcfilters
// ---------------------------------------------------------------------------

/**
 * @returns 구간 실측치 + 검증 결과 + 마지막 필터 헤더 (다음 구간 연결 대조용)
 */
async function measureWindow(peer, transport, store, startHeight, count, label) {
  const stopHeight = startHeight + count - 1;
  const stopHash = new Uint8Array(store.get(stopHeight));

  // --- cfheaders (필터 해시 기준값 확보) ---
  const th0 = Date.now();
  const bh0 = transport.bytesIn;
  await peer.send('getcfheaders', encodeGetCfHeaders(startHeight, stopHash));
  const chMsg = await peer.next('cfheaders');
  const cfh = decodeCfHeaders(chMsg.payload);
  const cfheadersMs = Date.now() - th0;
  const cfheadersBytes = transport.bytesIn - bh0;

  if (cfh.filterType !== FILTER_TYPE_BASIC) throw new Error(`${label}: filter type ${cfh.filterType}`);
  if (!bytesEqual(cfh.stopHash, stopHash)) throw new Error(`${label}: cfheaders stop mismatch`);
  if (cfh.filterHashes.length !== count) {
    throw new Error(`${label}: cfheaders count ${cfh.filterHashes.length} != ${count}`);
  }

  // 기대 filter_hash: height → hash
  const expectByHeight = new Map();
  for (let i = 0; i < count; i++) expectByHeight.set(startHeight + i, cfh.filterHashes[i]);

  // height 역색인 (cfilter 는 blockHash 로만 온다)
  const heightByHash = new Map();
  for (let h = startHeight; h <= stopHeight; h++) heightByHash.set(bytesToHex(store.get(h)), h);

  // --- 1단계: 수신만 (순수 네트워크 시간) ---
  // 검증·GCS 디코드를 수신 루프 안에서 하면 CPU 시간이 수신 시간에 섞여
  // "필터/초"가 네트워크가 아니라 디코더 속도를 재게 된다. 두 단계로 나눈다.
  const received = []; // { height, filterBytes, payloadLen }
  const seen = new Set();
  let filterBodyBytes = 0; // GCS 원문 바이트 합 (varint N 포함)
  let framedBytes = 0; // 와이어 프레임 전체 (24 헤더 + 페이로드)

  const t0 = Date.now();
  const b0 = transport.bytesIn;
  await peer.send('getcfilters', encodeGetCfilters(startHeight, stopHash));
  let firstByteMs = -1;
  while (received.length < count) {
    const msg = await peer.next('cfilter');
    if (firstByteMs < 0) firstByteMs = Date.now() - t0;
    const cf = decodeCfilter(msg.payload);
    const h = heightByHash.get(bytesToHex(cf.blockHash));
    if (h === undefined) throw new Error(`${label}: cfilter for unknown block`);
    if (seen.has(h)) throw new Error(`${label}: duplicate cfilter at ${h}`);
    seen.add(h);
    filterBodyBytes += cf.filterBytes.length;
    framedBytes += 24 + msg.payload.length;
    received.push({ height: h, filterBytes: cf.filterBytes, payloadLen: msg.payload.length });
  }
  const ms = Date.now() - t0;
  const socketBytes = transport.bytesIn - b0;

  // --- 2단계: 검증 + GCS 디코드 (순수 CPU 시간) ---
  let hashOk = 0;
  let hashBad = 0;
  let gcsOk = 0;
  let gcsFail = 0;
  let totalElements = 0;

  const vh0 = Date.now();
  for (const r of received) {
    if (bytesEqual(computeFilterHash(r.filterBytes), expectByHeight.get(r.height))) hashOk++;
    else {
      hashBad++;
      log(`  !! ${label}: filter hash mismatch at height ${r.height}`);
    }
  }
  const verifyMs = Date.now() - vh0;

  const gd0 = Date.now();
  for (const r of received) {
    try {
      const dec = decodeGcsFilterValues(r.filterBytes);
      if (dec.values.length !== dec.n) {
        throw new Error(`value count ${dec.values.length} != n ${dec.n}`);
      }
      totalElements += dec.n;
      gcsOk++;
    } catch (e) {
      gcsFail++;
      log(`  !! ${label}: gcs decode failed at ${r.height}: ${e.message}`);
    }
  }
  const gcsDecodeMs = Date.now() - gd0;

  // --- 음성 시험: 한 필터의 비트를 뒤집으면 검출되는가 ---
  const first = received[0];
  const tampered = new Uint8Array(first.filterBytes);
  tampered[tampered.length - 1] ^= 0x01;
  const tamperDetected = !bytesEqual(
    computeFilterHash(tampered),
    expectByHeight.get(first.height),
  );

  // --- 필터 헤더 체인 전개 ---
  let fh = cfh.previousFilterHeader;
  for (let i = 0; i < count; i++) fh = computeFilterHeader(cfh.filterHashes[i], fh);

  const sorted = received.map((r) => r.filterBytes.length).sort((a, b) => a - b);

  return {
    label,
    startHeight,
    stopHeight,
    count,
    startTime: store.ts[startHeight],
    stopTime: store.ts[stopHeight],
    cfheadersMs,
    cfheadersBytes,
    ms,
    verifyMs,
    gcsDecodeMs,
    firstByteMs,
    socketBytes,
    framedBytes,
    filterBodyBytes,
    avgFilterBytes: filterBodyBytes / count,
    minFilterBytes: sorted[0],
    medianFilterBytes: sorted[Math.floor(count / 2)],
    maxFilterBytes: sorted[count - 1],
    p95FilterBytes: sorted[Math.floor(count * 0.95)],
    totalElements,
    avgElements: totalElements / count,
    bytesPerElement: totalElements > 0 ? filterBodyBytes / totalElements : 0,
    filtersPerSec: (count / ms) * 1000,
    bytesPerSec: (socketBytes / ms) * 1000,
    hashOk,
    hashBad,
    gcsOk,
    gcsFail,
    tamperDetected,
    previousFilterHeader: cfh.previousFilterHeader,
    endFilterHeader: fh,
    stopHash,
  };
}

// ---------------------------------------------------------------------------
// 출력 헬퍼
// ---------------------------------------------------------------------------

const nf = (x, d = 0) =>
  Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const mb = (b) => nf(b / 1_048_576, 2);
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const pad = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const scriptT0 = Date.now();
  out('# BIP157 cfilter 본체 실측 — ' + new Date().toISOString());
  out('');

  // conn 은 갈아끼울 수 있다 — 피어가 중간에 끊기면 다른 피어로 이어서 잰다.
  let conn = await connectPeer();
  let carriedBytesIn = 0;
  let carriedBytesOut = 0;
  const reconnect = async () => {
    carriedBytesIn += conn.transport.bytesIn;
    carriedBytesOut += conn.transport.bytesOut;
    await conn.transport.close().catch(() => undefined);
    conn = await connectPeer();
  };
  try {
    out(`피어: ${conn.host}:${CFG.port}  ua=${conn.remote.userAgent}  services=0x${conn.remote.services.toString(16)}  startHeight=${conn.remote.startHeight}  핸드셰이크 ${conn.handshakeMs}ms`);

    // --- 헤더 워크 ---
    log('headers 워크 시작…');
    const walk = await walkHeaders(conn.peer, conn.transport);
    const tip = walk.tipHeight;
    out(`헤더 워크: 제네시스→tip ${nf(tip)}  ${nf(walk.batches)} 요청  ${mb(walk.bytes)} MiB  ${nf(walk.ms)} ms  (${nf((walk.bytes / walk.ms) * 1000 / 1_048_576, 2)} MiB/s)`);
    out(`tip 해시: ${internalHashToDisplay(walk.store.get(tip))}  (${day(walk.store.ts[tip])})`);
    out('');

    const store = walk.store;
    const windowB = CFG.windowB ?? tip - CFG.count + 1;

    /** 피어가 끊기면 다른 피어로 갈아타고 한 번 더 시도한다. */
    const measure = async (start, count, label) => {
      try {
        return await measureWindow(conn.peer, conn.transport, store, start, count, label);
      } catch (e) {
        log(`  ${label} 실패(${e.message}) — 피어 교체 후 재시도`);
        await reconnect();
        return await measureWindow(conn.peer, conn.transport, store, start, count, label);
      }
    };

    // --- 주 구간 2개 ---
    const A = await measure(CFG.windowA, CFG.count, 'A(2013년경)');
    log(`  A 완료: ${A.avgFilterBytes.toFixed(1)} B/filter`);
    const B = await measure(windowB, CFG.count, 'B(최근)');
    log(`  B 완료: ${B.avgFilterBytes.toFixed(1)} B/filter`);

    // --- 검증 보강: A 구간 필터 헤더 체인이 다음 구간 cfheaders 와 이어지는가 ---
    let chainLinkOk = null;
    try {
      const nextStart = A.stopHeight + 1;
      const nextStop = new Uint8Array(store.get(nextStart + 9));
      await conn.peer.send('getcfheaders', encodeGetCfHeaders(nextStart, nextStop));
      const nm = await conn.peer.next('cfheaders');
      const nc = decodeCfHeaders(nm.payload);
      chainLinkOk = bytesEqual(nc.previousFilterHeader, A.endFilterHeader);
    } catch (e) {
      chainLinkOk = `실패: ${e.message}`;
    }

    // -----------------------------------------------------------------------
    // 출력 1·2 — 표본 수집보다 먼저 낸다 (뒤가 깨져도 핵심 실측은 남는다).
    // -----------------------------------------------------------------------
    out('## 1. 주 구간 실측 (구간당 ' + nf(CFG.count) + ' 블록)');
    out('');
    const rows = [A, B];
    const cols = [
      ['구간', (r) => r.label, 14],
      ['높이', (r) => `${nf(r.startHeight)}–${nf(r.stopHeight)}`, 19],
      ['날짜', (r) => day(r.startTime), 11],
      ['평균 B/필터', (r) => nf(r.avgFilterBytes, 1), 12],
      ['중앙', (r) => nf(r.medianFilterBytes), 8],
      ['p95', (r) => nf(r.p95FilterBytes), 8],
      ['최대', (r) => nf(r.maxFilterBytes), 8],
      ['구간 총(KiB)', (r) => nf(r.filterBodyBytes / 1024, 1), 13],
      ['수신 ms', (r) => nf(r.ms), 9],
      ['필터/초', (r) => nf(r.filtersPerSec, 1), 10],
      ['KiB/s', (r) => nf(r.bytesPerSec / 1024, 1), 10],
      ['평균 N', (r) => nf(r.avgElements, 1), 9],
      ['B/원소', (r) => nf(r.bytesPerElement, 2), 8],
      ['해시검증 ms', (r) => nf(r.verifyMs), 12],
      ['GCS디코드 ms', (r) => nf(r.gcsDecodeMs), 13],
    ];
    out(cols.map(([h, , w]) => pad(h, w)).join(' '));
    out(cols.map(([, , w]) => '-'.repeat(w)).join(' '));
    for (const r of rows) out(cols.map(([, f, w]) => pad(f(r), w)).join(' '));
    out('');
    out(`와이어 오버헤드: A 프레임합 ${nf(A.framedBytes)} B vs 필터본체 ${nf(A.filterBodyBytes)} B (차 ${nf(A.framedBytes - A.filterBodyBytes)} B = 필터당 ${nf((A.framedBytes - A.filterBodyBytes) / A.count, 1)} B)`);
    out(`                B 프레임합 ${nf(B.framedBytes)} B vs 필터본체 ${nf(B.filterBodyBytes)} B (차 ${nf(B.framedBytes - B.filterBodyBytes)} B = 필터당 ${nf((B.framedBytes - B.filterBodyBytes) / B.count, 1)} B)`);
    out(`소켓 실수신(TCP 페이로드): A ${nf(A.socketBytes)} B · B ${nf(B.socketBytes)} B`);
    out(`cfheaders 선행 비용: A ${nf(A.cfheadersBytes)} B / ${nf(A.cfheadersMs)} ms · B ${nf(B.cfheadersBytes)} B / ${nf(B.cfheadersMs)} ms`);
    out(`첫 cfilter 도착: A ${nf(A.firstByteMs)} ms · B ${nf(B.firstByteMs)} ms (요청→첫 응답 = RTT 근사)`);
    out('');
    out(`배수: 최근/2013 평균 필터 크기 = ${nf(B.avgFilterBytes / A.avgFilterBytes, 2)}배, 평균 원소수 = ${nf(B.avgElements / A.avgElements, 2)}배`);
    out('');

    // --- 검증 ---
    out('## 2. 정합성 검증');
    out('');
    for (const r of rows) {
      out(`${padr(r.label, 14)} filter_hash 일치 ${nf(r.hashOk)}/${nf(r.count)} · 불일치 ${nf(r.hashBad)} · GCS 디코드 성공 ${nf(r.gcsOk)}/${nf(r.count)} (실패 ${nf(r.gcsFail)}) · 원소 합 ${nf(r.totalElements)}`);
      out(`${padr('', 14)} 비트 뒤집기 음성시험: ${r.tamperDetected ? '검출됨 (검출 경로 작동)' : '검출 실패 — 검증 경로가 죽어 있음'}`);
    }
    out(`필터 헤더 체인 연결(A 끝 → 다음 cfheaders 의 previous_filter_header): ${chainLinkOk === true ? '일치' : chainLinkOk === false ? '불일치' : chainLinkOk}`);
    out('');

    // --- 표본(probe): 높이대별 곡선 ---
    const probeHeights = [];
    for (let h = 1000; h + CFG.probeCount <= tip; h += CFG.probeStep) probeHeights.push(h);
    const lastProbe = tip - CFG.probeCount;
    if (lastProbe > (probeHeights[probeHeights.length - 1] ?? 0)) probeHeights.push(lastProbe);

    const probes = [];
    const probeFails = [];
    for (const h of probeHeights) {
      try {
        const p = await measure(h, CFG.probeCount, `probe@${h}`);
        probes.push(p);
        log(`  probe ${h}: ${p.avgFilterBytes.toFixed(1)} B/filter, N=${p.avgElements.toFixed(1)}, ${p.ms}ms`);
      } catch (e) {
        probeFails.push(`${h}: ${e.message}`);
        log(`  probe ${h} 포기: ${e.message}`);
      }
    }
    if (probes.length < 2) throw new Error('표본이 2개 미만 — 추정 불가');

    // --- 표본 곡선 ---
    out('## 3. 높이대별 표본 (구간당 ' + nf(CFG.probeCount) + ' 블록)');
    out('');
    out([pad('높이', 10), pad('날짜', 11), pad('평균 B/필터', 12), pad('평균 N', 9), pad('B/원소', 8), pad('ms', 7), pad('필터/초', 9)].join(' '));
    out([10, 11, 12, 9, 8, 7, 9].map((w) => '-'.repeat(w)).join(' '));
    for (const p of probes) {
      out([
        pad(nf(p.startHeight), 10),
        pad(day(p.startTime), 11),
        pad(nf(p.avgFilterBytes, 1), 12),
        pad(nf(p.avgElements, 1), 9),
        pad(nf(p.bytesPerElement, 2), 8),
        pad(nf(p.ms), 7),
        pad(nf(p.filtersPerSec, 1), 9),
      ].join(' '));
    }
    if (probeFails.length > 0) out(`실패한 표본: ${probeFails.join(' · ')}`);
    out('');

    // --- 추정 ---
    // 사다리꼴 적분: 인접 표본 두 점의 평균 B/필터를 그 구간 블록수에 곱해 합산.
    const pts = probes.map((p) => ({ h: p.startHeight + p.count / 2, b: p.avgFilterBytes }));
    pts.sort((a, b) => a.h - b.h);
    let est = 0;
    const terms = [];
    // 0 → 첫 표본: 첫 표본값으로 평평하게 (초기 블록은 그보다 작으므로 상한 성격)
    const head = pts[0].h * pts[0].b;
    est += head;
    terms.push(`0–${nf(Math.round(pts[0].h))}: ${nf(Math.round(pts[0].h))} × ${nf(pts[0].b, 1)} = ${mb(head)} MiB`);
    for (let i = 0; i + 1 < pts.length; i++) {
      const span = pts[i + 1].h - pts[i].h;
      const mid = (pts[i].b + pts[i + 1].b) / 2;
      const seg = span * mid;
      est += seg;
      terms.push(`${nf(Math.round(pts[i].h))}–${nf(Math.round(pts[i + 1].h))}: ${nf(Math.round(span))} × ${nf(mid, 1)} = ${mb(seg)} MiB`);
    }
    // 마지막 표본 → tip
    const tailSpan = tip - pts[pts.length - 1].h;
    if (tailSpan > 0) {
      const seg = tailSpan * pts[pts.length - 1].b;
      est += seg;
      terms.push(`${nf(Math.round(pts[pts.length - 1].h))}–${nf(tip)}: ${nf(Math.round(tailSpan))} × ${nf(pts[pts.length - 1].b, 1)} = ${mb(seg)} MiB`);
    }

    const totalFilters = tip + 1;
    const frameOverheadPerFilter = (B.framedBytes - B.filterBodyBytes) / B.count;
    const wireEst = est + totalFilters * frameOverheadPerFilter;
    const cfheadersEst = totalFilters * 32;

    // 시간 모델: 요청 수 × RTT + 총바이트 / 대역폭.
    // 대역폭은 바이트 가중으로 낸다 — A(작은 필터)와 B(큰 필터)의 "초당 필터 수"를
    // 산술평균하면 안 된다(서로 다른 작업량의 속도라 평균이 성립하지 않는다).
    const rtt = (A.firstByteMs + B.firstByteMs) / 2;
    const dlMsA = A.ms - A.firstByteMs > 0 ? A.ms - A.firstByteMs : A.ms;
    const dlMsB = B.ms - B.firstByteMs > 0 ? B.ms - B.firstByteMs : B.ms;
    const bwA = (A.socketBytes / dlMsA) * 1000; // B/s
    const bwB = (B.socketBytes / dlMsB) * 1000; // B/s
    const bw = ((A.socketBytes + B.socketBytes) / (dlMsA + dlMsB)) * 1000; // B/s, 바이트 가중
    const nReq = Math.ceil(totalFilters / 1000);
    const timeSec = (nReq * rtt) / 1000 + wireEst / bw;
    // 교차검산: 총량의 대부분이 최근 크기대의 필터이므로 B 구간 대역폭만으로도 재본다.
    const timeSecB = (nReq * rtt) / 1000 + wireEst / bwB;

    out('## 4. 전체 체인 추정 (계산식)');
    out('');
    out(`총 필터 수 = tip + 1 = ${nf(tip)} + 1 = ${nf(totalFilters)}개`);
    out('');
    out('필터 본체 총량 = Σ (구간 블록수 × 인접 표본 평균 B/필터)  [사다리꼴 적분]');
    for (const t of terms) out('  ' + t);
    out(`  합계 = ${mb(est)} MiB = ${nf(est / 1_073_741_824, 3)} GiB`);
    out('');
    out(`와이어 총량 = 본체 ${mb(est)} MiB + 프레임/헤더 오버헤드 ${nf(totalFilters)} × ${nf(frameOverheadPerFilter, 1)} B = ${mb(wireEst)} MiB`);
    out(`(참고) cfheaders 만 받으면 = ${nf(totalFilters)} × 32 B = ${mb(cfheadersEst)} MiB — 본체의 ${nf(est / cfheadersEst, 1)}분의 1`);
    out('');
    out('시간 = (요청 수 × RTT) + (총 바이트 ÷ 실측 대역폭)');
    out(`     요청 수 = ceil(${nf(totalFilters)} / 1000) = ${nf(nReq)}회 (getcfilters 1회 상한 1000)`);
    out(`     RTT 실측 = ${nf(rtt, 0)} ms`);
    out(`     대역폭(바이트 가중) = (${nf(A.socketBytes)} + ${nf(B.socketBytes)}) B ÷ (${nf(dlMsA)} + ${nf(dlMsB)}) ms = ${nf(bw / 1_048_576, 2)} MiB/s`);
    out(`       [A 단독 ${nf(bwA / 1_048_576, 2)} MiB/s · B 단독 ${nf(bwB / 1_048_576, 2)} MiB/s]`);
    out(`     = (${nf(nReq)} × ${nf(rtt, 0)} ms) + (${mb(wireEst)} MiB ÷ ${nf(bw / 1_048_576, 2)} MiB/s)`);
    out(`     = ${nf((nReq * rtt) / 1000, 0)} s + ${nf(wireEst / bw, 0)} s = ${nf(timeSec, 0)} s = ${nf(timeSec / 60, 1)} 분 = ${nf(timeSec / 3600, 2)} 시간`);
    out(`교차검산(B 구간 대역폭 ${nf(bwB / 1_048_576, 2)} MiB/s 단독 적용 — 총량의 대부분이 최근 크기대): ${nf(timeSecB, 0)} s = ${nf(timeSecB / 60, 1)} 분 = ${nf(timeSecB / 3600, 2)} 시간`);
    out('');
    out(`헤더 워크 실측 대역폭 ${nf((walk.bytes / walk.ms) * 1000 / 1_048_576, 2)} MiB/s — cfilter 대역폭과 같은 자릿수면 병목은 회선이 아니라 피어의 송출 속도다.`);
    out(`전제: 단일 피어 · 순차 요청 · 이 링크의 실측 RTT/대역폭. 피어 병렬화·다른 회선이면 달라진다.`);
    out('');
    out(`## 5. 소요`);
    out(`이 스크립트 총 소요: ${nf((Date.now() - scriptT0) / 1000, 1)} s`);
    out(`  헤더 워크 ${nf(walk.ms / 1000, 1)} s · 주 구간 2개 ${nf((A.ms + B.ms) / 1000, 1)} s · 표본 ${nf(probes.length)}개 ${nf(probes.reduce((s, p) => s + p.ms, 0) / 1000, 1)} s`);
    out(`총 수신 ${mb(carriedBytesIn + conn.transport.bytesIn)} MiB · 총 송신 ${nf(carriedBytesOut + conn.transport.bytesOut)} B`);
  } finally {
    await conn.transport.close().catch(() => undefined);
  }
}

main().catch((e) => {
  log('FAILED: ' + (e?.stack ?? e));
  process.exitCode = 1;
});
