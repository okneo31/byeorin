// bootstrap.mjs — BIP157 실측 시험용 체크포인트 픽스처를 실피어에서 직접 채취 (부대 4/16).
//
// 사용법:
//   node bootstrap.mjs --peers <peers.json> --out <fixture.json>
//
// 절차:
//   1. 피어 1곳 핸드셰이크 → 제네시스부터 getheaders 루프로 tip 까지 헤더 사슬 구축.
//   2. H = tip − 300. getcfheaders(H, hash(H)) 를 서로 다른 피어 ≥7곳에 보내
//      computeFilterHeader(filterHashes[0], previousFilterHeader) 로 filterHeader(H) 계산.
//      ≥5곳 동일 값이면 쿼럼 성립 → 체크포인트 채택.
//   3. 그라운드트루스: H+150 블록을 getdata 로 내려받아 scriptPubKey 3개(P2WPKH 우선)
//      + txid 채취. cfilter(H+150) 로 gcsMatchAny 교차확인(가능할 때).
//   4. fixture.json 저장.
//
// bip157Scan 은 쓰지 않는다 — dist 프리미티브 + node-transport.mjs 만.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DIST = resolve(REPO_ROOT, 'packages', 'wallet-sdk', 'dist', 'btc-history.js');

const GENESIS_DISPLAY =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

const sdk = await import(pathToFileURL(DIST).href);
const {
  buildVersionPayload,
  parseVersionPayload,
  buildVerackMessage,
  buildPongPayload,
  parsePingPayload,
  hasCompactFilters,
  P2PFrameDecoder,
  encodeMessage,
  encodeGetHeaders,
  decodeHeadersMessage,
  encodeGetCfHeaders,
  decodeCfHeaders,
  encodeGetCfilters,
  decodeCfilter,
  computeFilterHeader,
  computeFilterHash,
  encodeGetData,
  decodeBlock,
  filterKeyFromBlockHash,
  gcsMatchAny,
  isCoinbase,
  displayHashToInternal,
  internalHashToDisplay,
  bytesToHex,
  bytesEqual,
  INV_BLOCK,
  ZERO_HASH,
  FILTER_TYPE_BASIC,
} = sdk;

const { createNodeTcpTransport } = await import(
  pathToFileURL(resolve(__dirname, 'node-transport.mjs')).href
);

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--peers') out.peers = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.peers || !out.out) {
    throw new Error('Usage: node bootstrap.mjs --peers <peers.json> --out <fixture.json>');
  }
  return out;
}

// ---------------------------------------------------------------------------
// PeerSession — transport + 프레이머 + 핸드셰이크 + 요청/응답 대기
// ---------------------------------------------------------------------------

/** 대기자가 없어도 inbox 에 남겨둘 명령 (요청-응답 레이스 방지). */
const KEEP = new Set(['version', 'verack', 'headers', 'cfheaders', 'cfilter', 'block', 'notfound', 'pong']);

