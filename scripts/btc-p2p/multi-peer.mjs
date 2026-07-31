#!/usr/bin/env node
// multi-peer.mjs — "단일 피어 신뢰" 약점의 실측 도구.
//
// C 부대의 BIP157 스캐너(packages/wallet-sdk/src/btc-history/bip157/scan.ts)는
// 피어 하나에 붙어 헤더 체인과 필터 헤더 체인을 받는다. scan.ts 주석이 스스로
// 밝힌 한계: "PoW 목표 검증·누적 난이도 비교를 하지 않는다 — 악의적 피어가 가짜
// 체인을 줄 수 있으므로 실전에서는 복수 피어 교차 확인이 필요하다."
//
// 이 파일은 그 "복수 피어 교차 확인"이 실제로 무엇을 보여주는지 측정한다.
//   1. 서로 다른 피어 5개 이상에 동시 연결
//   2. 같은 높이 구간의 cfheaders 를 각각 받아 바이트 단위 비교
//   3. 헤더 체인(getheaders)도 같은 구간·같은 방식으로 비교 (팁 높이·해시 분산)
//   4. 응답률·응답시간·불일치 실측 → k-of-n 정책 계산
//
// 쓰지 않는 것: 제3자 인덱서, 하드코딩된 최근 체크포인트.
// 유일한 신뢰 상수는 제네시스 블록해시다(Bitcoin Core 도 하드코딩하는 값).
//
// ── 앵커를 어떻게 얻는가 (중요) ─────────────────────────────────────────────
// 비트코인 P2P 에는 "높이 H 의 블록해시를 다오"가 없다. getheaders 는 locator
// (내가 아는 해시들)를 요구하고, getcfheaders 는 stop_hash 를 요구한다. 그래서
// 최근 높이를 가리키려면 헤더를 실제로 걸어야 한다.
//   1단계(bootstrap): 소수의 피어에서 제네시스부터 팁까지 헤더를 각자 독립적으로
//                     걸어 내려간다. 서로의 결과를 참조하지 않는다.
//   2단계(anchor):    부트스트랩 결과의 다수결로 앵커(높이, 해시)를 정한다.
//   3단계(compare):   모든 피어에게 그 앵커 기준으로 cfheaders·headers 를 묻는다.
// 앵커가 특정 피어에게서 왔다는 사실은 그 피어에게 권위를 주지 않는다. 앵커를
// 모르는 피어는 locator 의 제네시스로 되돌아가 응답하고, 우리는 그것을 "앵커 미인지"
// 로 기록한다 — 그것 자체가 측정하려는 불일치 신호다.
//
// 사용:
//   node scripts/btc-p2p/multi-peer.mjs --dial 40            # 기본 실측 (헤더 워크 포함, 수 분)
//   node scripts/btc-p2p/multi-peer.mjs --anchor 959451:<display-hash> --dial 40
//                                                            # 앵커를 알면 워크 생략 (~20 초)
//   node scripts/btc-p2p/multi-peer.mjs --json                # 기계용 JSON 을 stdout 으로
//
// 출력 규약: 사람이 읽는 표는 stderr, JSON 은 stdout. 파일은 쓰지 않는다.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { NodeTcpTransport } from './node-transport.mjs';
import { collectPeers, FILTER_PREFIX_CF, MAINNET_PORT } from './seeds.mjs';

import {
  MAINNET_MAGIC,
  P2PFrameDecoder,
  buildPongPayload,
  buildVersionPayload,
  bytesEqual,
  bytesToHex,
  computeFilterHeader,
  decodeCfHeaders,
  decodeHeadersMessage,
  displayHashToInternal,
  encodeGetCfHeaders,
  encodeGetHeaders,
  encodeMessage,
  hasCompactFilters,
  hexToBytes,
  internalHashToDisplay,
  parsePingPayload,
  parseVersionPayload,
} from '../../packages/wallet-sdk/dist/btc-history.js';

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/** mainnet 제네시스 블록해시 (탐색기 표기). 이 파일이 신뢰하는 유일한 상수. */
export const GENESIS_DISPLAY =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const GENESIS_INTERNAL = displayHashToInternal(GENESIS_DISPLAY);

/** 한 번의 headers 응답 상한 (프로토콜 규정). */
const HEADERS_PER_MSG = 2000;

/** 헤더 워크 중 유지하는 최근 해시 창 — 앵커 추출·locator 생성에 충분한 크기. */
const WINDOW = 4096;

const now = () => Number(process.hrtime.bigint()) / 1e6;
const ms = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// Peer — 메시지 큐 + 요청/응답 대기. scan.ts 의 내부 Peer 와 같은 모양이지만
// 그쪽은 export 되지 않으므로(스캔 전용) 여기서 측정용으로 다시 만든다.
// ---------------------------------------------------------------------------

const IGNORED = new Set([
  'sendheaders',
  'sendcmpct',
  'wtxidrelay',
  'sendaddrv2',
  'addr',
  'addrv2',
  'inv',
  'tx',
  'feefilter',
  'getheaders',
  'getaddr',
  'alert',
  'pong',
  'cmpctblock',
  'blocktxn',
  'merkleblock',
  'notfound',
]);

class Peer {
  #decoder;
  #transport;
  #magic;
  #timeoutMs;
  #queue = [];
  #waiter = null;
  #closedErr = null;
  /** 수신 바이트 총량 — 워크 비용 실측용. */
  bytesIn = 0;
  /** 상대가 끊었을 때의 사유 — "응답 없음"을 원인별로 나누기 위해 보존한다. */
  closeReason = null;

  get closed() {
    return this.#closedErr !== null;
  }

