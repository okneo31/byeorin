// e2e-scan.mjs — BIP157 전 과정 실피어 E2E 검증.
//
// 무엇을 증명하는가: 제3자 인덱서 없이, 임의의 BIP157 풀노드 하나에 붙어서
// "실제 주소의 실제 이력"이 끝까지 나오는가. 단위시험(tests/btc-bip157.test.ts)은
// 벡터로 코덱만 본다 — 여기서는 핸드셰이크부터 tx 레코드까지 실물로 통과시킨다.
//
// 왜 정답(ground truth)을 따로 만드는가: 필터가 "맞다"고 한 것을 필터로 검증하면
// 순환논증이다. 그래서 A단계에서 대상 구간의 블록 원문을 전부 받아 직접 훑어
// 정답을 만들고, B단계의 필터 스캔 결과를 그 정답과 대조한다. 이래야 거짓양성
// (GCS 특성상 정상)과 거짓음성(치명적 결함)을 구분해서 셀 수 있다.
//
// 단계:
//   S0 피어탐색   DNS 시드(x49=NODE_NETWORK|WITNESS|COMPACT_FILTERS)에서 후보를 받아
//                 핸드셰이크로 실제 서비스비트를 확인한다.
//   S1 핸드셰이크 version/verack.
//   S2 헤더체인   제네시스부터 대상 구간 끝까지 getheaders 로 따라간다.
//   S3 체크포인트 getcfheaders 의 previous_filter_header 로 구간 직전 필터헤더를 얻는다.
//                 (해당 피어 신뢰 = 시험 목적의 TOFU. 실전 정책은 별도.)
//   S4 정답생성   구간 블록 원문을 getdata 로 전부 받아 직접 훑는다.
//   S5 본스캔     bip157Scan 을 실 transport 로 호출 — 매칭·블록수신·파싱·레코드.
//   S6 대조       정답과 비교해 거짓양성/거짓음성 계수.
//   S7 FP측정     체인에 없는 미끼 스크립트 다수로 넓은 구간을 훑어 GCS 거짓양성 실측.
//
// 실행:
//   node scripts/btc-p2p/e2e-scan.mjs
//   node scripts/btc-p2p/e2e-scan.mjs --start 57000 --count 101 --fp-window 2000
//   node scripts/btc-p2p/e2e-scan.mjs --host 1.2.3.4 --port 8333   (피어 고정)
//
// 쓰기 없음 — 표준출력으로만 보고한다.

import dns from 'node:dns';
import net from 'node:net';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NodeTcpTransport } from './node-transport.mjs';
import {
  MAINNET_MAGIC,
  P2PFrameDecoder,
  addressToScriptPubKey,
  bip157Scan,
  buildPongPayload,
  buildVersionPayload,
  bytesToHex,
  decodeBlock,
  decodeCfHeaders,
  decodeHeadersMessage,
  displayHashToInternal,
  encodeGetCfHeaders,
  encodeGetData,
  encodeGetHeaders,
  encodeMessage,
  hasCompactFilters,
  internalHashToDisplay,
  isCoinbase,
  parsePingPayload,
  parseVersionPayload,
  INV_BLOCK,
} from '../../packages/wallet-sdk/dist/btc-history.js';

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

const GENESIS_HASH_DISPLAY =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

