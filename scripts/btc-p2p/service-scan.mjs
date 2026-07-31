// service-scan.mjs — 실피어의 NODE_COMPACT_FILTERS(0x40) 광고 비율 실측.
//
// 왜 필요한가: BIP157 스캔은 0x40 을 광고하는 피어에만 붙는다. 그 비율이
// 실제로 얼마인지 모르면 "피어 몇 개를 시도해야 하나"를 정할 수 없다.
// 이 스크립트는 DNS 시드 → 8333 접속 → version/verack → services 비트만 보고
// 즉시 끊는다. 블록·필터는 요청하지 않는다.
//
// 전송은 공유 모듈(node-transport.mjs), 프로토콜은 SDK 빌드본(dist/btc-history.js).
// 소켓/프레이밍을 새로 쓰지 않는 이유는 측정값이 구현 차이로 흔들리지 않게 하려는 것.
//
// 사용:
//   node scripts/btc-p2p/service-scan.mjs --targets 200 --concurrency 20 \
//        --timeout 8000 --out /tmp/cf-peers.json
//
// 출력: 표준출력에 실측 요약, --out 지정 시 0x40 광고 피어 목록을 JSON 으로 저장.

import dns from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeTcpTransport } from './node-transport.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.resolve(HERE, '../../packages/wallet-sdk/dist/btc-history.js');

const {
  MAINNET_MAGIC,
  P2PFrameDecoder,
  SERVICE_NODE_COMPACT_FILTERS,
  SERVICE_NODE_NETWORK,
  SERVICE_NODE_WITNESS,
  buildVerackMessage,
  buildVersionPayload,
  encodeMessage,
  hasCompactFilters,
  parseVersionPayload,
} = await import(path.sep === '\\' ? `file://${SDK.replace(/\\/g, '/')}` : SDK);

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    targets: 200,
    concurrency: 20,
    timeout: 8000,
    port: 8333,
    out: null,
    seeds: null,
    dnsRounds: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--targets') out.targets = Number(next());
    else if (a === '--concurrency') out.concurrency = Number(next());
    else if (a === '--timeout') out.timeout = Number(next());
    else if (a === '--port') out.port = Number(next());
    else if (a === '--dns-rounds') out.dnsRounds = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--seeds') out.seeds = next().split(',').map((s) => s.trim());
    else if (a === '--help' || a === '-h') {
      console.log(
        'service-scan.mjs [--targets N] [--concurrency N] [--timeout ms] [--port N] [--dns-rounds N] [--out file.json] [--seeds a,b]',
      );
      process.exit(0);
    } else throw new Error(`알 수 없는 인자: ${a}`);
  }
  return out;
}

// Bitcoin Core 의 chainparams.cpp mainnet DNS 시드 (v27 기준).
const DEFAULT_SEEDS = [
  'seed.bitcoin.sipa.be',
  'dnsseed.bluematt.me',
  'dnsseed.bitcoin.dashjr-list-of-p2p-nodes.us',
  'seed.bitcoinstats.com',
  'seed.bitcoin.jonasschnelli.ch',
  'seed.btc.petertodd.net',
  'seed.bitcoin.sprovoost.nl',
  'dnsseed.emzy.de',
  'seed.bitcoin.wiz.biz',
  'seed.mainnet.achownodes.xyz',
];

// ---------------------------------------------------------------------------
// 1) DNS 시드에서 주소 수집
// ---------------------------------------------------------------------------

// DNS 시드는 한 번 조회에 25개 안팎만 돌려주고, 매 조회마다 다른 부분집합을
// 준다. 표본을 키우려면 반복 조회해서 합집합을 쌓는 수밖에 없다.
async function collectFromSeeds(seeds, rounds = 1) {
  const set = new Set();
  const tally = new Map(); // seed → {ok, count, error}
  for (let round = 0; round < rounds; round++) {
    const results = await Promise.allSettled(
      seeds.map(async (s) => ({ seed: s, addrs: await dns.resolve4(s) })),
    );
    for (let i = 0; i < results.length; i++) {
      const seed = seeds[i];
      const cur = tally.get(seed) ?? { seed, ok: false, count: 0 };
      const r = results[i];
      if (r.status === 'fulfilled') {
        for (const a of r.value.addrs) set.add(a);
        cur.ok = true;
        cur.count += r.value.addrs.length;
      } else {
        cur.error = r.reason?.code ?? String(r.reason?.message ?? r.reason);
      }
      tally.set(seed, cur);
    }
  }
  return { addrs: [...set], perSeed: [...tally.values()] };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// 2) 한 피어 프로브: connect → version → (상대 version) → verack → 끊기
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{host,port,connected,handshake,connectMs,handshakeMs,
 *   services?:string, compactFilters?:boolean, userAgent?:string,
 *   protocol?:number, startHeight?:number, stage?:string, error?:string}>}
 */
