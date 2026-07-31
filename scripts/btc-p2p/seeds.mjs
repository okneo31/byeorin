// seeds.mjs — 비트코인 mainnet DNS 시드에서 피어 주소를 수집한다.
//
// 왜 필요한가: BIP157 실피어 시험은 "붙을 주소"가 있어야 시작된다. 하드코딩한
// 주소 목록은 몇 주면 썩는다 — Bitcoin Core 와 같은 방식(DNS 시드 A/AAAA 조회)
// 으로 매번 새로 받는다.
//
// 이 파일은 DNS 만 쓴다. P2P 소켓은 열지 않는다. 소켓이 필요한 부대는
// ./node-transport.mjs 의 NodeTcpTransport 를 쓴다(전송 구현은 하나로 고정).
//
// 사용:
//   node scripts/btc-p2p/seeds.mjs                      # JSON 을 stdout 으로
//   node scripts/btc-p2p/seeds.mjs --out peers.json     # 파일로도 저장
//   node scripts/btc-p2p/seeds.mjs --report             # 시드별 실측표를 stderr 로
//   node scripts/btc-p2p/seeds.mjs --v4-only --timeout 4000
//
// 모듈:
//   import { SEEDS, MAINNET_PORT, resolveSeed, collectPeers } from './seeds.mjs';

import dns from 'node:dns';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const MAINNET_PORT = 8333;

/**
 * Bitcoin Core 27.x chainparams.cpp 의 mainnet DNS 시드 목록.
 * filter: 서비스 비트 필터 prefix(x<hex>) 를 붙일 수 있는 시드인지 여부.
 *   x9   = NODE_NETWORK(1) | NODE_WITNESS(8)
 *   x49  = 위 + NODE_COMPACT_FILTERS(0x40)  ← BIP157 에 필요한 조합
 */
export const SEEDS = [
  { host: 'seed.bitcoin.sipa.be', filter: true, operator: 'Pieter Wuille' },
  { host: 'dnsseed.bluematt.me', filter: true, operator: 'Matt Corallo' },
  { host: 'seed.bitcoinstats.com', filter: true, operator: 'Christian Decker' },
  { host: 'seed.bitcoin.jonasschnelli.ch', filter: true, operator: 'Jonas Schnelli' },
  { host: 'seed.btc.petertodd.net', filter: true, operator: 'Peter Todd' },
  { host: 'seed.bitcoin.sprovoost.nl', filter: true, operator: 'Sjors Provoost' },
  { host: 'dnsseed.emzy.de', filter: true, operator: 'Stephan Oeste' },
  { host: 'seed.bitcoin.wiz.biz', filter: true, operator: 'Jason Maurice' },
  { host: 'seed.mainnet.achownodes.xyz', filter: true, operator: 'Ava Chow' },
];

/** BIP157 compact filter 를 서비스하는 피어만 뽑는 prefix. */
export const FILTER_PREFIX_CF = 'x49';
/** 기본 full-node + witness prefix. */
export const FILTER_PREFIX_BASE = 'x9';

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, 소수점 3자리

/**
 * Resolver 인스턴스는 재사용한다.
 *
 * 왜: c-ares 는 서버 목록을 순서대로 시도하고, 죽은 서버를 만나면 timeout 만큼
 * 기다린 뒤 다음 서버로 넘어간다. 성공한 서버는 그 인스턴스가 기억한다.
 * 이름마다 새 Resolver 를 만들면 그 "죽은 서버 대기"를 매번 새로 문다 —
 * 실측에서 이름당 +5s 가 붙었다. 인스턴스를 공유하면 한 번만 문다.
 */
export function makeResolver({ timeoutMs = 8000, servers = null } = {}) {
  const r = new dns.promises.Resolver({ timeout: timeoutMs, tries: 2 });
  if (servers?.length) r.setServers(servers);
  return r;
}

let defaultResolver = null;
function sharedResolver(timeoutMs) {
  if (!defaultResolver) defaultResolver = makeResolver({ timeoutMs });
  return defaultResolver;
}

/**
 * 한 이름에 대해 A/AAAA 를 조회한다.
 * @returns {Promise<{name:string, ok:boolean, code?:string, v4:string[], v6:string[], ms:number}>}
 */
