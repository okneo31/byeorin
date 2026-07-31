// profile-scan.mjs — BIP158 GCS 필터 디코드·매칭의 로컬 처리량·메모리 실측.
//
// 목적: "모바일에서 감당 가능한가"를 수치로 답한다. 네트워크 없음 — 순수 CPU/메모리.
//
// 측정 대상 (모두 packages/wallet-sdk/dist/btc-history.js = src/btc-history/bip157 빌드본):
//   1. siphash24        — 항목 하나 해시
//   2. hashToRange      — siphash + 128비트 곱/시프트 (gcsMatchAny 내부)
//   3. decodeGcsFilterValues — 필터 전체 디코드
//   4. gcsMatchAny      — 실제 스캔 경로 (타깃 해시 + 정렬 + 병합 순회)
//
// 필터 재료:
//   - 공식 벡터: BIP158 bip-0158/testnet-19.json 의 필터 3개 (정확성 확인용, 크기 작음)
//   - 합성 대형 필터: encodeGcsFilter 로 N=1000..20000 생성.
//     encodeGcsFilter 는 공식 벡터 바이트를 그대로 재현한다는 게 테스트로 검증돼 있으므로
//     (tests/btc-bip157.test.ts), 합성 필터의 비트 구조는 실제 필터와 통계적으로 동일하다.
//
// 실행:
//   node scripts/btc-p2p/profile-scan.mjs
//   node --expose-gc scripts/btc-p2p/profile-scan.mjs   (메모리 수치 정확도 ↑)
//
// 규칙: 읽기 전용. 파일·네트워크 쓰기 없음.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import inspector from 'node:inspector';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK_DIST = path.resolve(HERE, '../../packages/wallet-sdk/dist/btc-history.js');

const sdk = await import(pathToFileURL(SDK_DIST).href);
const {
  siphash24,
  encodeGcsFilter,
  decodeGcsFilterValues,
  gcsMatchAny,
  filterKeyFromBlockHash,
  displayHashToInternal,
  hexToBytes,
  bytesToHex,
  GCS_P,
  GCS_M,
} = sdk;

// ---------------------------------------------------------------------------
// 결정적 난수 (xorshift128) — 재현 가능한 합성 데이터
// ---------------------------------------------------------------------------

function makeRng(seed = 0x9e3779b9) {
  let x = seed >>> 0 || 1;
  let y = 0x243f6a88;
  let z = 0xb7e15162;
  let w = 0x85ebca6b;
  return () => {
    const t = x ^ (x << 11);
    x = y; y = z; z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w;
  };
}

function randBytes(rng, n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = rng() & 0xff;
  return b;
}

/** 실제 스크립트 길이 분포 흉내: P2PKH 25B / P2WPKH 22B / P2WSH 34B / P2SH 23B / P2TR 34B */
const SCRIPT_LENS = [25, 22, 34, 23, 34, 25, 22, 34];
function randScript(rng) {
  return randBytes(rng, SCRIPT_LENS[rng() % SCRIPT_LENS.length]);
}

function makeScripts(count, seed) {
  const rng = makeRng(seed);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = randScript(rng);
  return out;
}

// ---------------------------------------------------------------------------
// 시간 측정 도우미
// ---------------------------------------------------------------------------

const now = () => Number(process.hrtime.bigint()) / 1e6; // ms

/** 최소 minMs 동안 반복. 반환 = { iters, ms, perIterUs, perSec } */
function bench(fn, { minMs = 400, minIters = 3, warmup = true } = {}) {
  if (warmup) for (let i = 0; i < Math.max(1, Math.min(minIters, 3)); i++) fn();
  let iters = 0;
  const t0 = now();
  let t1 = t0;
  do {
    fn();
    iters++;
    t1 = now();
  } while (t1 - t0 < minMs || iters < minIters);
  const ms = t1 - t0;
  return { iters, ms, perIterUs: (ms * 1000) / iters, perSec: iters / (ms / 1000) };
}

const fmt = (n, d = 2) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