async function probePeer(host, port, timeoutMs) {
  const t0 = Date.now();
  const rec = {
    host,
    port,
    connected: false,
    handshake: false,
    connectMs: null,
    handshakeMs: null,
  };
  const tr = new NodeTcpTransport();

  try {
    await tr.connect(host, port, { timeoutMs });
  } catch (e) {
    rec.stage = 'connect';
    rec.error = e?.code ?? classify(e);
    return rec;
  }
  rec.connected = true;
  rec.connectMs = Date.now() - t0;

  try {
    const version = await new Promise((resolve, reject) => {
      const dec = new P2PFrameDecoder(MAINNET_MAGIC);
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(
        () => finish(reject, new Error('handshake timeout')),
        timeoutMs,
      );

      tr.onClose((e) =>
        finish(reject, e ?? new Error('peer closed before version')),
      );
      tr.onData((chunk) => {
        let msgs;
        try {
          msgs = dec.push(chunk);
        } catch (e) {
          return finish(reject, e);
        }
        for (const m of msgs) {
          if (m.command !== 'version') continue;
          try {
            return finish(resolve, parseVersionPayload(m.payload));
          } catch (e) {
            return finish(reject, e);
          }
        }
      });

      tr.send(
        encodeMessage(
          'version',
          buildVersionPayload({ services: 0n, relay: false }),
          MAINNET_MAGIC,
        ),
      ).catch((e) => finish(reject, e));
    });

    // 규격 준수: 상대 version 을 받았으면 verack 을 돌려준다. 우리는 상대의
    // verack 을 기다리지 않는다 — services 는 version 에 이미 다 들어 있고,
    // 여기서 더 기다리면 프로브 시간만 늘어난다.
    try {
      await tr.send(buildVerackMessage(MAINNET_MAGIC));
    } catch {
      /* verack 송신 실패는 측정에 영향 없음 */
    }

    rec.handshake = true;
    rec.handshakeMs = Date.now() - t0;
    rec.services = `0x${version.services.toString(16)}`;
    rec.servicesNum = version.services.toString();
    rec.compactFilters = hasCompactFilters(version.services);
    rec.network = (version.services & SERVICE_NODE_NETWORK) !== 0n;
    rec.witness = (version.services & SERVICE_NODE_WITNESS) !== 0n;
    rec.userAgent = version.userAgent;
    rec.protocol = version.version;
    rec.startHeight = version.startHeight;
    return rec;
  } catch (e) {
    rec.stage = 'handshake';
    rec.error = e?.code ?? classify(e);
    return rec;
  } finally {
    try {
      await tr.close();
    } catch {
      /* 이미 끊긴 소켓 */
    }
  }
}

function classify(e) {
  const m = String(e?.message ?? e);
  if (/connect timeout/.test(m)) return 'ETIMEDOUT_CONNECT';
  if (/handshake timeout/.test(m)) return 'ETIMEDOUT_HANDSHAKE';
  if (/closed before version/.test(m)) return 'EARLY_CLOSE';
  if (/bad magic/.test(m)) return 'BAD_MAGIC';
  if (/bad checksum/.test(m)) return 'BAD_CHECKSUM';
  if (/socket closed with error/.test(m)) return 'SOCKET_ERROR';
  return m.slice(0, 60);
}

// ---------------------------------------------------------------------------
// 병렬 풀
// ---------------------------------------------------------------------------

async function runPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runner),
  );
  return out;
}

// ---------------------------------------------------------------------------
// 통계
// ---------------------------------------------------------------------------

