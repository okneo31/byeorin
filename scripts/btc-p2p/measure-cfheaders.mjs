// measure-cfheaders.mjs — 실피어에서 헤더 체인 + cfheaders 를 실제로 받아 실측한다.
//
// 왜: BIP157 모듈(packages/wallet-sdk/src/btc-history/bip157)의 디코더가 "실제
// 와이어 데이터"를 제대로 파싱하는지, 그리고 헤더/필터헤더 수신이 얼마나 걸리는지는
// 단위테스트로 알 수 없다. 실피어에 붙어 재본다.
//
// 이 스크립트는 측정만 한다. SDK 를 고치지 않는다 — 실패하면 원시 바이트를 찍고 멈춘다.
//
// 흐름:
//   1) DNS 시드(x49 = NODE_NETWORK|WITNESS|COMPACT_FILTERS)에서 후보 IP → 핸드셰이크 성공까지 시도
//   2) 제네시스부터 getheaders 로 헤더 체인 걷기 (요청당 최대 2000) — 요청마다 ms·바이트 기록
//   3) 지정 구간에서 getcfheaders 로 필터헤더 수신 (1000개·2000개) — ms·바이트 기록
//   4) 검증: 헤더 prev 연결·PoW 목표, 필터헤더 체인 연속성, 제네시스 앵커(cfilter→filter_header)
//
// 사용:
//   node scripts/btc-p2p/measure-cfheaders.mjs
//   node scripts/btc-p2p/measure-cfheaders.mjs --host 1.2.3.4 --port 8333
//   node scripts/btc-p2p/measure-cfheaders.mjs --budget-ms 300000 --max-height 400000
//   node scripts/btc-p2p/measure-cfheaders.mjs --no-pow          # PoW 검사 생략
//
// 전송은 ./node-transport.mjs 하나로 고정(부대 간 측정값이 구현 차이로 흔들리지 않게).

import dnsMod from 'node:dns';
import { NodeTcpTransport } from './node-transport.mjs';

const SDK = new URL('../../packages/wallet-sdk/dist/btc-history.js', import.meta.url);
const {
  MAINNET_MAGIC,
  P2PFrameDecoder,
  buildVersionPayload,
  parseVersionPayload,
  hasCompactFilters,
  buildPongPayload,
  parsePingPayload,
  encodeMessage,
  encodeGetHeaders,
  decodeHeadersMessage,
  encodeGetCfHeaders,
  decodeCfHeaders,
  encodeGetCfilters,
  decodeCfilter,
  computeFilterHash,
  computeFilterHeader,
  displayHashToInternal,
  internalHashToDisplay,
  bytesToHex,
  bytesEqual,
  ZERO_HASH,
} = await import(SDK.href);

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    host: null,
    port: 8333,
    budgetMs: 300_000,
    maxHeight: Infinity,
    pow: true,
    timeoutMs: 20_000,
    candidates: 14,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') o.host = argv[++i];
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--budget-ms') o.budgetMs = Number(argv[++i]);
    else if (a === '--max-height') o.maxHeight = Number(argv[++i]);
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else if (a === '--candidates') o.candidates = Number(argv[++i]);
    else if (a === '--no-pow') o.pow = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('node scripts/btc-p2p/measure-cfheaders.mjs [--host IP] [--port 8333]');
  console.log('  [--budget-ms 300000] [--max-height N] [--timeout-ms 20000] [--no-pow]');
  process.exit(0);
}

const now = () => Number(process.hrtime.bigint()) / 1e6; // ms
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const num = (n) => n.toLocaleString('en-US');
const log = (...a) => console.log(...a);

// mainnet 제네시스 (display hex) — 걷기 시작점 locator.
const GENESIS_DISPLAY = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const GENESIS_INTERNAL = displayHashToInternal(GENESIS_DISPLAY);