  constructor(transport, magic, timeoutMs) {
    this.#transport = transport;
    this.#magic = magic;
    this.#timeoutMs = timeoutMs;
    this.#decoder = new P2PFrameDecoder(magic);
    transport.onData((chunk) => this.#onChunk(chunk));
    transport.onClose((e) => this.#onClose(e ?? new Error('peer closed connection')));
  }

  #onChunk(chunk) {
    this.bytesIn += chunk.length;
    let msgs;
    try {
      msgs = this.#decoder.push(chunk);
    } catch (e) {
      this.#onClose(e instanceof Error ? e : new Error(String(e)));
      void this.#transport.close().catch(() => undefined);
      return;
    }
    for (const m of msgs) {
      if (m.command === 'ping') {
        void this.send('pong', buildPongPayload(parsePingPayload(m.payload))).catch(
          () => undefined,
        );
        continue;
      }
      if (IGNORED.has(m.command)) continue;
      this.#queue.push(m);
      this.#deliver();
    }
  }

  #onClose(err) {
    if (this.#closedErr) return;
    this.#closedErr = err;
    this.closeReason = err.message;
    if (this.#waiter) {
      clearTimeout(this.#waiter.timer);
      this.#waiter.reject(err);
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
    // 상대가 이미 끊었으면 전송 계층의 'not connected' 대신 진짜 사유를 던진다.
    if (this.#closedErr) throw new Error(`peer gone: ${this.#closedErr.message}`);
    await this.#transport.send(encodeMessage(command, payload, this.#magic));
  }

  next(...commands) {
    if (this.#closedErr) return Promise.reject(this.#closedErr);
    if (this.#waiter) return Promise.reject(new Error('peer: concurrent next()'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new Error(`timeout waiting for [${commands.join(', ')}]`));
      }, this.#timeoutMs);
      this.#waiter = { commands: new Set(commands), resolve, reject, timer };
      this.#deliver();
    });
  }

  async close() {
    await this.#transport.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// 연결 · 핸드셰이크
// ---------------------------------------------------------------------------

/**
 * 후보 주소 하나에 붙어 핸드셰이크까지 한다.
 * 실패 이유를 분류해 돌려준다 — "응답 없는 피어 비율"의 분모/분자가 된다.
 */
async function dialPeer(addr, opts) {
  const rec = {
    id: `${addr.host}:${addr.port}`,
    host: addr.host,
    port: addr.port,
    seed: addr.seed ?? null,
    stage: 'connect',
    ok: false,
    error: null,
    connectMs: null,
    handshakeMs: null,
    userAgent: null,
    services: null,
    compactFilters: false,
    startHeight: null,
    protocol: null,
  };
  const transport = new NodeTcpTransport();
  const t0 = now();
  try {
    await transport.connect(addr.host, addr.port, { timeoutMs: opts.connectTimeoutMs });
  } catch (e) {
    rec.error = shortErr(e);
    return { rec, peer: null };
  }
  rec.connectMs = ms(now() - t0);
  rec.stage = 'handshake';

  const peer = new Peer(transport, MAINNET_MAGIC, opts.msgTimeoutMs);
  const t1 = now();
  try {
    await peer.send('version', buildVersionPayload({ userAgent: opts.userAgent, relay: false }));
    const vm = await peer.next('version');
    const remote = parseVersionPayload(vm.payload);
    await peer.send('verack', new Uint8Array(0));
    await peer.next('verack');
    rec.handshakeMs = ms(now() - t1);
    rec.userAgent = remote.userAgent;
    rec.services = `0x${remote.services.toString(16)}`;
    rec.compactFilters = hasCompactFilters(remote.services);
    rec.startHeight = remote.startHeight;
    rec.protocol = remote.version;
  } catch (e) {
    rec.error = shortErr(e);
    await peer.close();
    return { rec, peer: null };
  }

  if (!rec.compactFilters) {
    rec.stage = 'services';
    rec.error = `no NODE_COMPACT_FILTERS (services=${rec.services})`;
    await peer.close();
    return { rec, peer: null };
  }

  rec.stage = 'ready';
  rec.ok = true;
  return { rec, peer };
}

function shortErr(e) {
  const s = e?.message ?? String(e);
  return s.length > 90 ? `${s.slice(0, 87)}...` : s;
}

// ---------------------------------------------------------------------------
// 헤더 워크 — 제네시스부터 팁까지, 피어 하나에서 독립적으로
// ---------------------------------------------------------------------------

/** 현재 창에서 getheaders locator 를 만든다: 팁부터 지수 간격 + 제네시스. */
function buildLocator(win, winStartHeight) {
  const loc = [];
  let step = 1;
  let i = win.length - 1;
  while (i >= 0 && loc.length < 16) {
    loc.push(win[i]);
    if (loc.length > 8) step *= 2;
    i -= step;
  }
  if (!loc.some((h) => bytesEqual(h, GENESIS_INTERNAL))) loc.push(GENESIS_INTERNAL);
  return loc;
}

/**
 * 제네시스부터 팁까지 헤더를 따라간다. 각 헤더의 prev 링크만 검증한다
 * (PoW 누적 난이도 비교는 하지 않는다 — scan.ts 와 같은 한계를 그대로 둔 채
 *  "여러 피어가 같은 걸 주는가"만 본다).
 */
async function walkHeadersToTip(peer, opts) {
  const win = [GENESIS_INTERNAL]; // 최근 WINDOW 개 해시
  let winStart = 0; // win[0] 의 높이
  let height = 0;
  let rounds = 0;
  const t0 = now();
  const roundMs = [];

  let partial = false;
  for (;;) {
    if (rounds >= opts.maxRounds) break;
    // 느린 피어 하나가 전체 실행을 붙잡지 않게 한다. 마감을 넘긴 워크는 partial 로
    // 표시하고 앵커 투표에서 뺀다 — 절반짜리 체인이 다수결을 오염시키면 안 된다.
    if (opts.deadlineAt != null && now() > opts.deadlineAt) {
      partial = true;
      break;
    }
    const tr = now();
    await peer.send('getheaders', encodeGetHeaders(buildLocator(win, winStart)));
    const msg = await peer.next('headers');
    roundMs.push(ms(now() - tr));
    rounds += 1;
    const headers = decodeHeadersMessage(msg.payload);
    if (headers.length === 0) break;

    for (const h of headers) {
      const tip = win[win.length - 1];
      if (!bytesEqual(h.prevBlockHash, tip)) {
        // 워크 도중 링크 끊김 = 재조직이거나 피어가 딴 체인을 섞어 보냄.
        return {
          ok: false,
          error: `header link break at height ${height + 1}`,
          height,
          rounds,
          walkMs: ms(now() - t0),
          win,
          winStart,
          roundMs,
        };
      }
      win.push(h.hash);
      height += 1;
      if (win.length > WINDOW) {
        win.shift();
        winStart += 1;
      }
    }
    if (opts.onProgress) opts.onProgress(height, rounds);
    if (headers.length < HEADERS_PER_MSG) break;
    if (opts.stopAtHeight != null && height >= opts.stopAtHeight) break;
  }

  return {
    ok: true,
    partial,
    error: partial ? `deadline hit at height ${height}` : null,
    height,
    rounds,
    walkMs: ms(now() - t0),
    win,
    winStart,
    roundMs,
  };
}

/** 워크 결과에서 특정 높이의 해시를 꺼낸다 (창 안에 있어야 한다). */
function hashAtHeight(walk, h) {
  const idx = h - walk.winStart;
  if (idx < 0 || idx >= walk.win.length) return null;
  return walk.win[idx];
}

// ---------------------------------------------------------------------------
// 비교 단계 — 앵커 기준 cfheaders · headers
// ---------------------------------------------------------------------------

const sha = (b) => createHash('sha256').update(Buffer.from(b)).digest('hex');

/** 여러 32바이트 조각을 하나의 다이제스트로 — 바이트 단위 동일성 비교용 지문. */
function digestOf(chunks) {
  const h = createHash('sha256');
  for (const c of chunks) h.update(Buffer.from(c));
  return h.digest('hex');
}

/**
 * 같은 [start..anchor] 구간의 cfheaders 를 요청한다.
 * 반환 지문:
 *   prevHeader   — 구간 직전 필터 헤더 (start-1 의 필터 헤더)
 *   hashesDigest — filter_hash 들을 순서대로 이어붙인 sha256 (바이트 단위 비교)
 *   endHeader    — prevHeader 에서 접어 내린 anchor 의 필터 헤더.
 *                  이 32바이트 하나가 구간 전체를 커밋한다 — 하나라도 다르면 달라진다.
 */
async function fetchCfHeaders(peer, anchor, count) {
  const start = anchor.height - (count - 1);
  const t = now();
  await peer.send('getcfheaders', encodeGetCfHeaders(start, anchor.hash));
  const msg = await peer.next('cfheaders');
  const elapsed = ms(now() - t);
  const cf = decodeCfHeaders(msg.payload);

  const stopMatches = bytesEqual(cf.stopHash, anchor.hash);
  let endHeader = cf.previousFilterHeader;
  for (const fh of cf.filterHashes) endHeader = computeFilterHeader(fh, endHeader);

  return {
    ms: elapsed,
    startHeight: start,
    count: cf.filterHashes.length,
    expectedCount: count,
    stopMatches,
    filterType: cf.filterType,
    prevHeader: bytesToHex(cf.previousFilterHeader),
    hashesDigest: digestOf(cf.filterHashes),
    endHeader: bytesToHex(endHeader),
    firstHash: cf.filterHashes.length ? bytesToHex(cf.filterHashes[0]) : null,
    lastHash: cf.filterHashes.length
      ? bytesToHex(cf.filterHashes[cf.filterHashes.length - 1])
      : null,
    filterHashes: cf.filterHashes.map((b) => bytesToHex(b)),
  };
}

/**
 * 앵커에서 팁까지 헤더를 받는다 (앵커가 팁 근처면 1~2 왕복).
 * 앵커를 모르는 피어는 locator 의 제네시스로 되돌아가므로 첫 헤더의 prev 로 감지한다.
 */
async function fetchHeadersFromAnchor(peer, anchor, opts) {
  const t = now();
  const collected = [];
  let cursor = anchor.hash;
  let rounds = 0;
  let anchorKnown = true;

  for (;;) {
    const loc = rounds === 0 ? [anchor.hash, GENESIS_INTERNAL] : [cursor, anchor.hash, GENESIS_INTERNAL];
    await peer.send('getheaders', encodeGetHeaders(loc));
    const msg = await peer.next('headers');
    rounds += 1;
    const headers = decodeHeadersMessage(msg.payload);
    if (headers.length === 0) break;

    if (rounds === 1 && !bytesEqual(headers[0].prevBlockHash, anchor.hash)) {
      // 앵커를 모른다 → 제네시스에서 다시 시작한 응답.
      anchorKnown = false;
      return {
        ms: ms(now() - t),
        anchorKnown: false,
        rounds,
        count: 0,
        tipHeight: null,
        tipHash: null,
        rangeDigest: null,
        firstPrev: internalHashToDisplay(headers[0].prevBlockHash),
      };
    }
    for (const h of headers) {
      if (!bytesEqual(h.prevBlockHash, cursor)) {
        return {
          ms: ms(now() - t),
          anchorKnown,
          rounds,
          count: collected.length,
          tipHeight: anchor.height + collected.length,
          tipHash: collected.length
            ? internalHashToDisplay(collected[collected.length - 1].hash)
            : null,
          rangeDigest: null,
          error: `link break at +${collected.length + 1}`,
        };
      }
      collected.push(h);
      cursor = h.hash;
    }
    if (headers.length < HEADERS_PER_MSG) break;
    if (rounds >= opts.maxRounds) break;
  }

  return {
    ms: ms(now() - t),
    anchorKnown,
    rounds,
    count: collected.length,
    tipHeight: anchor.height + collected.length,
    tipHash: collected.length
      ? internalHashToDisplay(collected[collected.length - 1].hash)
      : internalHashToDisplay(anchor.hash),
    /** 공통 비교 구간(앵커+1 .. 앵커+cmp)의 80바이트 원문 지문 — 헤더 바이트 단위 비교. */
    rangeDigest: null,
    headers: collected,
  };
}

/** 모든 피어가 공통으로 가진 길이만큼만 잘라 헤더 원문 지문을 만든다. */
function headerRangeDigest(headers, n) {
  return digestOf(headers.slice(0, n).map((h) => h.raw));
}

// ---------------------------------------------------------------------------
// 다수결 · 그룹화
// ---------------------------------------------------------------------------

/**
 * 값별로 피어를 묶는다.
 * @returns {{groups:{value:*,peers:string[],n:number}[], majority:*, majorityN:number,
 *            minority:string[], unanimous:boolean, distinct:number, responders:number}}
 */
function groupBy(entries) {
  const map = new Map();
  for (const [id, value] of entries) {
    const k = value === null || value === undefined ? '<null>' : String(value);
    if (!map.has(k)) map.set(k, { value, peers: [] });
    map.get(k).peers.push(id);
  }
  const groups = [...map.values()]
    .map((g) => ({ value: g.value, peers: g.peers, n: g.peers.length }))
    .sort((a, b) => b.n - a.n);
  const responders = entries.length;
  const majorityN = groups.length ? groups[0].n : 0;
  const minority = groups.slice(1).flatMap((g) => g.peers);
  return {
    groups,
    majority: groups.length ? groups[0].value : null,
    majorityN,
    minority,
    unanimous: groups.length === 1 && responders > 0,
    distinct: groups.length,
    responders,
    /** 다수결 성립 = 최다 그룹이 응답자 과반. 동수 1위가 둘이면 성립 안 함. */
    strictMajority:
      responders > 0 && majorityN * 2 > responders && (groups.length < 2 || groups[1].n < majorityN),
  };
}

// ---------------------------------------------------------------------------
// k-of-n 정책 계산
// ---------------------------------------------------------------------------

function logChoose(n, k) {
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
  return s;
}

/** P(X >= k), X ~ Binomial(n, p). */
function binomTail(n, k, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let sum = 0;
  for (let i = k; i <= n; i++) {
    sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  }
  return Math.min(1, sum);
}

/**
 * 실측 응답률 p 와 가정 적대비율 f 로 (n, k) 를 고른다.
 *
 * 모형 (가정을 명시한다 — 숫자만 던지지 않는다):
 *   n = 한 스캔에서 동시에 다이얼하는 피어 수
 *   p = 다이얼한 피어가 실제로 유효 응답을 줄 확률 (이 실행에서 실측)
 *   f = 다이얼 가능한 피어 모집단 중 적대 피어의 비율 (가정치)
 *   규칙 = "같은 값을 준 피어가 k개 이상이면 채택, 아니면 실패 처리"
 *
 *   가용성 A(n,k) = P(응답 ≥ k)          , 응답수 ~ Binomial(n, p)
 *   안전성 B(n,k) = P(적대 응답 ≥ k)      , 적대응답수 ~ Binomial(n, f)
 *     ↑ 적대 피어는 항상 응답한다고 본다(공격자는 선택되고 싶어 한다) — 보수적 가정.
 *
 * A ≥ availTarget 이면서 B ≤ safetyTarget 인 (n,k) 중 n 최소, 같으면 k 최소를 고른다.
 */
function planKofN(p, fList, { availTarget = 0.99, safetyTarget = 1e-3, maxN = 24 } = {}) {
  const out = [];
  for (const f of fList) {
    let pick = null;
    for (let n = 2; n <= maxN && !pick; n++) {
      for (let k = 2; k <= n; k++) {
        const avail = binomTail(n, k, p);
        const bad = binomTail(n, k, f);
        if (avail >= availTarget && bad <= safetyTarget) {
          pick = { n, k, avail, bad };
          break;
        }
      }
    }
    out.push({ f, pick });
  }
  return out;
}

/**
 * 재시도를 허용하는 모형 — 실제 월릿은 응답 없는 피어를 만나면 다시 다이얼한다.
 * 그러면 "n개 다이얼해서 k개 이상 오길 빈다"가 아니라 "응답 k개를 모을 때까지 다이얼"이
 * 되고, 가용성은 다이얼 예산 문제로, 안전성은 k만의 문제로 분리된다.
 *
 *   응답자 중 적대 비율 f_r = f / (f + (1-f)·p)
 *     ← 적대 피어는 항상 응답(=1), 정직 피어는 확률 p 로 응답한다는 보수적 가정.
 *       응답을 안 주는 피어는 표본에서 빠지므로 적대 비율이 올라간다.
 *   규칙: 응답 k개를 모아 전원 일치를 요구. 오답 채택 = 전원이 적대 = f_r^k.
 *   기대 다이얼 수 = k / p.
 */
function planWithRetry(p, fList, safetyTarget) {
  return fList.map((f) => {
    const fr = f / (f + (1 - f) * p);
    const k = Math.max(2, Math.ceil(Math.log(safetyTarget) / Math.log(fr)));
    return { f, fr, k, pBad: fr ** k, expectedDials: k / p };
  });
}

/** 주어진 n 들에 대해 (n,k) 격자를 통째로 만든다 — 추천값의 근거를 보이기 위해. */
function kofnGrid(p, f, nList) {
  const rows = [];
  for (const n of nList) {
    for (let k = 1; k <= n; k++) {
      rows.push({ n, k, avail: binomTail(n, k, p), bad: binomTail(n, k, f) });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 표 렌더
// ---------------------------------------------------------------------------

function table(rows, cols) {
  if (rows.length === 0) return '(없음)';
  const w = {};
  for (const c of cols) {
    w[c] = Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length));
  }
  const line = (r) => cols.map((c) => String(r[c] ?? '').padEnd(w[c])).join('  ');
  const sep = cols.map((c) => '-'.repeat(w[c])).join('  ');
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), sep, ...rows.map(line)].join('\n');
}

const short = (h, n = 12) => (h ? `${h.slice(0, n)}…` : '-');
const log = (s = '') => process.stderr.write(`${s}\n`);

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export async function runMultiPeer(opts) {
  const t0 = now();
  const out = { started_at: new Date().toISOString(), options: { ...opts } };

  // --- 0. 후보 주소 수집 ---------------------------------------------------
  log('[1/5] DNS 시드에서 후보 주소 수집…');
  const seedRes = await collectPeers({
    prefix: FILTER_PREFIX_CF,
    timeoutMs: opts.dnsTimeoutMs,
    v4: true,
    v6: opts.v6,
    port: MAINNET_PORT,
  });
  out.seeds = {
    unique: seedRes.uniqueCount,
    ms: seedRes.totalMs,
    responded: seedRes.report.filter((r) => r.responded).length,
    total: seedRes.report.length,
  };
  log(
    `      시드 ${out.seeds.responded}/${out.seeds.total} 응답, 고유 주소 ${seedRes.uniqueCount}개 (${seedRes.totalMs} ms)`,
  );
  if (seedRes.uniqueCount === 0) throw new Error('DNS 시드에서 주소를 하나도 못 얻음');

  // 시드별로 고르게 섞는다 — 한 시드의 주소만 골라 붙으면 "서로 다른 피어"가 아니다.
  const pool = interleaveBySeed(shuffle(seedRes.peers, opts.rng));

  // --- 1~2. 앵커 확정 (부트스트랩 워크는 별도 연결로 — 비교용 피어를 놀리지 않는다) ---
  //
  // 왜 두 단계로 나누는가: 헤더 워크는 수 분이 걸린다. 그동안 비교용 피어를 열어 둔 채
  // 놀리면 상대(Bitcoin Core)가 inbound 슬롯 정리로 끊는다 — 그러면 "응답 없는 피어
  // 비율"이 우리 쪽 대기 때문에 부풀려진다. 비교용은 워크가 끝난 뒤에 새로 붙인다.
  let anchor;
  const walkRecs = [];
  let bootstrapStats = null;

  if (opts.anchor) {
    anchor = { height: opts.anchor.height, hash: displayHashToInternal(opts.anchor.hash) };
    log(`[2/5] 앵커 지정됨 — height ${anchor.height} / ${opts.anchor.hash}`);
    log('[3/5] 부트스트랩 헤더 워크 생략');
    out.anchor = { source: 'cli', height: anchor.height, hash: opts.anchor.hash };
  } else {
    const bootCandidates = pool.slice(0, opts.bootstrapDial);
    log(`[2/5] 앵커 부트스트랩용 후보 ${bootCandidates.length}개 다이얼…`);
    const bootDials = await Promise.all(bootCandidates.map((a) => dialPeer(a, opts)));
    const bootReady = bootDials.filter((d) => d.peer);
    // 핸드셰이크 왕복이 빠른 순 — 워크 시간이 전체 실행시간을 지배하므로.
    bootReady.sort((a, b) => a.rec.handshakeMs - b.rec.handshakeMs);
    const bootstrap = bootReady.slice(0, opts.bootstrap);
    for (const d of bootReady.slice(opts.bootstrap)) await d.peer.close();
    bootstrapStats = {
      dialed: bootDials.length,
      ready: bootReady.length,
      walked: bootstrap.length,
    };
    if (bootstrap.length === 0) throw new Error('부트스트랩용 피어를 하나도 못 붙음');
    log(
      `      ${bootDials.length}개 중 ${bootReady.length}개 사용가능 → 가장 빠른 ${bootstrap.length}개로 워크`,
    );
    log(
      `[3/5] 피어 ${bootstrap.length}개가 제네시스부터 팁까지 각자 독립 헤더 워크 (수 분 소요)…`,
    );
    const walks = await Promise.all(
      bootstrap.map(async (r) => {
        try {
          const w = await walkHeadersToTip(r.peer, {
            maxRounds: opts.walkMaxRounds,
            deadlineAt: opts.walkDeadlineMs ? now() + opts.walkDeadlineMs : null,
            stopAtHeight: opts.stopAtHeight,
            onProgress: (h, rd) => {
              if (rd % 50 === 0) log(`      ${r.rec.id} … height ${h}`);
            },
          });
          return { rec: r.rec, walk: w, bytesIn: r.peer.bytesIn };
        } catch (e) {
          return { rec: r.rec, walk: { ok: false, error: shortErr(e), height: null }, bytesIn: r.peer.bytesIn };
        }
      }),
    );
    for (const d of bootstrap) await d.peer.close();
    for (const { rec, walk, bytesIn } of walks) {
      walkRecs.push({
        peer: rec.id,
        ua: rec.userAgent,
        ok: walk.ok,
        partial: walk.partial ?? false,
        error: walk.error,
        tipHeight: walk.height,
        rounds: walk.rounds ?? null,
        walkMs: walk.walkMs ?? null,
        mib: Math.round((bytesIn / 1048576) * 10) / 10,
        medianRoundMs: walk.roundMs?.length ? median(walk.roundMs) : null,
        tipHash: walk.ok ? internalHashToDisplay(walk.win[walk.win.length - 1]) : null,
      });
    }
    out.bootstrap_walks = walkRecs;
    out.bootstrap_stats = bootstrapStats;
    log('');
    log(table(
      walkRecs.map((w) => ({
        peer: w.peer,
        ok: w.ok ? 'Y' : 'N',
        tip: w.tipHeight ?? '-',
        tip_hash: short(w.tipHash),
        rounds: w.rounds ?? '-',
        walk_s: w.walkMs != null ? (w.walkMs / 1000).toFixed(1) : '-',
        MiB: w.mib ?? '-',
        med_ms: w.medianRoundMs ?? '-',
        error: w.error ?? '',
      })),
      ['peer', 'ok', 'tip', 'tip_hash', 'rounds', 'walk_s', 'MiB', 'med_ms', 'error'],
    ));
    log('');

    // 마감에 걸려 중간에 끊긴 워크(partial)는 앵커 투표에서 뺀다 — 팁까지 못 간
    // 체인의 "최소 팁"이 앵커를 엉뚱한 높이로 끌어내리고, 교차검증도 못 한다.
    const good = walks.filter((w) => w.walk.ok && !w.walk.partial);
    if (good.length === 0) {
      throw new Error(
        `앵커를 정할 완주 워크가 없음 (완주 0 / 시도 ${walks.length}) — --walk-deadline 을 늘려라`,
      );
    }
    if (good.length < 2) {
      log('      ! 완주 워크가 1개뿐 — 앵커 교차검증 없이 진행한다 (이 실행의 한계로 기록).');
    }

    const minTip = Math.min(...good.map((g) => g.walk.height));
    const anchorHeight = Math.max(1, minTip - opts.anchorLookback);
    const cand = good
      .map((g) => [g.rec.id, hashAtHeight(g.walk, anchorHeight)])
      .filter(([, h]) => h)
      .map(([id, h]) => [id, bytesToHex(h)]);
    const vote = groupBy(cand);
    if (!vote.majority) throw new Error('앵커 높이의 해시를 아무도 못 줌');
    anchor = { height: anchorHeight, hash: hexToBytes(vote.majority) };
    out.anchor = {
      source: 'bootstrap-majority',
      height: anchorHeight,
      hash: internalHashToDisplay(anchor.hash),
      votes: vote.groups.map((g) => ({ n: g.n, peers: g.peers })),
      unanimous: vote.unanimous,
      minTip,
      lookback: opts.anchorLookback,
    };
    log(
      `      앵커 = height ${anchorHeight} / ${internalHashToDisplay(anchor.hash)} ` +
        `(부트스트랩 ${vote.majorityN}/${cand.length} 일치${vote.unanimous ? ', 만장일치' : ''})`,
    );
  }

  // --- 3. 비교용 피어를 새로 붙이고 곧바로 묻는다 -------------------------
  // 부트스트랩과 겹치지 않는 주소부터 쓴다 — "서로 다른 피어"를 최대한 확보.
  const usedAddrs = new Set(walkRecs.map((w) => w.peer));
  const cmpPool = [
    ...pool.filter((p) => !usedAddrs.has(`${p.host}:${p.port}`)),
    ...pool.filter((p) => usedAddrs.has(`${p.host}:${p.port}`)),
  ];
  const candidates = cmpPool.slice(0, opts.dial);

  log(`[4/5] 비교용 후보 ${candidates.length}개 동시 다이얼 → 즉시 cfheaders + headers 요청…`);
  const dialResults = await Promise.all(candidates.map((a) => dialPeer(a, opts)));
  const dialRecs = dialResults.map((r) => r.rec);
  // 핸드셰이크에 성공한 피어는 전부 묻는다. 여기서 일부를 잘라 내면 아래 응답률
  // p = (응답 수 / 다이얼 수) 가 인위적으로 눌린다 — 정책 계산의 입력이 망가진다.
  const ready = dialResults.filter((r) => r.peer);
  const used = ready;
  const dialStats = {
    dialed: dialRecs.length,
    connect_fail: dialRecs.filter((r) => r.stage === 'connect').length,
    handshake_fail: dialRecs.filter((r) => r.stage === 'handshake').length,
    no_compact_filters: dialRecs.filter((r) => r.stage === 'services').length,
    ready: ready.length,
    used: used.length,
  };
  out.dial = { stats: dialStats, peers: dialRecs };
  log(
    `      연결실패 ${dialStats.connect_fail} · 핸드셰이크실패 ${dialStats.handshake_fail} · ` +
      `필터미지원 ${dialStats.no_compact_filters} · 사용가능 ${dialStats.ready} → 비교 ${dialStats.used}`,
  );
  if (used.length < opts.minPeers) {
    throw new Error(
      `비교용 피어가 ${used.length}개뿐 — 최소 ${opts.minPeers}개 필요. --dial 을 늘려라`,
    );
  }

  const probes = await Promise.all(
    used.map(async (r) => {
      const p = { peer: r.rec.id, ua: r.rec.userAgent, cf: null, hd: null, cfErr: null, hdErr: null };
      try {
        p.cf = await fetchCfHeaders(r.peer, anchor, opts.cfCount);
      } catch (e) {
        p.cfErr = shortErr(e);
      }
      try {
        p.hd = await fetchHeadersFromAnchor(r.peer, anchor, { maxRounds: opts.headerMaxRounds });
      } catch (e) {
        p.hdErr = shortErr(e);
      }
      return p;
    }),
  );

  // 헤더 원문 비교는 모두가 공통으로 준 길이만큼만 — 팁 지연 차이를 불일치로 오판하지 않는다.
  const hdOk = probes.filter((p) => p.hd && p.hd.anchorKnown && p.hd.headers?.length);
  const commonLen = hdOk.length ? Math.min(...hdOk.map((p) => p.hd.headers.length)) : 0;
  for (const p of hdOk) {
    p.hd.rangeDigest = headerRangeDigest(p.hd.headers, commonLen);
    p.hd.commonLen = commonLen;
    delete p.hd.headers; // JSON 폭주 방지
  }
  for (const p of probes) if (p.hd?.headers) delete p.hd.headers;

  for (const r of used) await r.peer.close();

  // --- 4. 비교 ------------------------------------------------------------
  const cfResponders = probes.filter((p) => p.cf);
  const cfEnd = groupBy(cfResponders.map((p) => [p.peer, p.cf.endHeader]));
  const cfDigest = groupBy(cfResponders.map((p) => [p.peer, p.cf.hashesDigest]));
  const cfPrev = groupBy(cfResponders.map((p) => [p.peer, p.cf.prevHeader]));

  // 핸드셰이크에 성공한 모든 피어의 version.start_height — 공짜로 얻는 팁 높이 표본.
  // (피어가 스스로 주장하는 높이. 검증된 값이 아니라 "주장"이라는 점을 표에 명시한다.)
  const startHeightGroups = groupBy(
    dialRecs.filter((d) => d.startHeight != null).map((d) => [d.id, d.startHeight]),
  );

  const hdResponders = probes.filter((p) => p.hd);
  const tipHeightGroups = groupBy(hdResponders.map((p) => [p.peer, p.hd.tipHeight]));
  const tipHashGroups = groupBy(hdResponders.map((p) => [p.peer, p.hd.tipHash]));
  const rangeGroups = groupBy(hdOk.map((p) => [p.peer, p.hd.rangeDigest]));

  // filter_hash 배열이 갈리면 어느 인덱스에서 처음 갈리는지 찾는다.
  let firstDiffIndex = null;
  if (cfDigest.distinct > 1) {
    const majPeers = new Set(cfDigest.groups[0].peers);
    const maj = cfResponders.find((p) => majPeers.has(p.peer));
    for (const p of cfResponders) {
      if (majPeers.has(p.peer)) continue;
      const a = maj.cf.filterHashes;
      const b = p.cf.filterHashes;
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          firstDiffIndex = firstDiffIndex ?? {};
          firstDiffIndex[p.peer] = {
            index: i,
            height: anchor.height - (opts.cfCount - 1) + i,
            majority: a[i] ?? null,
            theirs: b[i] ?? null,
          };
          break;
        }
      }
    }
  }
  for (const p of probes) if (p.cf) delete p.cf.filterHashes; // JSON 폭주 방지

  out.probe = {
    anchor_height: anchor.height,
    anchor_hash: internalHashToDisplay(anchor.hash),
    cf_range: [anchor.height - (opts.cfCount - 1), anchor.height],
    header_common_len: commonLen,
    peers: probes,
  };
  out.comparison = {
    cfheaders: {
      responders: cfResponders.length,
      of_used: used.length,
      end_header: summarize(cfEnd),
      hashes_digest: summarize(cfDigest),
      prev_header: summarize(cfPrev),
      first_diff: firstDiffIndex,
    },
    headers: {
      responders: hdResponders.length,
      anchor_known: hdResponders.filter((p) => p.hd.anchorKnown).length,
      tip_height: summarize(tipHeightGroups),
      tip_hash: summarize(tipHashGroups),
      common_range_digest: summarize(rangeGroups),
      version_start_height: summarize(startHeightGroups),
      tip_height_spread: tipHeightGroups.responders
        ? Math.max(...hdResponders.map((p) => p.hd.tipHeight ?? 0)) -
          Math.min(...hdResponders.map((p) => p.hd.tipHeight ?? 0))
        : null,
    },
  };

  // --- 5. 정책 계산 -------------------------------------------------------
  const pRespond = cfResponders.length / dialStats.dialed;
  const pRespondReady = ready.length ? cfResponders.length / ready.length : 0;
  const plans = planKofN(pRespond, opts.adversaryFractions, {
    availTarget: opts.availTarget,
    safetyTarget: opts.safetyTarget,
    maxN: opts.maxN,
  });
  out.policy = {
    p_respond_per_dialed: round4(pRespond),
    p_respond_per_ready: round4(pRespondReady),
    avail_target: opts.availTarget,
    safety_target: opts.safetyTarget,
    plans: plans.map((pl) => ({
      adversary_fraction: pl.f,
      pick: pl.pick
        ? { n: pl.pick.n, k: pl.pick.k, avail: round4(pl.pick.avail), p_bad: pl.pick.bad }
        : null,
    })),
    retry_model: planWithRetry(pRespond, opts.adversaryFractions, opts.safetyTarget).map((x) => ({
      adversary_fraction: x.f,
      responder_adversary_fraction: round4(x.fr),
      k: x.k,
      p_bad: x.pBad,
      expected_dials: Math.round(x.expectedDials * 10) / 10,
    })),
    grid: {
      f: opts.gridF,
      n_list: opts.gridN,
      rows: kofnGrid(pRespond, opts.gridF, opts.gridN).map((g) => ({
        n: g.n,
        k: g.k,
        avail: round4(g.avail),
        p_bad: g.bad,
      })),
    },
  };

  out.total_ms = ms(now() - t0);
  return { out, probes, cfEnd, cfDigest, cfPrev, tipHeightGroups, tipHashGroups, rangeGroups, startHeightGroups, plans, dialRecs, dialStats, anchor, used, commonLen, pRespond, walkRecs, opts };
}

function summarize(g) {
  return {
    distinct: g.distinct,
    unanimous: g.unanimous,
    strict_majority: g.strictMajority,
    majority_n: g.majorityN,
    responders: g.responders,
    minority_peers: g.minority,
    groups: g.groups.map((x) => ({ n: x.n, value: x.value, peers: x.peers })),
  };
}

const round4 = (x) => Math.round(x * 10000) / 10000;

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10;
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 시드별로 한 개씩 돌아가며 뽑는다 — 한 운영자의 주소 목록에 몰리지 않게. */
function interleaveBySeed(peers) {
  const bySeed = new Map();
  for (const p of peers) {
    const k = p.seed ?? '?';
    if (!bySeed.has(k)) bySeed.set(k, []);
    bySeed.get(k).push(p);
  }
  const lists = [...bySeed.values()];
  const out = [];
  for (let i = 0; out.length < peers.length; i++) {
    let progressed = false;
    for (const l of lists) {
      if (i < l.length) {
        out.push(l[i]);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 보고서
// ---------------------------------------------------------------------------

function report(r) {
  const { out, probes, cfEnd, cfDigest, tipHeightGroups, tipHashGroups, rangeGroups, startHeightGroups, plans, dialRecs, dialStats, anchor, commonLen, opts } = r;

  log('');
  log('═══ 피어별 실측 ═══════════════════════════════════════════════════════');
  log(
    table(
      probes.map((p) => {
        const d = dialRecs.find((x) => x.id === p.peer);
        return {
          peer: p.peer,
          ua: (p.ua ?? '').slice(0, 22),
          conn_ms: d?.connectMs ?? '-',
          hs_ms: d?.handshakeMs ?? '-',
          ver_h: d?.startHeight ?? '-',
          cf_ms: p.cf?.ms ?? '-',
          cf_n: p.cf ? `${p.cf.count}/${p.cf.expectedCount}` : '-',
          cf_end: short(p.cf?.endHeader, 16),
          hd_ms: p.hd?.ms ?? '-',
          tip_h: p.hd?.tipHeight ?? '-',
          tip_hash: short(p.hd?.tipHash, 16),
          err: [p.cfErr, p.hdErr].filter(Boolean).join(' | ').slice(0, 40),
        };
      }),
      ['peer', 'ua', 'conn_ms', 'hs_ms', 'ver_h', 'cf_ms', 'cf_n', 'cf_end', 'hd_ms', 'tip_h', 'tip_hash', 'err'],
    ),
  );

  const cfMs = probes.filter((p) => p.cf).map((p) => p.cf.ms);
  const hdMs = probes.filter((p) => p.hd).map((p) => p.hd.ms);
  log('');
  log('═══ 응답시간 요약 ═════════════════════════════════════════════════════');
  log(
    table(
      [
        stat('TCP connect', dialRecs.filter((d) => d.connectMs != null).map((d) => d.connectMs)),
        stat('handshake', dialRecs.filter((d) => d.handshakeMs != null).map((d) => d.handshakeMs)),
        stat(`cfheaders(${opts.cfCount})`, cfMs),
        stat('headers(앵커→팁)', hdMs),
      ].filter(Boolean),
      ['구간', 'n', 'min_ms', 'median_ms', 'max_ms'],
    ),
  );

  log('');
  log('═══ 다이얼 결과 (응답 없는 피어 비율) ══════════════════════════════════');
  const failRows = dialRecs
    .filter((d) => !d.ok)
    .map((d) => ({ peer: d.id, stage: d.stage, error: d.error ?? '' }));
  log(
    table(
      [
        { 항목: '다이얼한 후보', 수: dialStats.dialed, 비율: '100%' },
        { 항목: 'TCP 연결 실패', 수: dialStats.connect_fail, 비율: pct(dialStats.connect_fail, dialStats.dialed) },
        { 항목: '핸드셰이크 실패', 수: dialStats.handshake_fail, 비율: pct(dialStats.handshake_fail, dialStats.dialed) },
        { 항목: 'NODE_COMPACT_FILTERS 없음', 수: dialStats.no_compact_filters, 비율: pct(dialStats.no_compact_filters, dialStats.dialed) },
        { 항목: '사용 가능(핸드셰이크 OK)', 수: dialStats.ready, 비율: pct(dialStats.ready, dialStats.dialed) },
        { 항목: 'cfheaders 실제 응답', 수: out.comparison.cfheaders.responders, 비율: pct(out.comparison.cfheaders.responders, dialStats.dialed) },
      ],
      ['항목', '수', '비율'],
    ),
  );
  if (failRows.length) {
    log('');
    log(table(failRows.slice(0, 20), ['peer', 'stage', 'error']));
  }

  log('');
  log('═══ 비교 1 — cfheaders 바이트 단위 ═════════════════════════════════════');
  log(
    `구간: height ${out.probe.cf_range[0]} … ${out.probe.cf_range[1]} (${opts.cfCount}개 filter_hash), ` +
      `stop_hash = ${out.probe.anchor_hash}`,
  );
  log('');
  log(
    table(
      cfDigest.groups.map((g, i) => ({
        '#': i + 1,
        n: g.n,
        'filter_hash 배열 sha256': short(g.value, 24),
        peers: g.peers.join(', ').slice(0, 70),
      })),
      ['#', 'n', 'filter_hash 배열 sha256', 'peers'],
    ),
  );
  log('');
  log(
    table(
      cfEnd.groups.map((g, i) => ({
        '#': i + 1,
        n: g.n,
        '앵커 필터헤더(구간 전체 커밋)': short(g.value, 24),
        peers: g.peers.join(', ').slice(0, 70),
      })),
      ['#', 'n', '앵커 필터헤더(구간 전체 커밋)', 'peers'],
    ),
  );
  log('');
  log(
    `→ 서로 다른 값 ${cfDigest.distinct}개 / 응답 ${cfDigest.responders}개 · ` +
      `만장일치 ${cfDigest.unanimous ? 'YES' : 'NO'} · 다수결 성립 ${cfDigest.strictMajority ? 'YES' : 'NO'}` +
      (cfDigest.minority.length ? ` · 소수파: ${cfDigest.minority.join(', ')}` : ' · 소수파 없음'),
  );
  if (out.comparison.cfheaders.first_diff) {
    log('');
    log('첫 불일치 지점:');
    for (const [peer, d] of Object.entries(out.comparison.cfheaders.first_diff)) {
      log(`  ${peer}  height ${d.height}  다수=${short(d.majority, 20)}  자기=${short(d.theirs, 20)}`);
    }
  }

  log('');
  log('═══ 비교 2 — 헤더 체인 ════════════════════════════════════════════════');
  log(
    table(
      tipHeightGroups.groups.map((g, i) => ({
        '#': i + 1,
        n: g.n,
        tip_height: g.value,
        peers: g.peers.join(', ').slice(0, 70),
      })),
      ['#', 'n', 'tip_height', 'peers'],
    ),
  );
  log('');
  log(
    table(
      tipHashGroups.groups.map((g, i) => ({
        '#': i + 1,
        n: g.n,
        tip_hash: short(g.value, 20),
        peers: g.peers.join(', ').slice(0, 70),
      })),
      ['#', 'n', 'tip_hash', 'peers'],
    ),
  );
  log('');
  log(`핸드셰이크한 피어 전원의 version.start_height (피어의 자칭 팁 높이):`);
  log(
    table(
      startHeightGroups.groups.map((g, i) => ({
        '#': i + 1,
        n: g.n,
        start_height: g.value,
        peers: g.peers.join(', ').slice(0, 60),
      })),
      ['#', 'n', 'start_height', 'peers'],
    ),
  );

  log('');
  log(
    `팁 높이 분산: ${out.comparison.headers.tip_height_spread} 블록 · ` +
      `앵커 인지 ${out.comparison.headers.anchor_known}/${out.comparison.headers.responders}`,
  );
  log(
    `공통 구간(앵커+1 … 앵커+${commonLen}) 헤더 원문 sha256: 서로 다른 값 ${rangeGroups.distinct}개 / ` +
      `${rangeGroups.responders}개 응답 · 만장일치 ${rangeGroups.unanimous ? 'YES' : 'NO'}`,
  );
  if (rangeGroups.distinct > 1) {
    for (const [i, g] of rangeGroups.groups.entries()) {
      log(`  #${i + 1} n=${g.n}  ${short(g.value, 24)}  ${g.peers.join(', ')}`);
    }
  }

  log('');
  log('═══ 불일치 집계 ═══════════════════════════════════════════════════════');
  log(
    table(
      [
        verdict('cfheaders filter_hash 배열', cfDigest),
        verdict('cfheaders 앵커 필터헤더', cfEnd),
        verdict('헤더 공통구간 원문', rangeGroups),
        verdict('체인 팁 높이', tipHeightGroups),
        verdict('체인 팁 해시', tipHashGroups),
        verdict('version.start_height (자칭)', startHeightGroups),
      ],
      ['비교 대상', '응답', '서로 다른 값', '최다 그룹', '소수파 수', '만장일치', '다수결'],
    ),
  );
  log('');
  log(
    '※ 팁 높이·해시가 갈리는 것은 정상적 전파 지연일 수 있다 — 그래서 위 "헤더 공통구간 원문"은',
  );
  log('   모두가 공통으로 준 길이만큼만 잘라 비교한다. 거기서 갈리면 지연이 아니라 다른 체인이다.');

  log('');
  log('═══ k-of-n 정책 계산 ══════════════════════════════════════════════════');
  log(
    `실측 응답률 p = ${out.policy.p_respond_per_dialed} (cfheaders 응답 / 다이얼한 후보 ${dialStats.dialed}개)`,
  );
  log(`             = ${out.policy.p_respond_per_ready} (cfheaders 응답 / 핸드셰이크 성공 피어)`);
  log(`목표: 가용성 P(응답 k개 이상) ≥ ${opts.availTarget}, 안전성 P(적대 피어 k개 이상) ≤ ${opts.safetyTarget}`);
  log('');
  const rows = [];
  for (const pl of plans) {
    if (pl.pick) {
      rows.push({
        '적대비율 f': pl.f,
        '최소 n': pl.pick.n,
        k: pl.pick.k,
        '가용성 P(≥k 응답)': round4(pl.pick.avail),
        '오답채택 P': pl.pick.bad.toExponential(2),
      });
    } else {
      rows.push({
        '적대비율 f': pl.f,
        '최소 n': `해 없음(n≤${opts.maxN})`,
        k: '-',
        '가용성 P(≥k 응답)': '-',
        '오답채택 P': '-',
      });
    }
  }
  log(table(rows, ['적대비율 f', '최소 n', 'k', '가용성 P(≥k 응답)', '오답채택 P']));

  log('');
  log('재시도 허용 모형 — 응답 k개를 모을 때까지 다이얼하고 전원 일치를 요구:');
  log(
    table(
      out.policy.retry_model.map((x) => ({
        '적대비율 f': x.adversary_fraction,
        '응답자 중 적대 f_r': x.responder_adversary_fraction,
        'k (전원일치)': x.k,
        '오답채택 P = f_r^k': x.p_bad.toExponential(2),
        '기대 다이얼 수': x.expected_dials,
      })),
      ['적대비율 f', '응답자 중 적대 f_r', 'k (전원일치)', '오답채택 P = f_r^k', '기대 다이얼 수'],
    ),
  );

  log('');
  log(`격자 (f = ${opts.gridF}, p = ${out.policy.p_respond_per_dialed}) — 추천값의 근거:`);
  const grid = kofnGrid(r.pRespond, opts.gridF, opts.gridN);
  log(
    table(
      grid.map((g) => ({
        n: g.n,
        k: g.k,
        'P(응답≥k)': g.avail.toFixed(4),
        'P(적대≥k)': g.bad < 1e-4 ? g.bad.toExponential(1) : g.bad.toFixed(4),
        판정:
          g.avail >= opts.availTarget && g.bad <= opts.safetyTarget
            ? '통과'
            : g.avail < opts.availTarget
              ? '가용성 미달'
              : '안전성 미달',
      })),
      ['n', 'k', 'P(응답≥k)', 'P(적대≥k)', '판정'],
    ),
  );

  log('');
  log(`총 소요: ${(out.total_ms / 1000).toFixed(1)} s`);
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '-');

function verdict(label, g) {
  return {
    '비교 대상': label,
    응답: g.responders,
    '서로 다른 값': g.distinct,
    '최다 그룹': `${g.majorityN}/${g.responders}`,
    '소수파 수': g.minority.length,
    만장일치: g.responders > 1 ? (g.unanimous ? 'YES' : 'NO') : '-',
    다수결: g.responders > 1 ? (g.strictMajority ? 'YES' : 'NO') : '-',
  };
}

function stat(label, xs) {
  if (!xs.length) return { 구간: label, n: 0, min_ms: '-', median_ms: '-', max_ms: '-' };
  return {
    구간: label,
    n: xs.length,
    min_ms: Math.min(...xs),
    median_ms: median(xs),
    max_ms: Math.max(...xs),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `multi-peer.mjs — BIP157 다중 피어 교차 검증 실측

  --dial <n>          다이얼할 후보 수 (기본 28)
  --min-peers <n>     비교에 최소한 필요한 피어 수 (기본 5). 핸드셰이크 성공 피어는 전부 쓴다
  --bootstrap <n>     앵커용 헤더 워크를 돌릴 피어 수 (기본 3)
  --bootstrap-dial <n>  그 후보를 몇 개 다이얼해 볼지 (기본 9, 빠른 순으로 채택)
  --anchor <h:hash>   앵커 직접 지정 (display hex) — 헤더 워크 생략
  --anchor-lookback <n>  앵커 = (부트스트랩 최소 팁 - n). 기본 1000
  --walk-deadline <ms>   헤더 워크 마감 (기본 480000). 넘긴 워크는 앵커 투표에서 제외
  --cf-count <n>      비교할 filter_hash 개수 (기본 1000, 최대 2000)
  --stop-at <h>       헤더 워크 상한 높이 (디버그용)
  --connect-timeout <ms>  기본 8000
  --msg-timeout <ms>      기본 30000
  --v6                IPv6 주소도 후보에 포함 (기본 off — v6 없는 호스트에서 응답률을 왜곡)
  --avail <p>         가용성 목표 (기본 0.99)
  --safety <p>        오답 채택 상한 (기본 0.001)
  --max-n <n>         (n,k) 탐색 상한 (기본 40)
  --grid-f <f>        격자 출력에 쓸 적대 비율 (기본 0.2)
  --seed <n>          후보 셔플 시드 (재현용)
  --json              JSON 을 stdout 으로 (표는 항상 stderr)
`;

function parseArgs(argv) {
  const o = {
    dial: 28,
    minPeers: 5,
    bootstrap: 3,
    bootstrapDial: 9,
    anchor: null,
    anchorLookback: 1000,
    cfCount: 1000,
    stopAtHeight: null,
    connectTimeoutMs: 8000,
    msgTimeoutMs: 30000,
    dnsTimeoutMs: 8000,
    walkMaxRounds: 2000,
    walkDeadlineMs: 480000,
    headerMaxRounds: 8,
    v6: false,
    availTarget: 0.99,
    safetyTarget: 0.001,
    adversaryFractions: [0.1, 0.2, 0.33, 0.5],
    gridF: 0.2,
    gridN: [4, 6, 8, 10, 12],
    maxN: 40,
    userAgent: '/byeorin-multipeer:0.0.1/',
    json: false,
    seed: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dial') o.dial = Number(next());
    else if (a === '--peers' || a === '--min-peers') o.minPeers = Number(next());
    else if (a === '--bootstrap') o.bootstrap = Number(next());
    else if (a === '--bootstrap-dial') o.bootstrapDial = Number(next());
    else if (a === '--anchor') {
      const [h, hash] = String(next()).split(':');
      o.anchor = { height: Number(h), hash };
    } else if (a === '--anchor-lookback') o.anchorLookback = Number(next());
    else if (a === '--cf-count') o.cfCount = Number(next());
    else if (a === '--stop-at') o.stopAtHeight = Number(next());
    else if (a === '--connect-timeout') o.connectTimeoutMs = Number(next());
    else if (a === '--msg-timeout') o.msgTimeoutMs = Number(next());
    else if (a === '--v6') o.v6 = true;
    else if (a === '--avail') o.availTarget = Number(next());
    else if (a === '--safety') o.safetyTarget = Number(next());
    else if (a === '--seed') o.seed = Number(next());
    else if (a === '--grid-f') o.gridF = Number(next());
    else if (a === '--walk-deadline') o.walkDeadlineMs = Number(next());
    else if (a === '--max-n') o.maxN = Number(next());
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  if (o.cfCount > 2000) throw new Error('--cf-count 상한은 2000 (BIP157 규정)');
  return o;
}

/** 재현 가능한 셔플용 mulberry32. --seed 없으면 Math.random. */
function makeRng(seed) {
  if (seed == null) return Math.random;
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stderr.write(HELP);
    return;
  }
  opts.rng = makeRng(opts.seed);
  const r = await runMultiPeer(opts);
  report(r);
  if (opts.json) {
    const clean = { ...r.out };
    delete clean.options.rng;
    process.stdout.write(`${JSON.stringify(clean, null, 2)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      process.stderr.write(`${e?.stack || e}\n`);
      process.exit(1);
    });
}