export async function resolveName(name, { timeoutMs = 8000, v4 = true, v6 = true, resolver = null } = {}) {
  const r = resolver ?? sharedResolver(timeoutMs);
  const t0 = now();
  const jobs = [];
  if (v4) jobs.push(r.resolve4(name).catch((e) => ({ __err: e })));
  if (v6) jobs.push(r.resolve6(name).catch((e) => ({ __err: e })));
  const results = await Promise.all(jobs);
  const ms = Math.round((now() - t0) * 1000) / 1000;

  const addrs4 = v4 && Array.isArray(results[0]) ? results[0] : [];
  const idx6 = v4 ? 1 : 0;
  const addrs6 = v6 && Array.isArray(results[idx6]) ? results[idx6] : [];

  const errs = results.filter((r) => r && r.__err).map((r) => r.__err.code || r.__err.message);
  const ok = addrs4.length + addrs6.length > 0;
  return { name, ok, code: ok ? undefined : errs.join(','), v4: addrs4, v6: addrs6, ms, errs };
}

/**
 * 시드 하나를 조회한다. prefix 가 주어지면 "<prefix>.<host>" 를 먼저 시도하고,
 * 실패하면 prefix 없는 이름으로 되돌린다(fallback).
 */
export async function resolveSeed(seed, { prefix = null, timeoutMs = 8000, v4 = true, v6 = true, resolver = null } = {}) {
  const base = typeof seed === 'string' ? { host: seed, filter: true } : seed;
  const attempts = [];

  if (prefix && base.filter) {
    const filtered = await resolveName(`${prefix}.${base.host}`, { timeoutMs, v4, v6, resolver });
    attempts.push({ ...filtered, kind: 'filtered', prefix });
    if (filtered.ok) {
      return { seed: base.host, used: 'filtered', prefix, attempts, ...pick(filtered) };
    }
  }

  const plain = await resolveName(base.host, { timeoutMs, v4, v6, resolver });
  attempts.push({ ...plain, kind: 'plain' });
  return { seed: base.host, used: plain.ok ? 'plain' : 'none', prefix, attempts, ...pick(plain) };
}

function pick(r) {
  return { ok: r.ok, code: r.code, v4: r.v4, v6: r.v6, ms: r.ms };
}

/** [::1] 처럼 대괄호를 붙일지 판단 — v6 리터럴만 감싼다. */
export function formatHost(addr) {
  return addr.includes(':') ? `[${addr}]` : addr;
}

/**
 * 모든 시드를 병렬 조회하고 중복 제거된 피어 목록을 만든다.
 * @returns {Promise<{peers:{host:string,port:number}[], report:object[], uniqueCount:number, totalMs:number}>}
 */