// ---------------------------------------------------------------------------
// 피어 래퍼 — SDK 의 P2PFrameDecoder 위에 요청/응답 대기만 얹는다.
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
    this.rxBytes = 0; // 소켓에서 실제로 읽은 바이트 (프레임 헤더 포함)
    this.txBytes = 0;
    this.firstByteAt = null; // 마지막 요청 후 첫 바이트 도착 시각
    transport.onData((chunk) => this.#onData(chunk));
    transport.onClose((e) => this.#onClose(e ?? new Error('peer closed connection')));
  }

  #onData(chunk) {
    this.rxBytes += chunk.length;
    if (this.firstByteAt === null) this.firstByteAt = now();
    let msgs;
    try {
      msgs = this.decoder.push(chunk);
    } catch (e) {
      this.#onClose(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const t = now();
    for (const m of msgs) {
      if (m.command === 'ping') {
        void this.send('pong', buildPongPayload(parsePingPayload(m.payload))).catch(() => {});
        continue;
      }
      m.recvAt = t;
      this.queue.push(m);
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
    const i = this.queue.findIndex((m) => this.waiter.commands.has(m.command));
    if (i < 0) return;
    const m = this.queue.splice(i, 1)[0];
    clearTimeout(this.waiter.timer);
    const { resolve } = this.waiter;
    this.waiter = null;
    resolve(m);
  }

  async send(command, payload) {
    const frame = encodeMessage(command, payload, this.magic);
    this.txBytes += frame.length;
    this.firstByteAt = null;
    await this.transport.send(frame);
  }

  next(...commands) {
    if (this.closedErr) return Promise.reject(this.closedErr);
    if (this.waiter) return Promise.reject(new Error('peer: concurrent next()'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`peer: timeout waiting for [${commands.join(', ')}] (${this.timeoutMs}ms)`));
      }, this.timeoutMs);
      this.waiter = { commands: new Set(commands), resolve, reject, timer };
      this.#deliver();
    });
  }

  /** 스캔에 안 쓰는 협상/릴레이 메시지는 큐에 쌓이기만 하므로 주기적으로 비운다. */
  drain(keep = new Set()) {
    this.queue = this.queue.filter((m) => keep.has(m.command));
  }
}

// ---------------------------------------------------------------------------
// 해시 저장소 — 헤더 90만 개를 객체로 들면 메모리가 터진다. 해시(32B)만 청크로 보관.
// ---------------------------------------------------------------------------

class HashStore {
  constructor(chunkCount = 65536) {
    this.chunkCount = chunkCount;
    this.chunks = [];
    this.length = 0;
  }
  push(h) {
    const ci = (this.length / this.chunkCount) | 0;
    if (ci >= this.chunks.length) this.chunks.push(new Uint8Array(this.chunkCount * 32));
    this.chunks[ci].set(h, (this.length % this.chunkCount) * 32);
    this.length++;
  }
  /** 0-based 인덱스 (여기서 index i == 블록 높이 i+1, 제네시스는 저장 안 함). */
  get(i) {
    if (i < 0 || i >= this.length) throw new Error(`HashStore: index ${i} out of range`);
    const ci = (i / this.chunkCount) | 0;
    const off = (i % this.chunkCount) * 32;
    return this.chunks[ci].subarray(off, off + 32);
  }
}

// ---------------------------------------------------------------------------
// PoW 목표 검사 — 디코더가 bits/hash 를 제대로 뽑았는지 확인하는 강한 신호.
// ---------------------------------------------------------------------------

function bitsToTarget(bits) {
  const exp = bits >>> 24;
  const mant = BigInt(bits & 0x00ffffff);
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}

function hashToBigIntBE(internalHash) {
  // internal 은 little-endian 표기 — 수치 비교는 뒤집어서.
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(internalHash[i]);
  return v;
}

// ---------------------------------------------------------------------------
// 피어 선택 + 핸드셰이크
// ---------------------------------------------------------------------------

const SEED_NAMES = [
  'x49.seed.bitcoin.sipa.be',
  'x49.dnsseed.emzy.de',
  'x49.seed.bitcoin.wiz.biz',
  'x49.seed.btc.petertodd.net',
  'x49.seed.bitcoin.sprovoost.nl',
];

