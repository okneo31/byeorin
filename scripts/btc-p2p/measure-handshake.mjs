// measure-handshake.mjs — 실피어 상대 P2P 핸드셰이크 실측.
//
// 목적: SDK(bip157/p2p.ts) 의 프레이밍·version/verack·ping/pong 함수만으로
// 진짜 비트코인 메인넷 노드와 핸드셰이크가 성립하는지 확인하고, 구간별 시간을 잰다.
//
// 이 스크립트는 바이트를 손으로 짜지 않는다. 인코딩/디코딩은 전부 SDK 산출물
// (packages/wallet-sdk/dist/btc-history.js) 을 호출한다. 여기 있는 코드는
// 소켓 글루(메시지 큐·대기·타이밍 기록)뿐이다.
//
// 사용:
//   node scripts/btc-p2p/measure-handshake.mjs [--peers=16] [--ping-wait-ms=140000] [--ping-wait-peers=3]

import dnsPromises from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import { NodeTcpTransport } from './node-transport.mjs';

import {
  MAINNET_MAGIC,
  P2PFrameDecoder,
  encodeMessage,
  buildVersionPayload,
  parseVersionPayload,
  buildPingPayload,
  parsePingPayload,
  buildPongPayload,
  hasCompactFilters,
  SERVICE_NODE_NETWORK,
  SERVICE_NODE_WITNESS,
  SERVICE_NODE_COMPACT_FILTERS,
} from '../../packages/wallet-sdk/dist/btc-history.js';

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const TARGET_PEERS = Number(argv.peers ?? 16);
const PING_WAIT_MS = Number(argv['ping-wait-ms'] ?? 140_000);
const PING_WAIT_PEERS = Number(argv['ping-wait-peers'] ?? 3);
const CONNECT_TIMEOUT_MS = Number(argv['connect-timeout-ms'] ?? 5000);
const MSG_TIMEOUT_MS = Number(argv['msg-timeout-ms'] ?? 8000);
const CONCURRENCY = Number(argv.concurrency ?? 8);
const PORT = 8333;

// ---------------------------------------------------------------------------
// 피어 주소 — DNS 시드 직접 조회
// ---------------------------------------------------------------------------

// x49 = NODE_NETWORK(1) | NODE_WITNESS(8) | NODE_COMPACT_FILTERS(64) = 0x49.
// 시드가 서비스비트로 걸러 준다 — BIP157 용 피어를 우선 잡기 위함.
const SEEDS = [
  'x49.seed.bitcoin.sipa.be',
  'x49.seed.bitcoin.sprovoost.nl',
  'x49.dnsseed.emzy.de',
  'x49.seed.bitcoin.wiz.biz',
  'x49.seed.btc.petertodd.net',
  'seed.bitcoin.sipa.be',
  'dnsseed.bluematt.me',
  'seed.bitcoinstats.com',
  'seed.bitcoin.jonasschnelli.ch',
  'seed.bitcoin.sprovoost.nl',
  'dnsseed.emzy.de',
  'seed.bitcoin.wiz.biz',
];

async function discoverPeers() {
  const results = await Promise.allSettled(
    SEEDS.map(async (seed) => ({ seed, addrs: await dnsPromises.resolve4(seed) })),
  );
  const seen = new Map(); // ip -> { ip, seeds:[], filterHinted }
  const seedLog = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      seedLog.push({ seed: '(rejected)', ok: false, count: 0, error: String(r.reason?.message ?? r.reason) });
      continue;
    }
    const { seed, addrs } = r.value;
    seedLog.push({ seed, ok: true, count: addrs.length });
    for (const ip of addrs) {
      const e = seen.get(ip) ?? { ip, seeds: [], filterHinted: false };
      e.seeds.push(seed);
      if (seed.startsWith('x49.')) e.filterHinted = true;
      seen.set(ip, e);
    }
  }
  // 필터 힌트 있는 주소를 앞으로.
  const list = [...seen.values()].sort((a, b) => Number(b.filterHinted) - Number(a.filterHinted));
  return { peers: list, seedLog };
}

// ---------------------------------------------------------------------------
// 소켓 글루 — 프레임 디코더에서 나온 메시지를 큐에 넣고 command 로 기다린다.
// 인코딩/디코딩은 전부 SDK.
// ---------------------------------------------------------------------------