export async function collectPeers({
  seeds = SEEDS,
  prefix = FILTER_PREFIX_CF,
  timeoutMs = 8000,
  v4 = true,
  v6 = true,
  port = MAINNET_PORT,
  servers = null,
  warmup = true,
} = {}) {
  const resolver = makeResolver({ timeoutMs, servers });
  // 죽은 DNS 서버 대기(환경에 따라 수 초)를 시드 측정값에 섞지 않는다.
  let warmupMs = 0;
  if (warmup) {
    const w0 = now();
    await resolver.resolve4('one.one.one.one').catch(() => {});
    warmupMs = Math.round((now() - w0) * 1000) / 1000;
  }

  const t0 = now();
  const results = await Promise.all(
    seeds.map((s) => resolveSeed(s, { prefix, timeoutMs, v4, v6, resolver })),
  );
  const totalMs = Math.round((now() - t0) * 1000) / 1000;

  const seen = new Set();
  const peers = [];
  const report = [];

  for (const r of results) {
    const addrs = [...r.v4, ...r.v6];
    let fresh = 0;
    for (const a of addrs) {
      const key = `${a}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh += 1;
      peers.push({ host: a, port, family: a.includes(':') ? 6 : 4, seed: r.seed });
    }
    report.push({
      seed: r.seed,
      responded: r.ok,
      used: r.used,
      prefix: r.used === 'filtered' ? r.prefix : null,
      v4: r.v4.length,
      v6: r.v6.length,
      total: addrs.length,
      unique_new: fresh,
      ms: r.ms,
      error: r.code ?? null,
      attempts: r.attempts.map((a) => ({
        name: a.kind === 'filtered' ? `${a.prefix}.${r.seed}` : r.seed,
        ok: a.ok,
        v4: a.v4.length,
        v6: a.v6.length,
        ms: a.ms,
        errs: a.errs,
      })),
    });
  }

  return { peers, report, uniqueCount: peers.length, totalMs, warmupMs, servers: resolver.getServers() };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = { out: null, prefix: FILTER_PREFIX_CF, timeoutMs: 8000, v4: true, v6: true, report: false, servers: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a === '--prefix') o.prefix = argv[++i];
    else if (a.startsWith('--prefix=')) o.prefix = a.slice(9);
    else if (a === '--no-prefix') o.prefix = null;
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]);
    else if (a.startsWith('--timeout=')) o.timeoutMs = Number(a.slice(10));
    else if (a === '--v4-only') o.v6 = false;
    else if (a === '--v6-only') o.v4 = false;
    else if (a === '--report') o.report = true;
    else if (a === '--dns-server') o.servers = String(argv[++i]).split(',');
    else if (a.startsWith('--dns-server=')) o.servers = a.slice(13).split(',');
    else if (a === '--no-warmup') o.warmup = false;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const HELP = `seeds.mjs — 비트코인 mainnet DNS 시드 → 피어 주소 목록

  --out <file>      결과 JSON 을 파일로도 저장
  --prefix <x49>    서비스 비트 필터 prefix (기본 x49 = NETWORK|WITNESS|COMPACT_FILTERS)
  --no-prefix       필터 없이 평이름만 조회
  --timeout <ms>    DNS 조회 타임아웃 (기본 8000)
  --v4-only         A 레코드만
  --v6-only         AAAA 레코드만
  --report          시드별 실측표를 stderr 로 출력
  --dns-server a,b  사용할 DNS 서버 지정 (기본: 시스템 설정)
  --no-warmup       예열 조회 생략 (첫 시드가 서버 탐색 비용을 뒤집어쓴다)
`;

function renderTable(report) {
  const rows = report.map((r) => ({
    seed: r.seed,
    resp: r.responded ? 'Y' : 'N',
    used: r.used,
    v4: String(r.v4),
    v6: String(r.v6),
    total: String(r.total),
    'new': String(r.unique_new),
    ms: String(r.ms),
    error: r.error ?? '',
  }));
  const cols = ['seed', 'resp', 'used', 'v4', 'v6', 'total', 'new', 'ms', 'error'];
  const w = {};
  for (const c of cols) w[c] = Math.max(c.length, ...rows.map((r) => r[c].length));
  const line = (r) => cols.map((c) => String(r[c]).padEnd(w[c])).join('  ');
  const head = line(Object.fromEntries(cols.map((c) => [c, c])));
  const sep = cols.map((c) => '-'.repeat(w[c])).join('  ');
  return [head, sep, ...rows.map(line)].join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stderr.write(HELP);
    return;
  }

  const { peers, report, uniqueCount, totalMs, warmupMs, servers } = await collectPeers({
    prefix: opts.prefix,
    timeoutMs: opts.timeoutMs,
    v4: opts.v4,
    v6: opts.v6,
    servers: opts.servers,
    warmup: opts.warmup !== false,
  });

  const payload = {
    network: 'bitcoin-mainnet',
    port: MAINNET_PORT,
    prefix: opts.prefix,
    collected_at: new Date().toISOString(),
    unique_count: uniqueCount,
    total_ms: totalMs,
    warmup_ms: warmupMs,
    dns_servers: servers,
    seeds: report,
    peers,
  };

  if (opts.report) {
    process.stderr.write(`${renderTable(report)}\n`);
    process.stderr.write(
      `\nunique peers: ${uniqueCount}  |  wall: ${totalMs} ms  |  warmup: ${warmupMs} ms  |  dns: ${servers.join(',')}\n`,
    );
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  if (opts.out) {
    await writeFile(opts.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    process.stderr.write(`wrote ${opts.out}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(`${e?.stack || e}\n`);
    process.exit(1);
  });
}