async function seedPeers(limit) {
  const out = [];
  for (const name of SEED_NAMES) {
    if (out.length >= limit) break;
    try {
      const r = new dnsMod.promises.Resolver({ timeout: 5000, tries: 1 });
      const ips = await r.resolve4(name);
      for (const ip of ips) if (!out.includes(ip)) out.push(ip);
    } catch (e) {
      log(`  seed ${name}: ${e.code ?? e.message}`);
    }
  }
  return out.slice(0, limit);
}

async function handshake(host, port) {
  const t0 = now();
  const transport = new NodeTcpTransport();
  await transport.connect(host, port, { timeoutMs: 6000 });
  const tConn = now();
  const peer = new Peer(transport, MAINNET_MAGIC, args.timeoutMs);
  await peer.send('version', buildVersionPayload({ relay: false }));
  const vm = await peer.next('version');
  const remote = parseVersionPayload(vm.payload);
  if (!hasCompactFilters(remote.services)) {
    await transport.close().catch(() => {});
    throw new Error(`no NODE_COMPACT_FILTERS (services=0x${remote.services.toString(16)})`);
  }
  await peer.send('verack', new Uint8Array(0));
  await peer.next('verack');
  const tDone = now();
  return {
    transport,
    peer,
    remote,
    connectMs: tConn - t0,
    handshakeMs: tDone - tConn,
    totalMs: tDone - t0,
  };
}

async function pickPeer() {
  const hosts = args.host ? [args.host] : await seedPeers(args.candidates);
  if (hosts.length === 0) throw new Error('no candidate peers (DNS seeds failed)');
  log(`후보 피어 ${hosts.length}개`);
  const failures = [];
  for (const host of hosts) {
    try {
      const r = await handshake(host, args.port);
      log(
        `핸드셰이크 OK  ${host}:${args.port}  connect ${fmt(r.connectMs)}ms · version/verack ${fmt(
          r.handshakeMs,
        )}ms  ua=${r.remote.userAgent} height=${num(r.remote.startHeight)} services=0x${r.remote.services.toString(16)}`,
      );
      return { host, ...r };
    } catch (e) {
      failures.push(`${host}: ${e.message}`);
      log(`  x ${host}: ${e.message}`);
    }
  }
  throw new Error(`모든 후보 실패:\n${failures.join('\n')}`);
}

// ---------------------------------------------------------------------------
// 실패 보고 — 고치지 않는다. 원시 바이트 앞부분과 함께 남긴다.
// ---------------------------------------------------------------------------

const problems = [];
function reportDecodeFailure(where, payload, err, extra = {}) {
  const head = bytesToHex(payload.subarray(0, Math.min(payload.length, 96)));
  problems.push({ where, error: err.message, payloadLen: payload.length, headHex: head, ...extra });
  log(`\n!! 디코드 실패 @ ${where}: ${err.message}`);
  log(`   payload ${payload.length}B, 앞 ${Math.min(payload.length, 96)}B hex:`);
  log(`   ${head}`);
  for (const [k, v] of Object.entries(extra)) log(`   ${k}=${v}`);
}

// ---------------------------------------------------------------------------
// 1) 헤더 체인 걷기
// ---------------------------------------------------------------------------