class MeasuredPeer {
  constructor(transport, magic) {
    this.transport = transport;
    this.magic = magic;
    this.decoder = new P2PFrameDecoder(magic);
    this.queue = [];
    this.waiter = null;
    this.closedErr = null;
    this.events = []; // { command, t, bytes }
    this.inboundPings = 0;
    this.autoPongs = 0;
    this.autoPongError = null;
    this.decoderError = null;

    transport.onData((chunk) => this.#onChunk(chunk));
    transport.onClose((err) => this.#onClose(err ?? new Error('peer closed connection')));
  }

  #onChunk(chunk) {
    let msgs;
    try {
      msgs = this.decoder.push(chunk); // ← SDK 프레이밍
    } catch (e) {
      this.decoderError = e instanceof Error ? e : new Error(String(e));
      this.#onClose(this.decoderError);
      return;
    }
    for (const msg of msgs) {
      this.events.push({ command: msg.command, t: performance.now(), bytes: msg.payload.length });
      if (msg.command === 'ping') {
        this.inboundPings++;
        // ping → 같은 nonce 로 pong. scan.ts 와 동일하게 SDK 함수만 사용.
        try {
          const nonce = parsePingPayload(msg.payload); // ← SDK
          this.send('pong', buildPongPayload(nonce)) // ← SDK
            .then(() => {
              this.autoPongs++;
            })
            .catch((e) => {
              this.autoPongError = e;
            });
        } catch (e) {
          this.autoPongError = e;
        }
        continue;
      }
      this.queue.push(msg);
      this.#tryDeliver();
    }
  }

  #onClose(err) {
    if (this.closedErr) return;
    this.closedErr = err;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  #tryDeliver() {
    if (!this.waiter) return;
    const idx = this.queue.findIndex((m) => this.waiter.commands.has(m.command));
    if (idx < 0) return;
    const msg = this.queue.splice(idx, 1)[0];
    clearTimeout(this.waiter.timer);
    const w = this.waiter;
    this.waiter = null;
    w.resolve(msg);
  }

  async send(command, payload) {
    await this.transport.send(encodeMessage(command, payload, this.magic)); // ← SDK 프레이밍
  }