class PeerSession {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.transport = createNodeTcpTransport();
    this.decoder = new P2PFrameDecoder();
    this.inbox = [];
    this.waiters = []; // { commands:Set, resolve, reject, timer }
    this.closedErr = null;
    this.versionFields = null;
  }

  _fail(err) {
    if (this.closedErr) return;
    this.closedErr = err;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  _dispatch(msg) {
    if (msg.command === 'ping') {
      // 자동 pong — 실패는 무시 (연결 종료 중일 수 있음)
      this.send('pong', buildPongPayload(parsePingPayload(msg.payload))).catch(() => {});
      return;
    }
    const idx = this.waiters.findIndex((w) => w.commands.has(msg.command));
    if (idx >= 0) {
      const [w] = this.waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    if (KEEP.has(msg.command)) {
      this.inbox.push(msg);
      if (this.inbox.length > 64) this.inbox.shift();
    }
    // 그 외 (sendheaders/sendcmpct/feefilter/addr/inv/wtxidrelay/…) 는 버린다.
  }

  async connect(timeoutMs = 8000) {
    this.transport.onData((chunk) => {
      let msgs;
      try {
        msgs = this.decoder.push(chunk);
      } catch (err) {
        this._fail(err);
        this.transport.close().catch(() => {});
        return;
      }
      for (const m of msgs) this._dispatch(m);
    });
    this.transport.onClose((err) => {
      this._fail(err ?? new Error(`peer closed connection (${this.host}:${this.port})`));
    });
    await this.transport.connect(this.host, this.port, { timeoutMs });
  }

  send(command, payload) {
    return this.transport.send(encodeMessage(command, payload));
  }

  waitFor(commands, timeoutMs) {
    const set = new Set(Array.isArray(commands) ? commands : [commands]);
    const idx = this.inbox.findIndex((m) => set.has(m.command));
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise((resolveP, rejectP) => {
      const w = { commands: set, resolve: resolveP, reject: rejectP, timer: null };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        rejectP(new Error(`timeout ${timeoutMs}ms waiting for [${[...set]}] (${this.host})`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** version/verack 핸드셰이크. 반환: 상대 version 필드. */
  async handshake(timeoutMs = 10000) {
    await this.send('version', buildVersionPayload({ startHeight: 0, relay: false }));
    let gotVersion = false;
    let gotVerack = false;
    const deadline = Date.now() + timeoutMs;
    while (!gotVersion || !gotVerack) {
      const remain = deadline - Date.now();
      if (remain <= 0) throw new Error(`handshake timeout (${this.host})`);
      const msg = await this.waitFor(['version', 'verack'], remain);
      if (msg.command === 'version') {
        this.versionFields = parseVersionPayload(msg.payload);
        gotVersion = true;
        await this.transport.send(buildVerackMessage());
      } else {
        gotVerack = true;
      }
    }
    return this.versionFields;
  }

  async close() {
    try {
      await this.transport.close();
    } catch {
      /* 이미 닫힘 */
    }
  }
}

// ---------------------------------------------------------------------------
// 1+2. 헤더 동기화 — 제네시스 → tip
// ---------------------------------------------------------------------------

const HEADER_TIMEOUT_MS = 30000;

/**
 * chain: chain[h] = internal 블록해시(32B). 이어받기 지원 — 피어 교체 시 유지.
 * 반환 { peerHost }: 마지막으로 성공한 피어.
 */
async function syncHeadersFromPeer(session, chain) {
  for (;;) {
    const locator =
      chain.length > 1 ? [chain[chain.length - 1], chain[0]] : [chain[0]];
    await session.send('getheaders', encodeGetHeaders(locator, ZERO_HASH));
    const msg = await session.waitFor('headers', HEADER_TIMEOUT_MS);
    const headers = decodeHeadersMessage(msg.payload);
    if (headers.length === 0) return;
    for (const h of headers) {
      const tipHash = chain[chain.length - 1];
      if (bytesEqual(h.prevBlockHash, tipHash)) {
        chain.push(h.hash);
        continue;
      }
      if (bytesEqual(h.hash, tipHash)) continue; // 중복
      // 얕은 재편성: prev 가 최근 12개 안에 있으면 그 지점부터 다시 잇는다.
      let reorged = false;
      for (let d = 2; d <= 12 && chain.length - d >= 0; d++) {
        if (bytesEqual(h.prevBlockHash, chain[chain.length - d])) {
          chain.length = chain.length - d + 1;
          chain.push(h.hash);
          reorged = true;
          break;
        }
      }
      if (!reorged) {
        throw new Error(
          `headers not connected at height ~${chain.length} (${session.host})`,
        );
      }
    }
    if (headers.length < 2000) return; // tip 도달
  }
}

async function syncHeaders(peers) {
  const chain = [displayHashToInternal(GENESIS_DISPLAY)];
  let attempts = 0;
  const errors = [];
  for (const p of peers) {
    if (attempts >= 3) break;
    const session = new PeerSession(p.host, p.port);
    try {
      await session.connect(8000);
      await session.handshake(10000);
    } catch (err) {
      // 접속 자체가 안 되는 피어는 시도 횟수에 세지 않는다.
      errors.push(`${p.host}: connect/handshake: ${err.message}`);
      await session.close();
      continue;
    }
    attempts++;
    try {
      const t0 = performance.now();
      await syncHeadersFromPeer(session, chain);
      const ms = Math.round(performance.now() - t0);
      await session.close();
      return { chain, headerSyncMs: ms, syncPeer: p.host, errors };
    } catch (err) {
      errors.push(`${p.host}: sync: ${err.message}`);
      await session.close();
      // chain 은 유지 — 다음 피어에서 이어받는다.
    }
  }
  throw new Error(`header sync failed after ${attempts} peers: ${errors.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// 3. cfheaders 쿼럼
// ---------------------------------------------------------------------------

async function askFilterHeader(peer, H, stopHashH) {
  const session = new PeerSession(peer.host, peer.port);
  try {
    await session.connect(8000);
    const ver = await session.handshake(10000);
    if (!hasCompactFilters(ver.services)) {
      throw new Error('no NODE_COMPACT_FILTERS');
    }
    await session.send('getcfheaders', encodeGetCfHeaders(H, stopHashH));
    const msg = await session.waitFor('cfheaders', 20000);
    const cf = decodeCfHeaders(msg.payload);
    if (cf.filterType !== FILTER_TYPE_BASIC) throw new Error(`filterType=${cf.filterType}`);
    if (!bytesEqual(cf.stopHash, stopHashH)) throw new Error('stopHash mismatch');
    if (cf.filterHashes.length !== 1) {
      throw new Error(`filterHashes.length=${cf.filterHashes.length}`);
    }
    const header = computeFilterHeader(cf.filterHashes[0], cf.previousFilterHeader);
    return { host: peer.host, sent: true, headerHex: bytesToHex(header) };
  } finally {
    await session.close();
  }
}

async function quorumFilterHeader(peers, H, stopHashH, wantResponses = 9) {
  const results = []; // { host, headerHex }
  let sentCount = 0;
  const errors = [];
  const queue = [...peers];
  const CONCURRENCY = 5;

  async function worker() {
    for (;;) {
      if (results.length >= wantResponses) return;
      const peer = queue.shift();
      if (!peer) return;
      try {
        const r = await askFilterHeader(peer, H, stopHashH);
        results.push(r);
        sentCount++;
      } catch (err) {
        if (/timeout .*cfheaders|stopHash mismatch|filterHashes|filterType/.test(err.message)) {
          sentCount++; // getcfheaders 를 보냈으나 유효 응답 실패
        }
        errors.push(`${peer.host}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // 다수결
  const tally = new Map();
  for (const r of results) {
    const e = tally.get(r.headerHex) ?? { count: 0, hosts: [] };
    e.count++;
    e.hosts.push(r.host);
    tally.set(r.headerHex, e);
  }
  let best = null;
  for (const [hex, e] of tally) {
    if (!best || e.count > best.count) best = { hex, count: e.count, hosts: e.hosts };
  }
  return {
    asked: sentCount,
    responded: results.length,
    best,
    errors,
  };
}

// ---------------------------------------------------------------------------
// 4. 그라운드트루스 블록
// ---------------------------------------------------------------------------

function classifyScript(spk) {
  if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14) return 'p2wpkh';
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) return 'p2tr';
  if (spk.length === 34 && spk[0] === 0x00 && spk[1] === 0x20) return 'p2wsh';
  if (spk.length === 25 && spk[0] === 0x76) return 'p2pkh';
  if (spk.length === 23 && spk[0] === 0xa9) return 'p2sh';
  if (spk.length > 0 && spk[0] === 0x6a) return 'opreturn';
  return 'other';
}

async function fetchGroundTruth(peerHosts, allPeers, blockHashInternal, blockHeight) {
  // 쿼럼에 동의한 피어 우선, 그다음 나머지.
  const ordered = [
    ...allPeers.filter((p) => peerHosts.includes(p.host)),
    ...allPeers.filter((p) => !peerHosts.includes(p.host)),
  ];
  const errors = [];
  for (const p of ordered.slice(0, 8)) {
    const session = new PeerSession(p.host, p.port);
    try {
      await session.connect(8000);
      await session.handshake(10000);
      await session.send(
        'getdata',
        encodeGetData([{ type: INV_BLOCK, hash: blockHashInternal }]),
      );
      const msg = await session.waitFor(['block', 'notfound'], 60000);
      if (msg.command === 'notfound') throw new Error('notfound');
      const block = decodeBlock(msg.payload);
      if (!bytesEqual(block.header.hash, blockHashInternal)) {
        throw new Error('block hash mismatch');
      }
      // cfilter 교차확인용으로 같은 피어에서 필터도 받아본다 (있으면).
      let filterBytes = null;
      if (hasCompactFilters(session.versionFields.services)) {
        try {
          await session.send(
            'getcfilters',
            encodeGetCfilters(blockHeight, blockHashInternal), // 정확히 1개 요청
          );
        } catch {
          /* 무시 */
        }
      }
      return { block, host: p.host, session, filterBytes };
    } catch (err) {
      errors.push(`${p.host}: ${err.message}`);
      await session.close();
    }
  }
  throw new Error(`ground-truth block fetch failed: ${errors.join(' | ')}`);
}

function pickWatchScripts(block, blockHeight) {
  // 후보 수집: (스크립트 hex, txid display, 종류). 코인베이스 제외, OP_RETURN 제외.
  const candidates = [];
  const seenScripts = new Set();
  for (const tx of block.transactions) {
    if (isCoinbase(tx)) continue;
    const txid = internalHashToDisplay(tx.txid);
    for (const out of tx.outputs) {
      const kind = classifyScript(out.scriptPubKey);
      if (kind === 'opreturn' || out.scriptPubKey.length === 0) continue;
      const hex = bytesToHex(out.scriptPubKey);
      if (seenScripts.has(hex)) continue;
      seenScripts.add(hex);
      candidates.push({ hex, txid, kind });
    }
  }
  // P2WPKH 우선, 서로 다른 txid 3개 우선.
  const prefOrder = ['p2wpkh', 'p2tr', 'p2pkh', 'p2sh', 'p2wsh', 'other'];
  candidates.sort((a, b) => prefOrder.indexOf(a.kind) - prefOrder.indexOf(b.kind));
  const picked = [];
  const usedTxids = new Set();
  for (const c of candidates) {
    if (picked.length >= 3) break;
    if (usedTxids.has(c.txid)) continue;
    picked.push(c);
    usedTxids.add(c.txid);
  }
  // 서로 다른 txid 3개가 안 나오면 같은 txid 허용
  for (const c of candidates) {
    if (picked.length >= 3) break;
    if (picked.some((p) => p.hex === c.hex)) continue;
    picked.push(c);
  }
  if (picked.length < 3) throw new Error(`only ${picked.length} distinct scripts in block`);
  return picked.map((c) => ({
    scriptHex: c.hex,
    txid: c.txid,
    height: blockHeight,
    kind: c.kind,
  }));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const peersPath = isAbsolute(args.peers) ? args.peers : resolve(process.cwd(), args.peers);
  const outPath = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);
  const peers = JSON.parse(readFileSync(peersPath, 'utf8'));

  // 1+2. 헤더 동기화
  console.log(`[1/4] header sync from genesis (peers=${peers.length}) ...`);
  const { chain, headerSyncMs, syncPeer, errors: syncErrors } = await syncHeaders(peers);
  const tipHeight = chain.length - 1;
  const tipHash = internalHashToDisplay(chain[tipHeight]);
  console.log(
    `      tip=${tipHeight} (${tipHash}) headers=${tipHeight} ms=${headerSyncMs} peer=${syncPeer}`,
  );
  if (syncErrors.length) console.log(`      sync errors: ${syncErrors.join(' | ')}`);

  // 3. H = tip - 300, cfheaders 쿼럼
  const H = tipHeight - 300;
  const hashH = chain[H];
  console.log(`[2/4] cfheaders quorum at H=${H} (${internalHashToDisplay(hashH)}) ...`);
  const q = await quorumFilterHeader(peers, H, hashH);
  console.log(
    `      asked=${q.asked} responded=${q.responded} best=${q.best ? `${q.best.count} @ ${q.best.hex.slice(0, 16)}…` : 'none'}`,
  );
  if (q.errors.length) console.log(`      quorum errors: ${q.errors.join(' | ')}`);
  if (!q.best || q.best.count < 5 || q.asked < 7) {
    throw new Error(
      `quorum failed: asked=${q.asked} agreed=${q.best ? q.best.count : 0} (need asked>=7, agreed>=5)`,
    );
  }
  const filterHeaderHex = q.best.hex;

  // 4. 그라운드트루스 블록 H+150
  const gtHeight = H + 150;
  const gtHash = chain[gtHeight];
  console.log(`[3/4] ground-truth block ${gtHeight} (${internalHashToDisplay(gtHash)}) ...`);
  const { block, host: gtPeer, session: gtSession } = await fetchGroundTruth(
    q.best.hosts,
    peers,
    gtHash,
    gtHeight,
  );
  const picked = pickWatchScripts(block, gtHeight);
  console.log(
    `      peer=${gtPeer} txs=${block.transactions.length} picked=${picked
      .map((p) => `${p.kind}:${p.txid.slice(0, 12)}…`)
      .join(', ')}`,
  );

  // cfilter 교차확인 (같은 피어가 필터를 주면): watchScripts 가 실제로 매치되는지.
  let filterCrossCheck = null;
  try {
    const msg = await gtSession.waitFor('cfilter', 15000);
    const cf = decodeCfilter(msg.payload);
    if (bytesEqual(cf.blockHash, gtHash)) {
      const key = filterKeyFromBlockHash(gtHash);
      const targets = picked.map((p) => sdk.hexToBytes(p.scriptHex));
      filterCrossCheck = {
        matched: gcsMatchAny(cf.filterBytes, key, targets),
        filterHashHex: bytesToHex(computeFilterHash(cf.filterBytes)),
      };
    }
  } catch {
    filterCrossCheck = null; // 피어가 필터 미제공 — 교차확인 생략
  }
  await gtSession.close();
  if (filterCrossCheck && filterCrossCheck.matched === false) {
    throw new Error('cross-check failed: picked scripts do not match block cfilter');
  }

  // 5. fixture.json
  const fixture = {
    checkpoint: {
      height: H,
      blockHash: internalHashToDisplay(hashH),
      filterHeader: filterHeaderHex,
    },
    stopAtHeight: tipHeight,
    watchScripts: picked.map((p) => p.scriptHex),
    expected: picked.map((p) => ({ txid: p.txid, height: p.height })),
    meta: {
      tipHash,
      quorum: { asked: q.asked, agreed: q.best.count, peers: q.best.hosts },
      headerSyncMs,
      headerCount: tipHeight,
      syncPeer,
      groundTruthPeer: gtPeer,
      groundTruthBlock: internalHashToDisplay(gtHash),
      filterCrossCheck,
      generatedAtIso: new Date().toISOString(),
    },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(fixture, null, 2), 'utf8');
  console.log(`[4/4] fixture written → ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`BOOTSTRAP FAIL: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