function table(rows, headers) {
  const cols = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const line = (cells, pad = ' ') =>
    '| ' + cells.map((c, i) => String(c).padStart(widths[i], pad)).join(' | ') + ' |';
  const out = [line(headers)];
  out.push('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
  for (const r of rows) out.push(line(r));
  for (let i = 0; i < cols; i++) void i;
  return out.join('\n');
}

function section(title) {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
}

// ---------------------------------------------------------------------------
// 0. 정확성 스모크 — 공식 벡터 (bip-0158/testnet-19.json 발췌)
//    필터 바이트·블록해시만 사용 (블록 원문은 이 벤치에 불필요).
// ---------------------------------------------------------------------------

const OFFICIAL = [
  {
    height: 49291,
    blockHash: '0000000018b07dca1b28b4b5a119f6d6e71698ce1ed96f143f54179ce177a19c',
    filter: '0afbc2920af1b027f31f87b592276eb4c32094bb4d3697021b4c6380',
    member: '76a9149144761ebaccd5b4bbdc2a35453585b5637b2f8588ac',
  },
  {
    height: 1263442,
    blockHash: '000000006f27ddfe1dd680044a34548f41bed47eba9e6f0b310da21423bc5f33',
    filter: '0385acb4f0fe889ef0',
    member: '002027a5000c7917f785d8fc6e5a55adfca8717ecb973ebb7743849ff956d896a7ed',
  },
  {
    height: 987876,
    blockHash: '0000000000000c00901f2049055e2a437c819d79a3d54fd63e6af796cd7b8a79',
    filter: '010c0b40',
    member: '76a914c486de584a735ec2f22da7cd9681614681f92173d83d0aa68688ac',
  },
];

function smokeTest() {
  const foreign = hexToBytes('76a914deadbeefdeadbeefdeadbeefdeadbeefdeadbeef88ac');
  const results = [];
  for (const v of OFFICIAL) {
    const key = filterKeyFromBlockHash(displayHashToInternal(v.blockHash));
    const f = hexToBytes(v.filter);
    const { n } = decodeGcsFilterValues(f);
    const hit = gcsMatchAny(f, key, [hexToBytes(v.member)]);
    const miss = gcsMatchAny(f, key, [foreign]);
    results.push([v.height, n, f.length, hit ? 'true' : 'FALSE!', miss ? 'TRUE!' : 'false']);
  }
  console.log(table(results, ['height', 'N', 'bytes', 'member hit', 'foreign hit']));
}

// ---------------------------------------------------------------------------
// 1. SipHash / hashToRange 단독 처리량
// ---------------------------------------------------------------------------

function benchSipHash() {
  const key = randBytes(makeRng(1), 16);
  const rows = [];
  for (const len of [22, 25, 34, 64]) {
    const items = [];
    const rng = makeRng(len * 7 + 3);
    for (let i = 0; i < 1000; i++) items.push(randBytes(rng, len));
    const r = bench(() => {
      let acc = 0n;
      for (let i = 0; i < items.length; i++) acc ^= siphash24(key, items[i]);
      if (acc === 123456789n) console.log('never');
    });
    const perHashNs = (r.ms * 1e6) / (r.iters * 1000);
    rows.push([
      `${len} B`,
      fmt(perHashNs, 0),
      fmtInt(1e9 / perHashNs),
      fmt((len * 1e9) / perHashNs / 1e6, 1),
    ]);
  }
  console.log(table(rows, ['item size', 'ns/hash', 'hashes/sec', 'MB/s']));
  return rows;
}

function benchHashToRange() {
  // hashToRange 는 export 되어 있으면 그대로, 아니면 동등 식으로 (siphash*f)>>64.
  const key = randBytes(makeRng(2), 16);
  const f = BigInt(5000) * BigInt(GCS_M);
  const items = makeScripts(1000, 42);
  const hr = sdk.hashToRange ?? ((it, ff, k) => (siphash24(k, it) * ff) >> 64n);
  const r = bench(() => {
    let acc = 0n;
    for (let i = 0; i < items.length; i++) acc ^= hr(items[i], f, key);
    if (acc === 1n) console.log('never');
  });
  const perNs = (r.ms * 1e6) / (r.iters * 1000);
  console.log(`hashToRange: ${fmt(perNs, 0)} ns/item, ${fmtInt(1e9 / perNs)} items/sec`);
  return perNs;
}

// ---------------------------------------------------------------------------
// 2. 필터 코퍼스 생성 (합성 대형 필터)
// ---------------------------------------------------------------------------

const N_SIZES = [500, 1000, 2500, 5000, 10000, 20000];

function buildCorpus() {
  const corpus = new Map(); // N -> { key, filter, items }
  for (const n of N_SIZES) {
    const items = makeScripts(n, 0x1000 + n);
    const key = randBytes(makeRng(0x2000 + n), 16);
    const t0 = now();
    const filter = encodeGcsFilter(items, key);
    const encMs = now() - t0;
    corpus.set(n, { key, filter, items, encMs });
  }
  return corpus;
}

// ---------------------------------------------------------------------------
// 3. 디코드 / 매칭 처리량
// ---------------------------------------------------------------------------

function benchDecode(corpus) {
  const rows = [];
  const perItem = [];
  for (const n of N_SIZES) {
    const { filter } = corpus.get(n);
    const r = bench(() => {
      const { n: got } = decodeGcsFilterValues(filter);
      if (got < 0) console.log('never');
    });
    rows.push([
      fmtInt(n),
      fmtInt(filter.length),
      fmt(filter.length / n, 2),
      fmt(r.perIterUs, 1),
      fmtInt(r.perSec),
      fmt((r.perIterUs * 1000) / n, 0),
    ]);
    perItem.push({ n, us: r.perIterUs, bytes: filter.length });
  }
  console.log(
    table(rows, ['N', 'filter B', 'B/item', 'us/filter', 'filters/sec', 'ns/item']),
  );
  return perItem;
}

const TARGET_COUNTS = [1, 20, 100, 1000];

function benchMatch(corpus) {
  const rows = [];
  const grid = [];
  for (const n of N_SIZES) {
    const { filter, key } = corpus.get(n);
    for (const t of TARGET_COUNTS) {
      // 비회원 타깃 (전량 스캔 = 최악/평균 경로: 매칭 없이 필터 끝까지 읽는다)
      const targets = makeScripts(t, 0xdead + t);
      const r = bench(() => {
        const hit = gcsMatchAny(filter, key, targets);
        if (hit) console.log('never'); // 합성 타깃은 회원이 아니므로 전량 순회
      });
      rows.push([fmtInt(n), t, fmt(r.perIterUs, 1), fmtInt(r.perSec), fmt((r.perIterUs * 1000) / n, 0)]);
      grid.push({ n, t, us: r.perIterUs, perSec: r.perSec });
    }
  }
  console.log(table(rows, ['N', 'targets', 'us/filter', 'filters/sec', 'ns/item']));
  return grid;
}

// ---------------------------------------------------------------------------
// 4. 병목 분해 — SDK BitReader 를 그대로 복제한 변형들
//    (SDK 코드는 수정하지 않는다. 여기 복제본은 "어디가 느린지" 격리 측정 전용.)
// ---------------------------------------------------------------------------

/** SDK 원본과 동일: BigInt 누산 Golomb-Rice */
function decodeLikeSdk(buf, off, n, p) {
  let bitPos = 0;
  const readBit = () => {
    const byteIdx = bitPos >> 3;
    const bit = (buf[off + byteIdx] >> (7 - (bitPos & 7))) & 1;
    bitPos++;
    return bit;
  };
  let acc = 0n;
  for (let i = 0; i < n; i++) {
    let q = 0n;
    while (readBit() === 1) q++;
    let r = 0n;
    for (let j = 0; j < p; j++) r = (r << 1n) | BigInt(readBit());
    acc += (q << BigInt(p)) | r;
  }
  return acc;
}

/** 변형 A: 비트 읽기는 동일, BigInt 를 전부 Number 로 (값 정확도는 무시 — 비용만 본다) */
function decodeNumberOnly(buf, off, n, p) {
  let bitPos = 0;
  const readBit = () => {
    const byteIdx = bitPos >> 3;
    const bit = (buf[off + byteIdx] >> (7 - (bitPos & 7))) & 1;
    bitPos++;
    return bit;
  };
  let acc = 0;
  for (let i = 0; i < n; i++) {
    let q = 0;
    while (readBit() === 1) q++;
    let r = 0;
    for (let j = 0; j < p; j++) r = (r << 1) | readBit();
    acc += q * 524288 + r;
  }
  return acc;
}

/** 변형 B: 비트 순회만 (Golomb 구조 없이 필터 전 비트를 1회 훑는다) — 순수 비트 접근 하한 */
function scanAllBits(buf, off, totalBits) {
  let acc = 0;
  for (let bitPos = 0; bitPos < totalBits; bitPos++) {
    acc += (buf[off + (bitPos >> 3)] >> (7 - (bitPos & 7))) & 1;
  }
  return acc;
}

function benchBreakdown(corpus, n = 10000) {
  const { filter, key, items } = corpus.get(n);
  const { value: nBig, size } = sdk.decodeVarint(filter, 0);
  const nItems = Number(nBig);
  const totalBits = (filter.length - size) * 8;

  const rows = [];
  const push = (label, r, unitCount) =>
    rows.push([
      label,
      fmt(r.perIterUs, 1),
      fmt((r.perIterUs * 1000) / unitCount, 0),
      fmt((r.perIterUs / baseline) * 100, 1) + '%',
    ]);

  const rSdk = bench(() => decodeLikeSdk(filter, size, nItems, GCS_P));
  const baseline = rSdk.perIterUs;

  push('전체 디코드 (SDK 동등, BigInt)', rSdk, nItems);
  push('  └ 같은 루프, Number 만', bench(() => decodeNumberOnly(filter, size, nItems, GCS_P)), nItems);
  push('  └ 비트 순회만 (readBit 비용)', bench(() => scanAllBits(filter, size, totalBits)), nItems);

  // 타깃 해시 비용 (필터당 1회)
  const f = BigInt(nItems) * BigInt(GCS_M);
  for (const t of [20, 100, 1000]) {
    const targets = makeScripts(t, 0xbeef + t);
    const r = bench(() => {
      const hs = targets.map((x) => (siphash24(key, x) * f) >> 64n);
      hs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (hs.length === -1) console.log('never');
    });
    push(`타깃 ${t}개 해시+정렬 (필터당 1회)`, r, nItems);
  }

  // varint 파싱 비용 (필터당 1회)
  push('varint 파싱 (필터당 1회)', bench(() => {
    for (let i = 0; i < 1000; i++) sdk.decodeVarint(filter, 0);
  }, { minMs: 200 }), 1000 * nItems);

  console.log(`\n[N=${fmtInt(n)}, 필터 ${fmtInt(filter.length)} B, ${fmtInt(totalBits)} bit]`);
  console.log(table(rows, ['구간', 'us/filter', 'ns/item', '전체디코드 대비']));
  void items;
  return { nItems, totalBits, filterBytes: filter.length, sdkUs: baseline };
}

// ---------------------------------------------------------------------------
// 5. CPU 프로파일 (V8 샘플러) — 함수별 self time
// ---------------------------------------------------------------------------

async function cpuProfile(corpus, n = 10000, targetCount = 100) {
  const { filter, key } = corpus.get(n);
  const targets = makeScripts(targetCount, 0xc0ffee);

  const session = new inspector.Session();
  session.connect();
  const post = (m, p) =>
    new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));

  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 60 }); // 60us
  await post('Profiler.start');

  const t0 = now();
  let calls = 0;
  while (now() - t0 < 2500) {
    gcsMatchAny(filter, key, targets);
    calls++;
  }

  const { profile } = await post('Profiler.stop');
  await post('Profiler.disable');
  session.disconnect();

  const totalHits = profile.nodes.reduce((s, nd) => s + (nd.hitCount ?? 0), 0);
  const agg = new Map();
  for (const nd of profile.nodes) {
    const h = nd.hitCount ?? 0;
    if (!h) continue;
    const cf = nd.callFrame;
    const file = cf.url ? cf.url.split(/[\\/]/).pop() : '(native)';
    const name = cf.functionName || '(anonymous)';
    const k = `${name} @ ${file}:${cf.lineNumber + 1}`;
    agg.set(k, (agg.get(k) ?? 0) + h);
  }
  const rows = [...agg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([k, h]) => [k, h, fmt((h / totalHits) * 100, 1) + '%']);

  console.log(`샘플 ${fmtInt(totalHits)}개 / gcsMatchAny 호출 ${fmtInt(calls)}회 (N=${fmtInt(n)}, 타깃 ${targetCount})`);
  console.log(table(rows, ['함수 @ 파일:줄 (self time)', 'samples', '비율']));
  return rows;
}