  next(commands, timeoutMs) {
    if (this.closedErr) return Promise.reject(this.closedErr);
    if (this.waiter) return Promise.reject(new Error('concurrent next() not supported'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`timeout waiting for [${commands.join(', ')}] after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiter = { commands: new Set(commands), resolve, reject, timer };
      this.#tryDeliver();
    });
  }

  /** 대기 없이, 이미 큐에 든 메시지 중 첫 매칭을 꺼낸다. */
  takeQueued(command) {
    const idx = this.queue.findIndex((m) => m.command === command);
    return idx < 0 ? null : this.queue.splice(idx, 1)[0];
  }

  /** ms 동안 아무것도 안 하고 들어오는 메시지만 받는다 (inbound ping 관찰용). */
  async idle(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }
}

// ---------------------------------------------------------------------------
// 한 피어 핸드셰이크 + 구간 측정
// ---------------------------------------------------------------------------

function svcFlags(services) {
  const names = [];
  if (services & SERVICE_NODE_NETWORK) names.push('NETWORK');
  if (services & 2n) names.push('GETUTXO');
  if (services & 4n) names.push('BLOOM');
  if (services & SERVICE_NODE_WITNESS) names.push('WITNESS');
  if (services & 32n) names.push('XTHIN?');
  if (services & SERVICE_NODE_COMPACT_FILTERS) names.push('COMPACT_FILTERS');
  if (services & 1024n) names.push('NETWORK_LIMITED');
  if (services & 2048n) names.push('P2P_V2');
  const known = 1n | 2n | 4n | 8n | 32n | 64n | 1024n | 2048n;
  const rest = services & ~known;
  if (rest) names.push(`unknown:0x${rest.toString(16)}`);
  return names.join('|') || 'NONE';
}

async function measurePeer(ip, { lingerMs = 3000, pingWaitMs = 0 } = {}) {
  const rec = {
    ip,
    ok: false,
    error: null,
    connectMs: null,
    versionRttMs: null, // 우리 version 송신 → 상대 version 수신
    verackRttMs: null, // 우리 verack 송신 → 상대 verack 수신
    verackPreArrived: false, // 상대 verack 이 우리 verack 송신 전에 이미 도착
    verackFromVersionSendMs: null, // 우리 version 송신 → 상대 verack 수신
    totalMs: null, // 연결 시작 → 핸드셰이크 완료
    pingRttMs: null,
    pingNonceMatch: null,
    inboundPings: 0,
    autoPongs: 0,
    autoPongError: null,
    decoderError: null,
    commands: [],
    remote: null,
  };

  const transport = new NodeTcpTransport();
  const t0 = performance.now();
  try {
    await transport.connect(ip, PORT, { timeoutMs: CONNECT_TIMEOUT_MS });
  } catch (e) {
    rec.error = `connect: ${e.message}`;
    return rec;
  }
  const tConn = performance.now();
  rec.connectMs = +(tConn - t0).toFixed(1);

  const peer = new MeasuredPeer(transport, MAINNET_MAGIC);
  try {
    // --- version 송신 (SDK 페이로드 빌더) ---
    const verPayload = buildVersionPayload({ userAgent: '/byeorin-measure:0.0.1/', relay: false });
    const tVerSent = performance.now();
    await peer.send('version', verPayload);

    const versionMsg = await peer.next(['version'], MSG_TIMEOUT_MS);
    const tVerRecv = performance.now();
    rec.versionRttMs = +(tVerRecv - tVerSent).toFixed(1);

    const remote = parseVersionPayload(versionMsg.payload); // ← SDK 파서
    rec.remote = {
      protocol: remote.version,
      services: '0x' + remote.services.toString(16),
      serviceNames: svcFlags(remote.services),
      compactFilters: hasCompactFilters(remote.services),
      userAgent: remote.userAgent,
      startHeight: remote.startHeight,
      relay: remote.relay,
      timestampSkewSec: Number(remote.timestamp - BigInt(Math.floor(Date.now() / 1000))),
      payloadBytes: versionMsg.payload.length,
    };

    // --- verack ---
    // 상대는 우리 version 을 받자마자 version+verack 을 함께 보내는 경우가 많다.
    // 우리가 verack 을 보내기 전에 이미 도착했는지 먼저 확인한다.
    const preVerack = peer.takeQueued('verack');
    const tVerackSent = performance.now();
    await peer.send('verack', new Uint8Array(0));
    let tVerackRecv;
    if (preVerack) {
      rec.verackPreArrived = true;
      tVerackRecv = peer.events.find((e) => e.command === 'verack').t;
    } else {
      await peer.next(['verack'], MSG_TIMEOUT_MS);
      tVerackRecv = performance.now();
    }
    rec.verackRttMs = +(tVerackRecv - tVerackSent).toFixed(1);
    rec.verackFromVersionSendMs = +(tVerackRecv - tVerSent).toFixed(1);
    rec.totalMs = +(tVerackRecv - t0).toFixed(1);
    rec.ok = true;

    // --- 우리가 보낸 ping 에 대한 pong (SDK ping/pong 빌더·파서) ---
    // ping 을 3번 잰다:
    //   #1 verack 직후(직전 write 와 붙는다) / #2·#3 600ms 유휴 뒤(직전 write 와 떨어진다).
    // #1 만 느리면 원인은 프로토콜이 아니라 소켓의 작은 write 지연(Nagle)이다.
    const pingRtts = [];
    for (let k = 0; k < 3; k++) {
      if (k > 0) await peer.idle(600);
      try {
        const nonce = (BigInt(Math.floor(Math.random() * 0xffffffff)) << 16n) | BigInt(k);
        const tPing = performance.now();
        await peer.send('ping', buildPingPayload(nonce)); // ← SDK
        const pong = await peer.next(['pong'], MSG_TIMEOUT_MS);
        const rtt = +(performance.now() - tPing).toFixed(1);
        pingRtts.push(rtt);
        const match = parsePingPayload(pong.payload) === nonce; // ← SDK
        if (k === 0) {
          rec.pingRttMs = rtt;
          rec.pingNonceMatch = match;
        }
        if (!match) rec.pingNonceMismatchAt = k;
      } catch (e) {
        rec.pingError = rec.pingError ?? `#${k}: ${e.message}`;
        break;
      }
    }
    rec.pingRtt1 = pingRtts[0] ?? null;
    rec.pingRtt2 = pingRtts[1] ?? null;
    rec.pingRtt3 = pingRtts[2] ?? null;

    // --- inbound ping 관찰 (bitcoind 는 대략 2분 주기) ---
    if (pingWaitMs > 0) {
      const deadline = performance.now() + pingWaitMs;
      while (performance.now() < deadline && peer.inboundPings === 0 && !peer.closedErr) {
        await peer.idle(1000);
      }
    } else if (lingerMs > 0) {
      await peer.idle(lingerMs);
    }
  } catch (e) {
    rec.error = rec.error ?? e.message;
  } finally {
    rec.inboundPings = peer.inboundPings;
    rec.autoPongs = peer.autoPongs;
    rec.autoPongError = peer.autoPongError ? String(peer.autoPongError.message ?? peer.autoPongError) : null;
    rec.decoderError = peer.decoderError ? peer.decoderError.message : null;
    rec.commands = [...new Set(peer.events.map((e) => e.command))];
    try {
      await transport.close();
    } catch {
      /* 무시 */
    }
  }
  return rec;
}