/** 이력이 확실한 공개 주소 — 구간 안에 있으면 이 주소를 1순위 대상으로 쓴다. */
const KNOWN_ADDRESSES = [
  { addr: '17SkEw2md5avVNyYgj6RiXuQKNwkXaxFyQ', note: '피자 tx 수취 주소 (2010-05-22, 10000 BTC)' },
  { addr: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', note: '제네시스 코인베이스 주소' },
];

/** 서비스비트 필터가 붙은 DNS 시드. x49 = 0x49 = NETWORK|WITNESS|COMPACT_FILTERS. */
const DNS_SEEDS = [
  'x49.seed.bitcoin.sipa.be',
  'x49.dnsseed.bluematt.me',
  'x49.seed.bitcoinstats.com',
  'x49.seed.bitcoin.jonasschnelli.ch',
];

const args = parseArgs(process.argv.slice(2));
const WINDOW_START = Number(args.start ?? 57000);
const WINDOW_COUNT = Number(args.count ?? 101);
const WINDOW_END = WINDOW_START + WINDOW_COUNT - 1;
const FP_WINDOW = Number(args['fp-window'] ?? 2000);
const FP_DECOYS = Number(args['fp-decoys'] ?? 500);
const MSG_TIMEOUT_MS = Number(args.timeout ?? 30_000);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 보고 유틸 — 단계별 통과/실패 + 소요 ms
// ---------------------------------------------------------------------------

const stages = [];
let current = null;

function begin(id, name) {
  current = { id, name, t0: Date.now(), ok: null, ms: 0, note: '' };
  stages.push(current);
  process.stdout.write(`\n[${id}] ${name} …\n`);
  return current;
}
function pass(note = '') {
  current.ok = true;
  current.ms = Date.now() - current.t0;
  current.note = note;
  process.stdout.write(`[${current.id}] 통과 (${current.ms} ms)${note ? ` — ${note}` : ''}\n`);
}
function fail(err) {
  if (current && current.ok === null) {
    current.ok = false;
    current.ms = Date.now() - current.t0;
    current.note = err?.message ?? String(err);
  }
}

/** 에러 메시지를 SDK 원본(src)에서 찾아 파일:라인으로 되돌린다.
 *  dist 는 번들이라 스택이 src 를 못 가리킨다 — 메시지 문자열로 역추적한다. */
const SRC_FILES = [
  '../../packages/wallet-sdk/src/btc-history/bip157/scan.ts',
  '../../packages/wallet-sdk/src/btc-history/bip157/p2p.ts',
  '../../packages/wallet-sdk/src/btc-history/bip157/messages.ts',
  '../../packages/wallet-sdk/src/btc-history/bip157/gcs.ts',
  '../../packages/wallet-sdk/src/btc-history/transport.ts',
];
function locateInSrc(message) {
  if (!message) return null;
  // 메시지의 고정 부분(변수 보간 앞까지)만 뽑아 찾는다.
  const needle = message.split(/[0-9]{2,}|0x/)[0].trim().replace(/[.:,]$/, '');
  if (needle.length < 8) return null;
  for (const rel of SRC_FILES) {
    let text;
    try {
      text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        return `${rel.replace('../../', '')}:${i + 1}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 바이트/주소 유틸
// ---------------------------------------------------------------------------

const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(Buffer.from(b)).digest());
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58check(payload) {
  const cs = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(cs, payload.length);
  let zeros = 0;
  while (zeros < full.length && full[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < full.length; i++) {
    let carry = full[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let s = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]];
  return s;
}

const isP2PKH = (s) =>
  s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac;
const isP2PK = (s) => (s.length === 67 || s.length === 35) && s[s.length - 1] === 0xac;
const isP2SH = (s) => s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87;

/** 스크립트 → 주소 표기 (P2PKH/P2SH 만; 나머지는 종류 표기). */
function scriptLabel(s) {
  if (isP2PKH(s)) {
    const p = new Uint8Array(21);
    p[0] = 0x00;
    p.set(s.slice(3, 23), 1);
    return base58check(p);
  }
  if (isP2SH(s)) {
    const p = new Uint8Array(21);
    p[0] = 0x05;
    p.set(s.slice(2, 22), 1);
    return base58check(p);
  }
  if (isP2PK(s)) return `P2PK(${bytesToHex(s).slice(0, 16)}…)`;
  return `script(${bytesToHex(s).slice(0, 16)}…)`;
}

const hexOf = (b) => bytesToHex(b);

// ---------------------------------------------------------------------------
// 미니 피어 — 정답 생성(A단계)용. scan.ts 의 Peer 와 같은 계약, 블록 다량 수신용.
// ---------------------------------------------------------------------------

class MiniPeer {
  #decoder = new P2PFrameDecoder(MAINNET_MAGIC);
  #queue = [];
  #waiter = null;
  #closedErr = null;
  bytesIn = 0;

  constructor(transport, timeoutMs) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    transport.onData((chunk) => {
      this.bytesIn += chunk.length;
      let msgs;
      try {
        msgs = this.#decoder.push(chunk);
      } catch (e) {
        this.#close(e);
        return;
      }
      for (const m of msgs) {
        if (m.command === 'ping') {
          void this.send('pong', buildPongPayload(parsePingPayload(m.payload))).catch(() => {});
          continue;
        }
        this.#queue.push(m);
        this.#deliver();
      }
    });
    transport.onClose((e) => this.#close(e ?? new Error('peer closed connection')));
  }

  #close(err) {
    if (this.#closedErr) return;
    this.#closedErr = err instanceof Error ? err : new Error(String(err));
    if (this.#waiter) {
      clearTimeout(this.#waiter.timer);
      this.#waiter.reject(this.#closedErr);
      this.#waiter = null;
    }
  }

  #deliver() {
    if (!this.#waiter) return;
    const i = this.#queue.findIndex((m) => this.#waiter.commands.has(m.command));
    if (i < 0) return;
    const m = this.#queue.splice(i, 1)[0];
    clearTimeout(this.#waiter.timer);
    const { resolve } = this.#waiter;
    this.#waiter = null;
    resolve(m);
  }

  async send(command, payload) {
    await this.transport.send(encodeMessage(command, payload, MAINNET_MAGIC));
  }

  next(...commands) {
    if (this.#closedErr) return Promise.reject(this.#closedErr);
    if (this.#waiter) return Promise.reject(new Error('minipeer: concurrent next()'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new Error(`minipeer: timeout waiting for [${commands.join(', ')}]`));
      }, this.timeoutMs);
      this.#waiter = { commands: new Set(commands), resolve, reject, timer };
      this.#deliver();
    });
  }
}

async function handshake(peer, label) {
  await peer.send('version', buildVersionPayload({ relay: false }));
  const v = await peer.next('version');
  const remote = parseVersionPayload(v.payload);
  await peer.send('verack', new Uint8Array(0));
  await peer.next('verack');
  return remote;
}

// ---------------------------------------------------------------------------
// S0 — 피어 탐색
// ---------------------------------------------------------------------------

async function resolveCandidates() {
  const set = new Set();
  for (const seed of DNS_SEEDS) {
    try {
      const addrs = await dns.promises.resolve4(seed);
      for (const a of addrs) set.add(a);
    } catch {
      /* 시드 하나 죽어도 계속 */
    }
  }
  return [...set];
}

async function tcpReachable(host, port, ms) {
  return await new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, ms);
    s.once('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve(true);
    });
    s.once('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/** NODE_COMPACT_FILTERS 를 광고하는 피어를 want 개까지 찾아 온다.
 *  여러 개를 잡아 두는 이유: 실피어는 스캔 도중 그냥 끊는다 — 그때 다음 피어로
 *  갈아타야 "SDK 결함"과 "피어 변덕"을 섞지 않는다. */
async function findPeers(want = 3) {
  if (args.host) {
    const port = Number(args.port ?? 8333);
    return [{ host: args.host, port, services: null, userAgent: '(고정 지정)' }];
  }
  const candidates = await resolveCandidates();
  process.stdout.write(`   DNS 시드 후보 ${candidates.length}개\n`);
  // 먼저 TCP 로 살아있는 것만 추린다 (병렬).
  const alive = [];
  const probes = candidates.map(async (h) => {
    if (await tcpReachable(h, 8333, 4000)) alive.push(h);
  });
  await Promise.all(probes);
  process.stdout.write(`   TCP 응답 ${alive.length}개\n`);

  const found = [];
  for (const host of alive) {
    const t = new NodeTcpTransport();
    try {
      await t.connect(host, 8333, { timeoutMs: 5000 });
      const peer = new MiniPeer(t, 8000);
      const remote = await handshake(peer);
      if (hasCompactFilters(remote.services)) {
        await t.close().catch(() => {});
        found.push({
          host,
          port: 8333,
          services: remote.services,
          userAgent: remote.userAgent,
          startHeight: remote.startHeight,
        });
        if (found.length >= want) return found;
        continue;
      }
      process.stdout.write(
        `   ${host}: NODE_COMPACT_FILTERS 없음 (services=0x${remote.services.toString(16)})\n`,
      );
    } catch (e) {
      process.stdout.write(`   ${host}: ${e.message}\n`);
    } finally {
      await t.close().catch(() => {});
    }
  }
  if (found.length > 0) return found;
  throw new Error('S0: NODE_COMPACT_FILTERS 를 광고하는 피어를 찾지 못했다');
}

// ---------------------------------------------------------------------------
// S2 — 헤더 체인 (제네시스 → 구간 끝)
// ---------------------------------------------------------------------------

async function walkHeaders(peer, toHeight) {
  const hashes = [displayHashToInternal(GENESIS_HASH_DISPLAY)]; // index = height
  let rounds = 0;
  while (hashes.length - 1 < toHeight) {
    await peer.send('getheaders', encodeGetHeaders([hashes[hashes.length - 1]]));
    const msg = await peer.next('headers');
    const headers = decodeHeadersMessage(msg.payload);
    rounds++;
    if (headers.length === 0) throw new Error(`S2: 빈 headers 응답 (height ${hashes.length - 1})`);
    for (const h of headers) {
      hashes.push(h.hash);
      if (hashes.length - 1 >= toHeight) break;
    }
  }
  return { hashes, rounds };
}

// ---------------------------------------------------------------------------
// S4 — 정답 생성: 구간 블록 원문 전수 조사
// ---------------------------------------------------------------------------

async function downloadBlocks(peer, hashes, from, to, batch = 40) {
  const out = new Map(); // height → DecodedBlock
  for (let h = from; h <= to; h += batch) {
    const last = Math.min(h + batch - 1, to);
    const entries = [];
    for (let i = h; i <= last; i++) entries.push({ type: INV_BLOCK, hash: hashes[i] });
    await peer.send('getdata', encodeGetData(entries));
    const pending = new Map(entries.map((e, i) => [hexOf(e.hash), h + i]));
    while (pending.size > 0) {
      const msg = await peer.next('block', 'notfound');
      if (msg.command === 'notfound') throw new Error('S4: 피어가 블록 원문을 안 준다 (pruned?)');
      const blk = decodeBlock(msg.payload);
      const key = hexOf(blk.header.hash);
      const height = pending.get(key);
      if (height === undefined) continue;
      pending.delete(key);
      out.set(height, blk);
    }
  }
  return out;
}

/** 구간 블록에서 정답 색인을 만든다. */
function buildGroundTruth(blocks) {
  const outputScripts = new Map(); // scriptHex → Set<height>
  const outpointScript = new Map(); // "txid:vout" → scriptHex
  const spendsByHeight = new Map(); // height → ["txid:vout"…]
  let filterElemTotal = 0;

  for (const [height, blk] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    const spends = [];
    const elems = new Set();
    for (const tx of blk.transactions) {
      const txid = internalHashToDisplay(tx.txid);
      for (let v = 0; v < tx.outputs.length; v++) {
        const s = tx.outputs[v].scriptPubKey;
        if (s.length === 0 || s[0] === 0x6a) continue; // OP_RETURN 은 필터에서 제외
        const hx = hexOf(s);
        if (!outputScripts.has(hx)) outputScripts.set(hx, new Set());
        outputScripts.get(hx).add(height);
        outpointScript.set(`${txid}:${v}`, hx);
        elems.add(hx);
      }
      if (!isCoinbase(tx)) {
        for (const inp of tx.inputs) {
          spends.push(`${internalHashToDisplay(inp.prevTxid)}:${inp.prevVout}`);
        }
      }
    }
    spendsByHeight.set(height, spends);
    // 필터 원소 수 근사: (블록 내 출력 스크립트) + (입력이 쓴 이전 출력 스크립트).
    // 이전 출력 스크립트는 구간 밖이면 알 수 없으므로 입력 수로 대체 근사한다.
    filterElemTotal += elems.size + spends.length;
  }
  return { outputScripts, outpointScript, spendsByHeight, filterElemTotal };
}

/** 특정 watch 스크립트에 대해 "이 구간에서 매칭돼야 하는 높이" 집합을 낸다. */
function expectedHeights(gt, watchHex, from, to) {
  const heights = new Set(gt.outputScripts.get(watchHex) ?? []);
  // 구간 안에서 생긴 우리 outpoint 를 소비하는 블록도 필터에 걸린다.
  // (구간 이전에 생긴 outpoint 의 지출은 원문만으로는 알 수 없다 — 아래 대조에서
  //  "매칭했으나 레코드 없음"으로 잡히며, 그래서 그 수치는 거짓양성 상한이다.)
  const owned = new Set();
  for (const [op, sc] of gt.outpointScript) if (sc === watchHex) owned.add(op);
  for (let h = from; h <= to; h++) {
    for (const sp of gt.spendsByHeight.get(h) ?? []) {
      if (owned.has(sp)) heights.add(h);
    }
  }
  return heights;
}

// ---------------------------------------------------------------------------
// 미끼 스크립트 — 체인에 존재하지 않는 P2WPKH (매칭되면 100% 거짓양성)
// ---------------------------------------------------------------------------

function decoyScripts(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    // 결정적 생성 — 재현 가능하게.
    const h = sha256(new TextEncoder().encode(`byeorin-bip157-decoy-${i}`)).slice(0, 20);
    const s = new Uint8Array(22);
    s[0] = 0x00;
    s[1] = 0x14;
    s.set(h, 2);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

const T0 = Date.now();
let exitCode = 0;
let summaryPrinted = false;

// 실피어는 예고 없이 끊는다. 소켓이 죽으면서 대기 중이던 프라미스가 영영 안 풀리면
// node 는 이벤트 루프가 비는 순간 아무 말 없이 종료한다 — 그러면 "어느 단계에서
// 멈췄나"가 사라진다. 그 경우를 잡아 마지막 단계를 남긴다.
process.on('exit', (code) => {
  if (summaryPrinted) return;
  process.stdout.write(
    `\n[비정상 종료] 요약 전에 프로세스가 끝났다 (exit ${code}). ` +
      `마지막 단계: ${current?.id ?? '-'} ${current?.name ?? '-'} — ` +
      '대기 중이던 응답이 오지 않았고 소켓도 이벤트를 안 냈다(피어 조용한 절단).\n',
  );
});

/** 피어 변덕(도중 끊김)인지 SDK 결함인지 구분하기 위한 판정. */
function isPeerFlake(err) {
  const m = String(err?.message ?? '');
  return (
    m.includes('closed connection') ||
    m.includes('socket closed') ||
    m.includes('timeout waiting for') ||
    m.includes('ECONNRESET') ||
    m.includes('EPIPE')
  );
}

process.stdout.write(
  `BIP157 실피어 E2E — 구간 [${WINDOW_START}, ${WINDOW_END}] (${WINDOW_COUNT} 블록)\n`,
);

// ---- S0 피어 탐색 ---------------------------------------------------------
let peerPool = [];
try {
  begin('S0', '피어 탐색 (NODE_COMPACT_FILTERS)');
  peerPool = await findPeers(3);
  pass(
    peerPool
      .map(
        (p) =>
          `${p.host}:${p.port} ua=${p.userAgent} services=0x${p.services === null ? '?' : p.services.toString(16)}`,
      )
      .join(' | '),
  );
} catch (err) {
  fail(err);
  process.stdout.write(`\n[실패] S0 — ${err?.message ?? err}\n`);
  peerPool = [];
}

let attempt = 0;
for (const peerInfo of peerPool) {
  attempt++;
  stages.length = 1; // S0 만 남기고 재시도마다 초기화
  if (attempt > 1) {
    process.stdout.write(`\n### 피어 교체 재시도 ${attempt}/${peerPool.length} — ${peerInfo.host}\n`);
  }
  try {
    await runAll(peerInfo);
    break;
  } catch (err) {
    fail(err);
    const where = locateInSrc(err?.message);
    process.stdout.write(`\n[실패] ${current?.id ?? '?'} ${current?.name ?? ''}\n`);
    process.stdout.write(`  메시지: ${err?.message ?? err}\n`);
    if (where) process.stdout.write(`  발생 지점(SDK 원본): ${where}\n`);
    else if (err?.stack)
      process.stdout.write(`  스택:\n${err.stack.split('\n').slice(0, 6).join('\n')}\n`);
    if (isPeerFlake(err) && attempt < peerPool.length) {
      process.stdout.write('  → 피어 끊김으로 보인다. 다음 피어로 재시도한다.\n');
      continue;
    }
    exitCode = 1;
    break;
  }
}
if (peerPool.length === 0) exitCode = 1;

async function runAll(peerInfo) {
  // ---- A단계 연결 ---------------------------------------------------------
  const tA = new NodeTcpTransport();
  let gt, chainHashes, checkpointFilterHeader, blocks;
  try {
    begin('S1', '핸드셰이크 (정답 수집용 연결)');
    await tA.connect(peerInfo.host, peerInfo.port, { timeoutMs: 8000 });
    const peerA = new MiniPeer(tA, MSG_TIMEOUT_MS);
    const remoteA = await handshake(peerA);
    pass(`상대 높이 ${remoteA.startHeight}, protocol ${remoteA.version}`);

    begin('S2', `헤더 체인 따라가기 (제네시스 → ${WINDOW_END})`);
    const walked = await walkHeaders(peerA, WINDOW_END);
    chainHashes = walked.hashes;
    pass(
      `getheaders ${walked.rounds}회, 헤더 ${chainHashes.length - 1}개, ` +
        `h${WINDOW_END}=${internalHashToDisplay(chainHashes[WINDOW_END]).slice(0, 16)}…`,
    );

    begin('S3', '체크포인트 필터헤더 (getcfheaders → previous_filter_header)');
    await peerA.send(
      'getcfheaders',
      encodeGetCfHeaders(WINDOW_START, chainHashes[WINDOW_END]),
    );
    const cfhMsg = await peerA.next('cfheaders');
    const cfh = decodeCfHeaders(cfhMsg.payload);
    if (cfh.filterHashes.length !== WINDOW_COUNT) {
      throw new Error(
        `S3: cfheaders 개수 ${cfh.filterHashes.length} != 기대 ${WINDOW_COUNT}`,
      );
    }
    checkpointFilterHeader = cfh.previousFilterHeader;
    pass(
      `h${WINDOW_START - 1} 필터헤더 = ${internalHashToDisplay(checkpointFilterHeader).slice(0, 16)}…, ` +
        `filter_hash ${cfh.filterHashes.length}개`,
    );

    begin('S4', `정답 생성 — 블록 원문 ${WINDOW_COUNT}개 전수 조사`);
    blocks = await downloadBlocks(peerA, chainHashes, WINDOW_START, WINDOW_END);
    if (blocks.size !== WINDOW_COUNT) {
      throw new Error(`S4: 블록 ${blocks.size}/${WINDOW_COUNT} 만 수신`);
    }
    gt = buildGroundTruth(blocks);
    const txTotal = [...blocks.values()].reduce((a, b) => a + b.transactions.length, 0);
    pass(
      `블록 ${blocks.size}개 · tx ${txTotal}개 · 서로 다른 출력 스크립트 ${gt.outputScripts.size}개 · ` +
        `수신 ${(peerA.bytesIn / 1e6).toFixed(2)} MB`,
    );
  } finally {
    await tA.close().catch(() => {});
  }

  // ---- 대상 선정 ----------------------------------------------------------
  begin('S4b', '대상 주소 선정');
  let target = null;
  const knownReport = [];
  for (const k of KNOWN_ADDRESSES) {
    const script = addressToScriptPubKey(k.addr, 'mainnet');
    const hx = hexOf(script);
    const hits = gt.outputScripts.get(hx);
    knownReport.push(`${k.addr} → ${hits ? `구간 내 ${hits.size}블록` : '구간 내 없음'} (${k.note})`);
    if (hits && hits.size > 0 && target === null) {
      target = { script, hex: hx, label: k.addr, source: `공개 주소 — ${k.note}` };
    }
  }
  if (target === null) {
    // 알려진 주소가 구간에 없으면, 구간 안에서 가장 많은 블록에 등장하는
    // 비-코인베이스 P2PKH 를 대상으로 삼는다 (정답은 여전히 원문 기준).
    let best = null;
    for (const [hx, hs] of gt.outputScripts) {
      const s = Uint8Array.from(Buffer.from(hx, 'hex'));
      if (!isP2PKH(s)) continue;
      if (best === null || hs.size > best.hs.size) best = { hx, hs, s };
    }
    if (best === null) throw new Error('S4b: 구간 안에 P2PKH 출력이 하나도 없다 — 구간을 바꿔라');
    target = {
      script: best.s,
      hex: best.hx,
      label: scriptLabel(best.s),
      source: `구간 내 실측 발견 (P2PKH, ${best.hs.size}블록)`,
    };
  }
  const expected = expectedHeights(gt, target.hex, WINDOW_START, WINDOW_END);
  pass(`${target.label} — ${target.source}; 정답 매칭 높이 ${[...expected].sort((a, b) => a - b).join(', ')}`);
  for (const line of knownReport) process.stdout.write(`   · ${line}\n`);

  // ---- S5 본 스캔 ---------------------------------------------------------
  begin('S5', 'bip157Scan 실행 (핸드셰이크→헤더→cfheader→cfilter→매칭→블록→파싱)');
  const tB = new NodeTcpTransport();
  const scanT0 = Date.now();
  const result = await bip157Scan(tB, {
    host: peerInfo.host,
    port: peerInfo.port,
    watchScripts: [target.script],
    checkpoint: {
      height: WINDOW_START - 1,
      blockHash: chainHashes[WINDOW_START - 1],
      filterHeader: checkpointFilterHeader,
    },
    stopAtHeight: WINDOW_END,
    messageTimeoutMs: MSG_TIMEOUT_MS,
  });
  const scanMs = Date.now() - scanT0;
  pass(
    `tip h${result.tipHeight} · 필터 ${result.scannedFilterCount}개 · 매칭블록 ${result.matchedBlockCount} · ` +
      `레코드 ${result.records.length} · ${scanMs} ms`,
  );

  // ---- S6 대조 ------------------------------------------------------------
  begin('S6', '정답 대조 — 거짓양성/거짓음성 계수');
  const recordHeights = new Set(result.records.map((r) => r.height));
  const falseNegatives = [...expected].filter((h) => !recordHeights.has(h)).sort((a, b) => a - b);
  // 매칭됐지만 정답에 우리 스크립트가 전혀 없는 블록 = GCS 거짓양성 (정상 특성).
  const matchedNoRecord = result.matchedBlockCount - recordHeights.size;
  // 레코드 자체의 정확성: 각 레코드가 실제 블록 원문에 있는지 재확인.
  let recordVerified = 0;
  const recordErrors = [];
  for (const r of result.records) {
    const blk = blocks.get(r.height);
    const tx = blk?.transactions.find((t) => internalHashToDisplay(t.txid) === r.txid);
    if (!tx) {
      recordErrors.push(`h${r.height} txid ${r.txid} 가 블록 원문에 없다`);
      continue;
    }
    let ok = true;
    for (const ro of r.receivedOutputs) {
      const o = tx.outputs[ro.vout];
      if (!o || hexOf(o.scriptPubKey) !== target.hex || o.value !== ro.value) {
        ok = false;
        recordErrors.push(`h${r.height} ${r.txid} vout ${ro.vout} 불일치`);
      }
    }
    if (ok) recordVerified++;
  }
  if (falseNegatives.length > 0 || recordErrors.length > 0) {
    current.ok = false;
    current.ms = Date.now() - current.t0;
    current.note = `거짓음성 ${falseNegatives.length} · 레코드오류 ${recordErrors.length}`;
    process.stdout.write(`[S6] 실패 — ${current.note}\n`);
    for (const e of recordErrors.slice(0, 10)) process.stdout.write(`   ! ${e}\n`);
    if (falseNegatives.length) process.stdout.write(`   ! 놓친 높이: ${falseNegatives.join(', ')}\n`);
    exitCode = 1;
  } else {
    pass(
      `거짓음성 0 · 레코드 ${recordVerified}/${result.records.length} 원문 재확인 통과 · ` +
        `매칭했으나 레코드 없음 ${matchedNoRecord}블록(=거짓양성)`,
    );
  }

  // 레코드 표본
  process.stdout.write(`\n   찾은 tx (${result.records.length}건, 최대 5건 표시):\n`);
  for (const r of result.records.slice(0, 5)) {
    const recv = r.receivedOutputs
      .map((o) => `vout${o.vout} ${(Number(o.value) / 1e8).toFixed(8)} BTC`)
      .join(', ');
    const sp = r.spentOutpoints.map((o) => `${o.txid.slice(0, 12)}…:${o.vout}`).join(', ');
    process.stdout.write(
      `   · h${r.height} ${r.txid}\n     수취[${recv || '-'}] 지출[${sp || '-'}] ts=${new Date(r.timestamp * 1000).toISOString()}\n`,
    );
  }

  // ---- S7 거짓양성 실측 ---------------------------------------------------
  begin('S7', `GCS 거짓양성 실측 — 미끼 ${FP_DECOYS}개 × ${FP_WINDOW}블록`);
  const decoys = decoyScripts(FP_DECOYS);
  const tC = new NodeTcpTransport();
  const fpT0 = Date.now();
  const fpResult = await bip157Scan(tC, {
    host: peerInfo.host,
    port: peerInfo.port,
    watchScripts: decoys,
    checkpoint: {
      height: WINDOW_START - 1,
      blockHash: chainHashes[WINDOW_START - 1],
      filterHeader: checkpointFilterHeader,
    },
    stopAtHeight: WINDOW_START - 1 + FP_WINDOW,
    messageTimeoutMs: MSG_TIMEOUT_MS,
  });
  const fpMs = Date.now() - fpT0;
  // 기대값: BIP158 은 항목당 범위를 N×M 으로 잡는다(gcs.ts hashToRange, f = N×M).
  // 그래서 항목 1개의 오탐 확률은 블록 크기 N 과 무관하게 1/M (M=784931) 이다.
  // 미끼 K개면 블록당 오탐 = 1-(1-1/M)^K.
  const M = 784931;
  const perBlock = 1 - Math.pow(1 - 1 / M, FP_DECOYS);
  const expectedFp = fpResult.scannedFilterCount * perBlock;
  const avgN = gt.filterElemTotal / WINDOW_COUNT;
  pass(
    `필터 ${fpResult.scannedFilterCount}개 · 매칭(=전부 거짓양성) ${fpResult.matchedBlockCount} · ` +
      `레코드 ${fpResult.records.length}(0이어야 정상) · 기대 ${expectedFp.toFixed(2)} ` +
      `(블록당 ${(perBlock * 100).toFixed(4)}%) · 본구간 평균 필터원소 ${avgN.toFixed(0)}개 · ${fpMs} ms`,
  );
  if (fpResult.records.length !== 0) {
    current.ok = false;
    current.note = '미끼 스크립트에서 레코드가 나왔다 — 파싱 결함';
    exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// 요약
// ---------------------------------------------------------------------------

const totalMs = Date.now() - T0;
process.stdout.write('\n────────── 단계별 결과 ──────────\n');
for (const s of stages) {
  const mark = s.ok === true ? '통과' : s.ok === false ? '실패' : '미도달';
  process.stdout.write(`${s.id.padEnd(4)} ${mark}  ${String(s.ms).padStart(7)} ms  ${s.name}\n`);
  if (s.note) process.stdout.write(`       ${s.note}\n`);
}
process.stdout.write(`총 소요: ${totalMs} ms\n`);
summaryPrinted = true;
process.exit(exitCode);