// ---------------------------------------------------------------------------
// 6. 메모리 — 1000 / 10000 필터 처리 시 힙 증가량
// ---------------------------------------------------------------------------

const HAS_GC = typeof global.gc === 'function';

function settleHeap() {
  if (HAS_GC) {
    global.gc();
    global.gc();
  }
  return process.memoryUsage();
}

function benchMemory(corpus, n = 10000, targetCount = 100) {
  // 서로 다른 필터 24개 풀을 순환 — 필터 자체를 10000개 인코딩하는 건 비현실적이고,
  // 우리가 알고 싶은 건 "필터를 계속 처리할 때 힙이 자라는가"이므로 풀 순환으로 충분하다.
  const pool = [];
  for (let i = 0; i < 24; i++) {
    const items = makeScripts(n, 0x30000 + i);
    const key = randBytes(makeRng(0x40000 + i), 16);
    pool.push({ filter: encodeGcsFilter(items, key), key });
  }
  const targets = makeScripts(targetCount, 0x5eed);

  const rows = [];
  for (const count of [1000, 10000]) {
    const before = settleHeap();
    const t0 = now();
    let hits = 0;
    for (let i = 0; i < count; i++) {
      const p = pool[i % pool.length];
      if (gcsMatchAny(p.filter, p.key, targets)) hits++;
    }
    const ms = now() - t0;
    const peak = process.memoryUsage(); // GC 전 (처리 중 도달 수준의 근사)
    const after = settleHeap();
    rows.push([
      fmtInt(count),
      fmt(ms, 0),
      fmt(ms / count, 3),
      fmt((peak.heapUsed - before.heapUsed) / 1024 / 1024, 2),
      fmt((after.heapUsed - before.heapUsed) / 1024 / 1024, 2),
      fmt(after.rss / 1024 / 1024, 1),
      hits,
    ]);
  }
  console.log(
    `필터 풀: 24개 × N=${fmtInt(n)} (풀 자체 ${fmt(
      pool.reduce((s, p) => s + p.filter.length, 0) / 1024 / 1024,
      2,
    )} MB), 타깃 ${targetCount}개` + (HAS_GC ? '' : '  [--expose-gc 없음: 힙 수치 노이즈 큼]'),
  );
  console.log(
    table(rows, [
      '필터 처리 수',
      'ms',
      'ms/필터',
      'GC전 힙증가 MB',
      'GC후 힙증가 MB',
      'RSS MB',
      'hits',
    ]),
  );
  return rows;
}