function stats(nums) {
  if (nums.length === 0) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return {
    n: s.length,
    min: s[0],
    p50: q(0.5),
    p90: q(0.9),
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

function pct(a, b) {
  return b === 0 ? '0.0%' : `${((a / b) * 100).toFixed(1)}%`;
}

function topCounts(list, n) {
  const m = new Map();
  for (const v of list) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const seeds = args.seeds ?? DEFAULT_SEEDS;

  console.log('== BTC 실피어 서비스 비트 실측 (NODE_COMPACT_FILTERS 0x40) ==');
  console.log(
    `대상 ${args.targets} · 동시 ${args.concurrency} · 타임아웃 ${args.timeout}ms · 포트 ${args.port}`,
  );

  const { addrs, perSeed } = await collectFromSeeds(seeds, args.dnsRounds);
  console.log(`\n[1] DNS 시드 (${args.dnsRounds}회 조회 합집합)`);
  for (const s of perSeed) {
    console.log(
      `  ${s.ok ? 'OK ' : 'FAIL'} ${s.seed} ${s.ok ? `${s.count}개(중복 포함)` : s.error}`,
    );
  }
  console.log(`  고유 주소 ${addrs.length}개`);
  if (addrs.length === 0) {
    console.error('DNS 시드에서 주소를 하나도 얻지 못했다 — 측정 불가.');
    process.exitCode = 2;
    return;
  }

  const targets = shuffle(addrs).slice(0, args.targets);
  console.log(`\n[2] 프로브 ${targets.length}개 시작…`);
  const results = await runPool(targets, args.concurrency, (host) =>
    probePeer(host, args.port, args.timeout),
  );

  const attempted = results.length;
  const connected = results.filter((r) => r.connected);
  const handshook = results.filter((r) => r.handshake);
  const cf = handshook.filter((r) => r.compactFilters);
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

  console.log('\n[3] 실측');
  console.log(`  시도            ${attempted}`);
  console.log(`  TCP 접속 성공   ${connected.length}  (${pct(connected.length, attempted)})`);
  console.log(
    `  핸드셰이크 성공 ${handshook.length}  (시도 대비 ${pct(handshook.length, attempted)} · 접속 대비 ${pct(handshook.length, connected.length)})`,
  );
  console.log(
    `  0x40 광고       ${cf.length}  (핸드셰이크 대비 ${pct(cf.length, handshook.length)} · 시도 대비 ${pct(cf.length, attempted)})`,
  );

  const cs = stats(connected.map((r) => r.connectMs));
  const hs = stats(handshook.map((r) => r.handshakeMs));
  console.log('\n[4] 응답 시간 (ms)');
  if (cs) console.log(`  TCP 접속    min ${cs.min} · 중앙 ${cs.p50} · p90 ${cs.p90} · max ${cs.max} · 평균 ${cs.mean}`);
  if (hs) console.log(`  핸드셰이크  min ${hs.min} · 중앙 ${hs.p50} · p90 ${hs.p90} · max ${hs.max} · 평균 ${hs.mean}`);

  console.log('\n[5] user agent 상위');
  for (const [ua, n] of topCounts(handshook.map((r) => r.userAgent), 12)) {
    console.log(`  ${String(n).padStart(4)}  ${ua}`);
  }

  console.log('\n[6] services 비트맵 상위');
  for (const [sv, n] of topCounts(handshook.map((r) => r.services), 10)) {
    console.log(`  ${String(n).padStart(4)}  ${sv}`);
  }

  const failures = results.filter((r) => !r.handshake);
  console.log(`\n[7] 실패 사유 (${failures.length}건)`);
  for (const [err, n] of topCounts(
    failures.map((r) => `${r.stage}:${r.error}`),
    12,
  )) {
    console.log(`  ${String(n).padStart(4)}  ${err}`);
  }

  // 방화벽 전면 차단 판정: 접속 0 이면 그 사실을 명시한다.
  if (connected.length === 0) {
    console.log(
      '\n[!] TCP 접속이 0건이다 — 아웃바운드 8333 이 막혀 있을 가능성이 크다. 위 오류 코드 분포가 근거.',
    );
  }

  console.log(`\n소요 ${elapsedSec}초`);

  if (args.out) {
    const payload = {
      measuredAt: new Date().toISOString(),
      params: {
        targets: args.targets,
        concurrency: args.concurrency,
        timeoutMs: args.timeout,
        port: args.port,
        dnsRounds: args.dnsRounds,
      },
      seeds: perSeed,
      totals: {
        attempted,
        connected: connected.length,
        handshake: handshook.length,
        compactFilters: cf.length,
        connectMs: cs,
        handshakeMs: hs,
      },
      compactFilterPeers: cf.map((r) => ({
        host: r.host,
        port: r.port,
        services: r.services,
        userAgent: r.userAgent,
        protocol: r.protocol,
        startHeight: r.startHeight,
        connectMs: r.connectMs,
        handshakeMs: r.handshakeMs,
      })),
      failures: topCounts(failures.map((r) => `${r.stage}:${r.error}`), 50).map(
        ([error, count]) => ({ error, count }),
      ),
    };
    await writeFile(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`0x40 피어 ${cf.length}개 → ${args.out}`);
  }
}

await main();