async function walkHeaders(peer) {
  const hashes = new HashStore(); // index i == height i+1
  const reqs = []; // {startHeight, count, waitMs, decodeMs, bytes}
  let prevHash = GENESIS_INTERNAL;
  let height = 0; // 마지막으로 확인한 높이
  let powFail = 0;
  let linkFail = 0;
  let stopped = 'tip';
  const tWalk0 = now();

  for (;;) {
    if (now() - tWalk0 > args.budgetMs) {
      stopped = 'budget';
      break;
    }
    if (height >= args.maxHeight) {
      stopped = 'max-height';
      break;
    }
    // locator: 현재 tip 만 있으면 선형 진행에 충분 (재조직 처리는 스캔의 몫).
    const locator = [height === 0 ? GENESIS_INTERNAL : hashes.get(height - 1)];
    const t0 = now();
    await peer.send('getheaders', encodeGetHeaders(locator));
    let msg;
    try {
      msg = await peer.next('headers');
    } catch (e) {
      stopped = `error: ${e.message}`;
      break;
    }
    const tRecv = msg.recvAt;
    let headers;
    try {
      headers = decodeHeadersMessage(msg.payload);
    } catch (e) {
      reportDecodeFailure('decodeHeadersMessage', msg.payload, e, {
        requestedAfterHeight: height,
      });
      stopped = 'decode-failure';
      break;
    }
    const tDec = now();
    if (headers.length === 0) {
      stopped = 'tip';
      break;
    }

    const startHeight = height + 1;
    for (const h of headers) {
      if (!bytesEqual(h.prevBlockHash, prevHash)) {
        linkFail++;
        if (linkFail <= 3) {
          log(
            `\n!! prev 연결 끊김 @ height ${height + 1}: prev=${internalHashToDisplay(
              h.prevBlockHash,
            )} expected=${internalHashToDisplay(prevHash)}`,
          );
          problems.push({
            where: 'header prev link',
            height: height + 1,
            got: internalHashToDisplay(h.prevBlockHash),
            expected: internalHashToDisplay(prevHash),
          });
        }
      }
      if (args.pow) {
        if (hashToBigIntBE(h.hash) > bitsToTarget(h.bits)) {
          powFail++;
          if (powFail <= 3) {
            log(
              `\n!! PoW 목표 초과 @ height ${height + 1}: hash=${internalHashToDisplay(
                h.hash,
              )} bits=0x${h.bits.toString(16)}`,
            );
            problems.push({
              where: 'header pow',
              height: height + 1,
              hash: internalHashToDisplay(h.hash),
              bits: `0x${h.bits.toString(16)}`,
              rawHex: bytesToHex(h.raw),
            });
          }
        }
      }
      hashes.push(h.hash);
      prevHash = h.hash;
      height++;
    }

    reqs.push({
      startHeight,
      count: headers.length,
      waitMs: tRecv - t0,
      decodeMs: tDec - tRecv,
      bytes: msg.payload.length + 24,
    });

    if (headers.length < 2000) {
      stopped = 'tip';
      break;
    }
    if ((reqs.length & 15) === 0) {
      process.stderr.write(
        `\r  ...height ${num(height)} · req ${reqs.length} · ${fmt((now() - tWalk0) / 1000)}s   `,
      );
    }
  }
  process.stderr.write('\r' + ' '.repeat(60) + '\r');
  return { hashes, reqs, height, powFail, linkFail, stopped, elapsedMs: now() - tWalk0 };
}

// ---------------------------------------------------------------------------
// 2) cfheaders 구간 측정 + 체인 검증
// ---------------------------------------------------------------------------

/** hashes: HashStore (index i == height i+1). */
function hashAtHeight(hashes, h) {
  if (h === 0) return GENESIS_INTERNAL;
  return hashes.get(h - 1);
}

async function measureCfHeaders(peer, hashes, startHeight, count) {
  const stopHeight = startHeight + count - 1;
  const stopHash = hashAtHeight(hashes, stopHeight);
  const t0 = now();
  await peer.send('getcfheaders', encodeGetCfHeaders(startHeight, stopHash));
  const msg = await peer.next('cfheaders');
  const tRecv = msg.recvAt;
  let cf;
  try {
    cf = decodeCfHeaders(msg.payload);
  } catch (e) {
    reportDecodeFailure('decodeCfHeaders', msg.payload, e, { startHeight, count });
    throw e;
  }
  const tDec = now();
  return {
    startHeight,
    stopHeight,
    requested: count,
    cf,
    waitMs: tRecv - t0,
    decodeMs: tDec - tRecv,
    bytes: msg.payload.length + 24,
    stopHashOk: bytesEqual(cf.stopHash, stopHash),
  };
}