// ---------------------------------------------------------------------------
// 7. 5만 블록 스캔 추정 (계산식 명시)
// ---------------------------------------------------------------------------

function project(matchGrid, decodeStats, targetCount = 100) {
  const BLOCKS = 50000;
  const rows = [];
  for (const n of N_SIZES) {
    const g = matchGrid.find((x) => x.n === n && x.t === targetCount);
    const d = decodeStats.find((x) => x.n === n);
    if (!g || !d) continue;
    const sec = (g.us * BLOCKS) / 1e6;
    const dlMB = (d.bytes * BLOCKS) / 1024 / 1024;
    rows.push([
      fmtInt(n),
      fmtInt(d.bytes),
      fmt(g.us, 1),
      fmt(sec, 1),
      fmt(sec / 60, 2),
      fmt(dlMB, 0),
    ]);
  }
  console.log(
    `계산식:  총 CPU 초 = (필터당 us) x 50,000 / 1e6\n` +
      `         총 필터 바이트 = (필터 B) x 50,000\n` +
      `타깃 ${targetCount}개 기준. 아래 수치는 전부 데스크톱 node ${process.version} / ${process.arch} 기준이다.`,
  );
  console.log(
    table(rows, ['블록당 N', '필터 B', 'us/필터', '5만블록 CPU 초', '분', '필터 총 MB']),
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const wall0 = now();

console.log(`node ${process.version} ${process.platform}/${process.arch}`);
console.log(`SDK: ${SDK_DIST}`);
console.log(`GCS_P=${GCS_P} GCS_M=${GCS_M}  expose-gc=${HAS_GC}`);

section('0. 정확성 스모크 — BIP158 공식 벡터 (bip-0158/testnet-19.json)');
smokeTest();

section('1. SipHash-2-4 단독 (BigInt 구현)');
benchSipHash();
benchHashToRange();

section('2. 합성 대형 필터 생성');
const corpus = buildCorpus();
console.log(
  table(
    N_SIZES.map((n) => {
      const c = corpus.get(n);
      return [fmtInt(n), fmtInt(c.filter.length), fmt(c.filter.length / n, 2), fmt(c.encMs, 0)];
    }),
    ['N', '필터 B', 'B/item', '인코딩 ms(참고)'],
  ),
);

section('3. 필터 전체 디코드 (decodeGcsFilterValues)');
const decodeStats = benchDecode(corpus);

section('4. 실제 스캔 경로 (gcsMatchAny, 비회원 타깃 = 전량 순회)');
const matchGrid = benchMatch(corpus);

section('5. 병목 분해 (SDK 동등 복제본으로 구간 격리)');
const breakdown = benchBreakdown(corpus, 10000);

section('6. CPU 프로파일 — V8 샘플러 self time');
await cpuProfile(corpus, 10000, 100);

section('7. 메모리');
benchMemory(corpus, 10000, 100);

section('8. 5만 블록 스캔 추정');
project(matchGrid, decodeStats, 100);
console.log(
  '\n주의: 위 값은 전부 데스크톱 node 기준이다. 안드로이드 WebView(V8/JSC) 는 더 느리다.\n' +
    '      배수는 여기서 측정하지 않았다 — 기기 실측 필요. 임의 배수를 곱하지 말 것.',
);

console.log(`\n총 소요: ${fmt((now() - wall0) / 1000, 1)} s`);
void breakdown;