// ---------------------------------------------------------------------------
// 통계 · 출력
// ---------------------------------------------------------------------------

function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { n: v.length, min: v[0], median: +median.toFixed(1), max: v[v.length - 1] };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function runPool(items, worker, concurrency) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await worker(items[idx], idx);
      }
    }),
  );
  return out;
}

async function main() {
  const started = performance.now();
  console.log('== DNS 시드 조회 ==');
  const { peers, seedLog } = await discoverPeers();
  for (const s of seedLog) {
    console.log(`  ${pad(s.seed, 34)} ${s.ok ? `${s.count} addr` : `실패: ${s.error}`}`);
  }
  console.log(`  고유 IPv4 후보: ${peers.length}`);
  if (peers.length === 0) {
    console.error('피어 주소를 얻지 못했다. 종료.');
    process.exitCode = 1;
    return;
  }

  // 목표보다 넉넉히 시도 (연결 실패 대비).
  const candidates = peers.slice(0, Math.max(TARGET_PEERS * 3, 30));
  console.log(`\n== 핸드셰이크 시도 (${candidates.length}개, 동시 ${CONCURRENCY}) ==`);
  const results = await runPool(
    candidates,
    async (p) => {
      const r = await measurePeer(p.ip, { lingerMs: 2000 });
      r.filterHinted = p.filterHinted;
      process.stdout.write(
        r.ok
          ? `  OK   ${pad(r.ip, 16)} conn=${pad(r.connectMs, 7)} ver=${pad(r.versionRttMs, 7)} total=${r.totalMs}\n`
          : `  FAIL ${pad(r.ip, 16)} ${r.error}\n`,
      );
      return r;
    },
    CONCURRENCY,
  );

  const ok = results.filter((r) => r.ok);
  console.log(`\n성공 ${ok.length} / 시도 ${results.length}`);

  // --- 구간 통계 ---
  console.log('\n== 구간별 실측 (ms) ==');
  const rows = [
    ['TCP connect', stats(ok.map((r) => r.connectMs))],
    ['version 송신→상대 version 수신', stats(ok.map((r) => r.versionRttMs))],
    ['verack 송신→상대 verack 수신', stats(ok.map((r) => r.verackRttMs))],
    ['version 송신→상대 verack 수신', stats(ok.map((r) => r.verackFromVersionSendMs))],
    ['총 (connect 시작→verack 완료)', stats(ok.map((r) => r.totalMs))],
    ['ping#1→pong (verack 직후)', stats(ok.map((r) => r.pingRtt1))],
    ['ping#2→pong (600ms 유휴 뒤)', stats(ok.map((r) => r.pingRtt2))],
    ['ping#3→pong (600ms 유휴 뒤)', stats(ok.map((r) => r.pingRtt3))],
  ];
  console.log(`  ${pad('구간', 34)}${pad('n', 4)}${pad('min', 10)}${pad('median', 10)}${pad('max', 10)}`);
  for (const [name, s] of rows) {
    console.log(
      `  ${pad(name, 34)}${pad(s?.n ?? 0, 4)}${pad(s?.min ?? '-', 10)}${pad(s?.median ?? '-', 10)}${pad(s?.max ?? '-', 10)}`,
    );
  }
  console.log(
    `  * verack 사전도착(우리 verack 송신 전 이미 수신): ${ok.filter((r) => r.verackPreArrived).length}/${ok.length}`,
  );

  // --- 상대 version 파싱 표 ---
  console.log('\n== 상대 version 페이로드 파싱 ==');
  console.log(
    `  ${pad('peer', 16)}${pad('proto', 7)}${pad('services', 10)}${pad('height', 9)}${pad('cf', 4)}${pad('relay', 7)}${pad('bytes', 7)}user agent`,
  );
  for (const r of ok) {
    const m = r.remote;
    console.log(
      `  ${pad(r.ip, 16)}${pad(m.protocol, 7)}${pad(m.services, 10)}${pad(m.startHeight, 9)}${pad(m.compactFilters ? 'Y' : 'n', 4)}${pad(m.relay ? 'Y' : 'n', 7)}${pad(m.payloadBytes, 7)}${m.userAgent}`,
    );
  }
  console.log('\n  services 플래그 해석:');
  for (const r of ok) console.log(`    ${pad(r.ip, 16)}${r.remote.services}  ${r.remote.serviceNames}`);

  // --- ping/pong ---
  console.log('\n== ping/pong ==');
  console.log(
    `  우리 ping → pong 수신: ${ok.filter((r) => r.pingRttMs != null).length}/${ok.length}, nonce 일치: ${ok.filter((r) => r.pingNonceMatch).length}, nonce 불일치: ${ok.filter((r) => r.pingNonceMismatchAt != null).length}`,
  );
  {
    const c = stats(ok.map((r) => r.connectMs));
    const p1 = stats(ok.map((r) => r.pingRtt1));
    const p3 = stats(ok.map((r) => r.pingRtt3));
    if (c && p1 && p3) {
      console.log(
        `  RTT 배수(중앙값 기준): ping#1/connect=${(p1.median / c.median).toFixed(2)}, ping#3/connect=${(p3.median / c.median).toFixed(2)}`,
      );
    }
  }
  console.log(
    `  (짧은 linger 중) inbound ping: ${ok.reduce((a, r) => a + r.inboundPings, 0)}, 자동 pong 송신: ${ok.reduce((a, r) => a + r.autoPongs, 0)}`,
  );

  // --- 핸드셰이크 후 상대가 보낸 명령 종류 ---
  const cmdCount = new Map();
  for (const r of ok) for (const c of r.commands) cmdCount.set(c, (cmdCount.get(c) ?? 0) + 1);
  console.log('\n== 상대가 보낸 명령 (피어 수) ==');
  for (const [c, n] of [...cmdCount].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(c, 14)}${n}`);

  // --- 실패 사유 ---
  const fails = results.filter((r) => !r.ok);
  if (fails.length) {
    const byReason = new Map();
    for (const f of fails) {
      const key = (f.error ?? 'unknown').replace(/\(.*?\)/, '(...)').slice(0, 70);
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    console.log('\n== 실패 사유 ==');
    for (const [k, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(n, 4)}${k}`);
  }

  // --- inbound ping 장시간 관찰 ---
  if (PING_WAIT_MS > 0 && ok.length > 0) {
    const targets = ok.slice(0, PING_WAIT_PEERS).map((r) => r.ip);
    console.log(`\n== inbound ping 대기 (${targets.join(', ')}, 최대 ${PING_WAIT_MS}ms) ==`);
    const pw = await Promise.all(
      targets.map((ip) => measurePeer(ip, { pingWaitMs: PING_WAIT_MS })),
    );
    for (const r of pw) {
      console.log(
        `  ${pad(r.ip, 16)} ok=${r.ok} inboundPing=${r.inboundPings} autoPong=${r.autoPongs} autoPongError=${r.autoPongError ?? '-'} decoderError=${r.decoderError ?? '-'} err=${r.error ?? '-'}`,
      );
    }
  }

  console.log(`\n총 소요: ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exitCode = 1;
});