/** filterHashes → filter header 체인 전개. 마지막 헤더 반환. */
function foldFilterHeaders(prev, filterHashes) {
  let acc = prev;
  for (const fh of filterHashes) acc = computeFilterHeader(fh, acc);
  return acc;
}

/** 제네시스 앵커: cfilter(높이 0) → filter_hash → filter_header(prev=0) 가
 *  peer 가 준 height 1 요청의 previousFilterHeader 와 같아야 한다. */
async function genesisAnchor(peer, expectedPrevForHeight1) {
  const t0 = now();
  await peer.send('getcfilters', encodeGetCfilters(0, GENESIS_INTERNAL));
  const msg = await peer.next('cfilter');
  let cfi;
  try {
    cfi = decodeCfilter(msg.payload);
  } catch (e) {
    reportDecodeFailure('decodeCfilter (genesis)', msg.payload, e);
    throw e;
  }
  const fh = computeFilterHash(cfi.filterBytes);
  const header0 = computeFilterHeader(fh, ZERO_HASH);
  return {
    ms: msg.recvAt - t0,
    filterBytes: cfi.filterBytes.length,
    blockHashOk: bytesEqual(cfi.blockHash, GENESIS_INTERNAL),
    filterHeader0: internalHashToDisplay(header0),
    ok: bytesEqual(header0, expectedPrevForHeight1),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const started = now();
  const picked = await pickPeer();
  const { peer, transport, remote } = picked;

  try {
    // --- 헤더 걷기 -------------------------------------------------------
    log(
      `\n[1] 헤더 체인 걷기 (제네시스부터, 예산 ${num(args.budgetMs)}ms, 상한 ${
        args.maxHeight === Infinity ? '없음' : num(args.maxHeight)
      })`,
    );
    const walk = await walkHeaders(peer);
    log(
      `  도달 높이 ${num(walk.height)} / 피어 tip ${num(remote.startHeight)} · 요청 ${
        walk.reqs.length
      }회 · ${fmt(walk.elapsedMs / 1000)}s · 종료사유=${walk.stopped}`,
    );

    // 밴드별 집계 (10만 높이 단위)
    const BAND = 100_000;
    const bands = new Map();
    let totalBytes = 0;
    let totalWait = 0;
    let totalDecode = 0;
    let totalHeaders = 0;
    for (const r of walk.reqs) {
      const b = Math.floor(r.startHeight / BAND) * BAND;
      const e = bands.get(b) ?? { reqs: 0, headers: 0, wait: 0, decode: 0, bytes: 0 };
      e.reqs++;
      e.headers += r.count;
      e.wait += r.waitMs;
      e.decode += r.decodeMs;
      e.bytes += r.bytes;
      bands.set(b, e);
      totalBytes += r.bytes;
      totalWait += r.waitMs;
      totalDecode += r.decodeMs;
      totalHeaders += r.count;
    }

    log('\n  [헤더 실측] 밴드(10만 높이)별');
    log(
      '  ' +
        '높이대'.padEnd(16) +
        'req'.padStart(5) +
        'headers'.padStart(10) +
        'wait ms/req'.padStart(13) +
        'decode ms/req'.padStart(15) +
        'KB/req'.padStart(9) +
        'B/header'.padStart(10) +
        'headers/s'.padStart(11),
    );
    for (const [b, e] of [...bands.entries()].sort((x, y) => x[0] - y[0])) {
      const totMs = e.wait + e.decode;
      log(
        '  ' +
          `${num(b)}~`.padEnd(16) +
          String(e.reqs).padStart(5) +
          num(e.headers).padStart(10) +
          fmt(e.wait / e.reqs).padStart(13) +
          fmt(e.decode / e.reqs, 2).padStart(15) +
          fmt(e.bytes / e.reqs / 1024).padStart(9) +
          fmt(e.bytes / e.headers, 2).padStart(10) +
          num(Math.round((e.headers / totMs) * 1000)).padStart(11),
      );
    }
    const walkTot = totalWait + totalDecode;
    log(
      `  합계: 헤더 ${num(totalHeaders)}개 · ${fmt(totalBytes / 1024 / 1024, 2)}MB · wait ${fmt(
        totalWait / 1000,
      )}s · decode ${fmt(totalDecode / 1000)}s · ${num(
        Math.round((totalHeaders / walkTot) * 1000),
      )} headers/s (요청·디코드 시간 기준)`,
    );
    log(
      `  검증: prev 연결 끊김 ${walk.linkFail}건 · PoW 목표 초과 ${
        args.pow ? walk.powFail + '건' : '(생략)'
      }`,
    );
    if (walk.height > 0) {
      log(`  tip 해시 @${num(walk.height)} = ${internalHashToDisplay(hashAtHeight(walk.hashes, walk.height))}`);
    }

    if (walk.height < 2001) {
      log('\n헤더가 2001개 미만 — cfheaders 구간 측정을 건너뛴다.');
      return;
    }

    // --- cfheaders 구간 측정 --------------------------------------------
    // 각 구간에서 1000개 요청 2회 연속 → 두 번째의 previousFilterHeader 가
    // 첫 번째로부터 전개한 마지막 filter header 와 같아야 한다(SDK 체인 함수 검증).
    // 이어서 같은 구간을 2000개(BIP157 상한) 한 번에 요청해 비교한다.
    const maxStart = walk.height - 2000 + 1;
    const wanted = [1, 100_001, 300_001, 500_001, 700_001, maxStart];
    const sampleStarts = [...new Set(wanted.filter((h) => h >= 1 && h <= maxStart))].sort(
      (a, b) => a - b,
    );

    log(`\n[2] cfheaders 실측 — 구간 ${sampleStarts.map(num).join(', ')}`);
    log(
      '  ' +
        '시작높이'.padEnd(14) +
        'n'.padStart(6) +
        'wait ms'.padStart(10) +
        'decode ms'.padStart(11) +
        'KB'.padStart(9) +
        'B/hdr'.padStart(8) +
        'hdrs/s'.padStart(10) +
        '  체인검증',
    );

    const cfRows = [];
    let anchor = null;
    for (const start of sampleStarts) {
      let a, b2, big;
      try {
        a = await measureCfHeaders(peer, walk.hashes, start, 1000);
        b2 = await measureCfHeaders(peer, walk.hashes, start + 1000, 1000);
        big = await measureCfHeaders(peer, walk.hashes, start, 2000);
      } catch (e) {
        log(`  ${num(start)}: 실패 — ${e.message}`);
        problems.push({ where: `cfheaders start=${start}`, error: e.message });
        continue;
      }

      const checks = [];
      for (const [label, m, expect] of [
        ['1000#1', a, 1000],
        ['1000#2', b2, 1000],
        ['2000', big, 2000],
      ]) {
        if (m.cf.filterType !== 0) checks.push(`${label}:filterType=${m.cf.filterType}`);
        if (!m.stopHashOk) checks.push(`${label}:stopHash≠요청`);
        if (m.cf.filterHashes.length !== expect)
          checks.push(`${label}:count=${m.cf.filterHashes.length}≠${expect}`);
      }
      // 연속성: a 를 전개한 끝 == b2 의 previousFilterHeader
      const endA = foldFilterHeaders(a.cf.previousFilterHeader, a.cf.filterHashes);
      const contiguous = bytesEqual(endA, b2.cf.previousFilterHeader);
      if (!contiguous) checks.push('연속성 실패(1000#1 끝 ≠ 1000#2 prev)');
      // 2000 요청의 filter_hash 앞 1000개가 a 와 동일해야 한다
      let sameAsBig = big.cf.filterHashes.length >= 1000;
      for (let i = 0; sameAsBig && i < 1000; i++) {
        if (!bytesEqual(big.cf.filterHashes[i], a.cf.filterHashes[i])) sameAsBig = false;
      }
      if (!sameAsBig) checks.push('2000요청 앞 1000개 ≠ 1000요청');
      if (!bytesEqual(big.cf.previousFilterHeader, a.cf.previousFilterHeader))
        checks.push('2000요청 prev ≠ 1000요청 prev');

      if (start === 1) {
        try {
          anchor = await genesisAnchor(peer, a.cf.previousFilterHeader);
          if (!anchor.ok) checks.push('제네시스 앵커 불일치');
          if (!anchor.blockHashOk) checks.push('제네시스 cfilter blockHash 불일치');
        } catch (e) {
          checks.push(`제네시스 앵커 실패: ${e.message}`);
        }
      }

      for (const [label, m] of [
        ['1000#1', a],
        ['1000#2', b2],
        ['2000  ', big],
      ]) {
        const n = m.cf.filterHashes.length;
        const tot = m.waitMs + m.decodeMs;
        log(
          '  ' +
            `${num(m.startHeight)} ${label}`.padEnd(14) +
            num(n).padStart(6) +
            fmt(m.waitMs).padStart(10) +
            fmt(m.decodeMs, 2).padStart(11) +
            fmt(m.bytes / 1024, 1).padStart(9) +
            fmt(m.bytes / Math.max(n, 1), 1).padStart(8) +
            num(Math.round((n / tot) * 1000)).padStart(10),
        );
        cfRows.push({
          startHeight: m.startHeight,
          label: label.trim(),
          n,
          waitMs: m.waitMs,
          decodeMs: m.decodeMs,
          bytes: m.bytes,
        });
      }
      log(
        `     체인검증: ${checks.length === 0 ? 'PASS (연속성·stopHash·개수·2000/1000 일치)' : 'FAIL — ' + checks.join(' / ')}`,
      );
      log(
        `     prev=${internalHashToDisplay(a.cf.previousFilterHeader).slice(0, 24)}… → end@${num(
          b2.stopHeight,
        )}=${internalHashToDisplay(foldFilterHeaders(b2.cf.previousFilterHeader, b2.cf.filterHashes)).slice(0, 24)}…`,
      );
      if (checks.length > 0) problems.push({ where: `cfheaders start=${start}`, checks });
    }

    if (anchor) {
      log(
        `\n  제네시스 앵커: cfilter(0) ${anchor.filterBytes}B, ${fmt(anchor.ms)}ms → filter_header(0)=${
          anchor.filterHeader0
        }`,
      );
      log(
        `    height 1 요청의 previousFilterHeader 와 ${anchor.ok ? '일치 (PASS)' : '불일치 (FAIL)'}`,
      );
    }

    // --- 요약 ------------------------------------------------------------
    log('\n[3] 요약');
    log(`  피어 ${picked.host}:${args.port} (${remote.userAgent}, tip ${num(remote.startHeight)})`);
    log(
      `  헤더 ${num(totalHeaders)}개 수신 · ${fmt(totalBytes / 1024 / 1024, 2)}MB · 전체 ${fmt(
        walk.elapsedMs / 1000,
      )}s`,
    );
    const cf1000 = cfRows.filter((r) => r.n === 1000);
    if (cf1000.length > 0) {
      const w = cf1000.reduce((s, r) => s + r.waitMs, 0) / cf1000.length;
      const d = cf1000.reduce((s, r) => s + r.decodeMs, 0) / cf1000.length;
      const by = cf1000.reduce((s, r) => s + r.bytes, 0) / cf1000.length;
      log(
        `  cfheaders 1000개 평균: wait ${fmt(w)}ms · decode ${fmt(d, 2)}ms · ${fmt(
          by / 1024,
        )}KB · ${num(Math.round((1000 / (w + d)) * 1000))} hdrs/s`,
      );
    }
    log(`  소켓 수신 ${fmt(peer.rxBytes / 1024 / 1024, 2)}MB · 송신 ${num(peer.txBytes)}B`);
    log(`  발견 문제 ${problems.length}건${problems.length ? ':' : ' (없음)'}`);
    for (const p of problems) log('   - ' + JSON.stringify(p));
    log(`  총 소요 ${fmt((now() - started) / 1000)}s`);
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('\nFATAL:', e.stack ?? e.message);
  process.exitCode = 1;
});
