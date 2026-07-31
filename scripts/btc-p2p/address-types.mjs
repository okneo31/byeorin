// address-types.mjs — 벼린이 실제로 쓰는 BTC 주소 유형이 BIP157/158 스캔에서
// 빠짐없이 잡히는지 실블록으로 확인한다.
//
// 왜 필요한가: BIP158 필터에 들어가는 항목은 두 종류다 —
//   (1) 그 블록 출력들의 scriptPubKey (OP_RETURN·빈 스크립트 제외)
//   (2) 그 블록 입력들이 소비한 "이전 출력"의 scriptPubKey
// 받는 쪽(1)만 확인하면 지출 이력을 통째로 놓친다. 이 스크립트는 (1)·(2)를
// 실블록에서 각각 실측하고, 벼린이 실제로 파생하는 주소 유형별로 표를 낸다.
//
// 쓰기 영역 규칙: 이 파일만 새로 만든다. 전송은 ./node-transport.mjs 고정,
// 프로토콜·GCS·스캔은 전부 SDK dist(@byeorin/wallet-sdk/btc-history)에서 가져온다.
//
// 사용:
//   node scripts/btc-p2p/address-types.mjs                 # 시드 → 피어 자동 선택
//   node scripts/btc-p2p/address-types.mjs --peer 1.2.3.4:8333
//   node scripts/btc-p2p/address-types.mjs --json out.json  # 결과 JSON 저장
//   node scripts/btc-p2p/address-types.mjs --offline        # 실피어 없이 파생·벡터만
//
// 단계:
//   1. 벼린 파생 주소 유형 확인 (SDK BtcAdapter — BIP84 p2wpkh · BIP86 p2tr)
//   2. 실피어에서 최신 블록 H, H-1 과 그 basic filter 수신
//   3. 블록 H 출력 스크립트를 유형별로 분류 → 유형별 gcsMatchAny 성공/실패 표
//   4. 입력 쪽: H 의 입력이 소비한 H-1 의 출력 스크립트가 필터 H 에 들었는지
//      (그 스크립트가 H 안의 출력으로는 등장하지 않는 것만 골라야 판별이 된다)
//   5. bip157Scan 종단 실행 — 받기 유형별 + 지출(입력) 검출

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  BtcAdapter,
  deriveSecp256k1,
  mnemonicToSeed,
} from '../../packages/wallet-sdk/dist/index.js';
import {
  MAINNET_MAGIC,
  P2PFrameDecoder,
  FILTER_TYPE_BASIC,
  INV_BLOCK,
  addressToScriptPubKey,
  bip157Scan,
  buildPongPayload,
  buildVersionPayload,
  bytesEqual,
  bytesToHex,
  computeFilterHash,
  computeFilterHeader,
  decodeBlock,
  decodeCfHeaders,
  decodeCfilter,
  decodeHeadersMessage,
  encodeGetCfHeaders,
  encodeGetCfilters,
  encodeGetData,
  encodeGetHeaders,
  encodeMessage,
  filterKeyFromBlockHash,
  gcsMatchAny,
  hasCompactFilters,
  internalHashToDisplay,
  isCoinbase,
  parsePingPayload,
  parseVersionPayload,
} from '../../packages/wallet-sdk/dist/btc-history.js';

import { NodeTcpTransport } from './node-transport.mjs';
import { collectPeers, FILTER_PREFIX_CF } from './seeds.mjs';

// ---------------------------------------------------------------------------
// 1. 벼린 파생 주소 유형
// ---------------------------------------------------------------------------

/** BIP39 공식 테스트 니모닉 — 자금 없음. BIP84/BIP86 공식 벡터와 대조하기 위해 쓴다. */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** 공식 벡터: BIP84 (m/84'/0'/0'/0/0) · BIP86 (m/86'/0'/0'/0/0) 첫 주소. */
const OFFICIAL_VECTORS = {
  p2wpkh: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  p2tr: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
};

/**
 * 벼린이 실제로 파생하는 주소 유형을 SDK 그대로 뽑는다.
 * @returns {{type:string, path:string, address:string, script:string, scriptType:string,
 *            vectorMatch:boolean|null, buildTransfer:string}[]}
 */
export async function byeorinAddressTypes(mnemonic = TEST_MNEMONIC) {
  const seed = mnemonicToSeed(mnemonic);
  const out = [];
  for (const type of ['p2wpkh', 'p2tr']) {
    const adapter = new BtcAdapter({ addressType: type });
    const path = adapter.derivationPath(0, 0);
    const { publicKey } = deriveSecp256k1(seed, path);
    const address = adapter.pubkeyToAddress(publicKey);
    const script = addressToScriptPubKey(address, 'mainnet');
    // buildTransfer 구현 여부만 본다. p2tr 은 첫 줄에서 throw 하므로 네트워크를 안 탄다.
    // p2wpkh 는 실제로 UTXO 조회로 넘어가므로 여기서 부르지 않는다(측정 목적 밖).
    let buildTransfer = 'not probed (network path)';
    if (type === 'p2tr') {
      buildTransfer = 'ok';
      try {
        await adapter.buildTransfer(
          { to: address, amount: 1n },
          { sender: address, signer: { publicKey: async () => publicKey } },
        );
      } catch (e) {
        buildTransfer = `throws: ${e.message}`;
      }
    }
    out.push({
      type,
      path,
      address,
      script: bytesToHex(script),
      scriptType: classifyScript(script),
      vectorMatch: OFFICIAL_VECTORS[type] ? address === OFFICIAL_VECTORS[type] : null,
      buildTransfer,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 스크립트 유형 분류 (표준 출력 유형만 — 나머지는 other)
// ---------------------------------------------------------------------------

export function classifyScript(s) {
  const n = s.length;
  if (n === 0) return 'empty';
  if (s[0] === 0x6a) return 'op_return';
  if (n === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac)
    return 'p2pkh';
  if (n === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return 'p2sh';
  if (n === 22 && s[0] === 0x00 && s[1] === 0x14) return 'p2wpkh';
  if (n === 34 && s[0] === 0x00 && s[1] === 0x20) return 'p2wsh';
  if (n === 34 && s[0] === 0x51 && s[1] === 0x20) return 'p2tr';
  if (n === 35 && s[0] === 0x21 && s[34] === 0xac) return 'p2pk';
  if (n === 67 && s[0] === 0x41 && s[66] === 0xac) return 'p2pk';
  if (n >= 4 && n <= 42 && (s[0] === 0x00 || (s[0] >= 0x51 && s[0] <= 0x60)) && s[1] === n - 2)
    return 'witness_unknown';
  return 'other';
}

// ---------------------------------------------------------------------------
// 최소 피어 래퍼 (scan.ts 의 Peer 와 같은 방식 — 여기선 원시 블록·필터가 필요해서 직접 쓴다)
// ---------------------------------------------------------------------------

const IGNORED = new Set([
  'sendheaders', 'sendcmpct', 'wtxidrelay', 'sendaddrv2', 'addr', 'addrv2',
  'inv', 'tx', 'feefilter', 'getheaders', 'getaddr', 'alert', 'pong',
]);

class Peer {
  #decoder;
  #queue = [];
  #waiter = null;
  #closed = null;

  constructor(transport, magic, timeoutMs) {
    this.transport = transport;
    this.magic = magic;
    this.timeoutMs = timeoutMs;
    this.#decoder = new P2PFrameDecoder(magic);
    transport.onData((chunk) => this.#onChunk(chunk));
    transport.onClose((err) => this.#onClose(err ?? new Error('peer closed')));
  }

  #onChunk(chunk) {
    let msgs;
    try {
      msgs = this.#decoder.push(chunk);
    } catch (e) {
      this.#onClose(e);
      return;
    }
    for (const m of msgs) {
      if (m.command === 'ping') {
        this.send('pong', buildPongPayload(parsePingPayload(m.payload))).catch(() => undefined);
        continue;
      }
      if (IGNORED.has(m.command)) continue;
      this.#queue.push(m);
      this.#deliver();
    }
  }

  #onClose(err) {
    if (this.#closed) return;
    this.#closed = err;
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
    await this.transport.send(encodeMessage(command, payload, this.magic));
  }

  next(...commands) {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#waiter) return Promise.reject(new Error('peer: concurrent next()'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new Error(`peer: timeout waiting for [${commands.join(', ')}]`));
      }, this.timeoutMs);
      this.#waiter = { commands: new Set(commands), resolve, reject, timer };
      this.#deliver();
    });
  }
}

async function handshake(peer, userAgent) {
  await peer.send('version', buildVersionPayload({ userAgent, relay: false }));
  const v = await peer.next('version');
  const remote = parseVersionPayload(v.payload);
  if (!hasCompactFilters(remote.services)) {
    throw new Error(`peer lacks NODE_COMPACT_FILTERS (services=0x${remote.services.toString(16)})`);
  }
  await peer.send('verack', new Uint8Array(0));
  await peer.next('verack');
  return remote;
}

// ---------------------------------------------------------------------------
// 2. 실피어에서 블록 + 필터 받기
// ---------------------------------------------------------------------------

const GENESIS_HASH_DISPLAY =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

/**
 * 피어에 붙어 최신 tip 근처의 블록 두 개(H-1, H)와 그 필터를 받아 온다.
 * 헤더는 제네시스부터 따라가면 너무 오래 걸리므로, getheaders locator 에
 * 제네시스만 넣고 2000개씩 끝까지 따라간다(높이 계산을 위해 필요).
 */
async function fetchRecentBlocks(peer, { depth = 6, log = () => {} } = {}) {
  // --- 헤더 체인 따라가기: 높이를 알아야 getcfilters/getcfheaders 를 쏠 수 있다.
  // 90만 개 헤더를 다 들고 있으면 메모리가 터진다 — 끝에서 RECENT 개만 남긴다.
  const RECENT = 4096;
  let recent = [hexToBytesLocal(GENESIS_HASH_DISPLAY).reverse()]; // internal, 끝이 tip
  let tipHeight = 0;
  const hashAt = (h) => recent[h - (tipHeight - recent.length + 1)];
  let rounds = 0;
  for (;;) {
    const locator = [];
    for (let i = recent.length - 1; i >= 0 && locator.length < 10; i -= 1) locator.push(recent[i]);
    await peer.send('getheaders', encodeGetHeaders(locator));
    const msg = await peer.next('headers');
    const hs = decodeHeadersMessage(msg.payload);
    if (hs.length === 0) break;
    for (const h of hs) {
      recent.push(h.hash);
      tipHeight += 1;
    }
    if (recent.length > RECENT) recent = recent.slice(recent.length - RECENT);
    rounds += 1;
    if (rounds % 50 === 0) log(`  headers … height ${tipHeight}`);
    if (hs.length < 2000) break;
  }
  const H = tipHeight - depth;
  log(`  tip=${tipHeight}, 대상 블록 H=${H} (H-1=${H - 1})`);

  const want = [H - 2, H - 1, H];
  const byHeight = new Map(want.map((h) => [h, { height: h, hash: hashAt(h), header: null }]));

  // --- 필터 헤더 (검증용 + 체크포인트용 previousFilterHeader)
  await peer.send('getcfheaders', encodeGetCfHeaders(H - 2, hashAt(H)));
  const cfh = decodeCfHeaders((await peer.next('cfheaders')).payload);
  if (cfh.filterType !== FILTER_TYPE_BASIC) throw new Error('unexpected filter type');
  if (!bytesEqual(cfh.stopHash, hashAt(H))) throw new Error('cfheaders stop mismatch');
  // previousFilterHeader = 높이 H-3 의 filter header → 체크포인트 후보
  const checkpointFilterHeader = cfh.previousFilterHeader;
  const filterHashes = new Map();
  for (let i = 0; i < cfh.filterHashes.length; i++) filterHashes.set(H - 2 + i, cfh.filterHashes[i]);
  // 체인을 이어 H-2·H-1 의 filter header 도 만든다 (뒤쪽 체크포인트 실험용).
  const fhAt = new Map([[H - 3, checkpointFilterHeader]]);
  for (const h of [H - 2, H - 1, H]) {
    fhAt.set(h, computeFilterHeader(filterHashes.get(h), fhAt.get(h - 1)));
  }

  // --- 필터 본문
  await peer.send('getcfilters', encodeGetCfilters(H - 2, hashAt(H)));
  const seen = new Set();
  while (seen.size < 3) {
    const cf = decodeCfilter((await peer.next('cfilter')).payload);
    const entry = [...byHeight.values()].find((e) => bytesEqual(e.hash, cf.blockHash));
    if (!entry) throw new Error('cfilter for unknown block');
    entry.filterBytes = cf.filterBytes;
    entry.filterVerified = bytesEqual(computeFilterHash(cf.filterBytes), filterHashes.get(entry.height));
    seen.add(entry.height);
  }

  // --- 블록 본문
  await peer.send(
    'getdata',
    encodeGetData(want.map((h) => ({ type: INV_BLOCK, hash: hashAt(h) }))),
  );
  let pending = want.length;
  while (pending > 0) {
    const msg = await peer.next('block', 'notfound');
    if (msg.command === 'notfound') throw new Error('peer has no block data (pruned?)');
    const blk = decodeBlock(msg.payload);
    const entry = [...byHeight.values()].find((e) => bytesEqual(e.hash, blk.header.hash));
    if (!entry) continue;
    if (entry.block) continue;
    entry.block = blk;
    pending -= 1;
  }

  return {
    tipHeight,
    H,
    checkpoint: {
      height: H - 3,
      blockHash: hashAt(H - 3),
      filterHeader: checkpointFilterHeader,
    },
    /** 받기 블록(H-1) 다음부터 시작하는 체크포인트 — "지출만 보이는" 상황 재현용. */
    checkpointAfterReceive: {
      height: H - 1,
      blockHash: hashAt(H - 1),
      filterHeader: fhAt.get(H - 1),
    },
    blocks: byHeight,
  };
}

function hexToBytesLocal(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// 3·4. 유형별 매칭 + 입력/출력 양방향 실측
// ---------------------------------------------------------------------------

/** 블록의 출력 스크립트를 유형별로 모은다 (중복 제거). */
function outputScriptsByType(block) {
  const byType = new Map();
  const all = new Set();
  for (const tx of block.transactions) {
    for (const out of tx.outputs) {
      const hex = bytesToHex(out.scriptPubKey);
      all.add(hex);
      const t = classifyScript(out.scriptPubKey);
      if (!byType.has(t)) byType.set(t, new Set());
      byType.get(t).add(hex);
    }
  }
  return { byType, all };
}

/** 유형별로 표본 몇 개씩 필터 매칭. */
function matchTable(byType, filterBytes, key, samplePerType) {
  const rows = [];
  for (const [type, set] of [...byType.entries()].sort()) {
    const list = [...set];
    const sample = list.slice(0, samplePerType);
    let ok = 0;
    for (const hex of sample) {
      if (gcsMatchAny(filterBytes, key, [hexToBytesLocal(hex)])) ok += 1;
    }
    rows.push({
      type,
      uniqueInBlock: list.length,
      tested: sample.length,
      matched: ok,
      expected: type === 'op_return' || type === 'empty' ? 0 : sample.length,
    });
  }
  return rows;
}

/**
 * 입력 쪽 검증: 블록 H 의 입력이 소비한 "이전 출력" 스크립트가 필터 H 에 들었는가.
 * 판별 가능한 표본만 쓴다 — 그 스크립트가 H 의 출력으로는 등장하지 않는 것.
 * (같은 스크립트가 H 의 출력에도 있으면 출력 때문에 들어간 건지 구분이 안 된다.)
 */
function inputSideSamples(blockH, blockPrev, outputScriptHexes) {
  const prevOutputs = new Map(); // "txid:vout" → scriptHex
  for (const tx of blockPrev.transactions) {
    const txid = internalHashToDisplay(tx.txid);
    for (let v = 0; v < tx.outputs.length; v++) {
      prevOutputs.set(`${txid}:${v}`, bytesToHex(tx.outputs[v].scriptPubKey));
    }
  }
  const samples = [];
  for (const tx of blockH.transactions) {
    if (isCoinbase(tx)) continue;
    for (const inp of tx.inputs) {
      const key = `${internalHashToDisplay(inp.prevTxid)}:${inp.prevVout}`;
      const scriptHex = prevOutputs.get(key);
      if (!scriptHex) continue; // 이전 블록에서 만들어진 출력이 아님 — 스크립트를 모른다
      if (outputScriptHexes.has(scriptHex)) continue; // H 의 출력으로도 등장 — 판별 불가
      samples.push({
        outpoint: key,
        spendingTxid: internalHashToDisplay(tx.txid),
        scriptHex,
        type: classifyScript(hexToBytesLocal(scriptHex)),
      });
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------
// 실행부
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    peer: null, depth: 6, timeoutMs: 30000, connectTimeoutMs: 6000,
    json: null, offline: false, sample: 5, maxPeers: 12,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--peer') o.peer = argv[++i];
    else if (a.startsWith('--peer=')) o.peer = a.slice(7);
    else if (a === '--depth') o.depth = Number(argv[++i]);
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]);
    else if (a === '--json') o.json = argv[++i];
    else if (a.startsWith('--json=')) o.json = a.slice(7);
    else if (a === '--offline') o.offline = true;
    else if (a === '--sample') o.sample = Number(argv[++i]);
    else if (a === '--max-peers') o.maxPeers = Number(argv[++i]);
  }
  return o;
}

async function pickPeers(opts, log) {
  if (opts.peer) {
    const idx = opts.peer.lastIndexOf(':');
    return [{ host: opts.peer.slice(0, idx), port: Number(opts.peer.slice(idx + 1)) }];
  }
  log('DNS 시드에서 피어 수집 (x49 = NETWORK|WITNESS|COMPACT_FILTERS) …');
  const { peers } = await collectPeers({ prefix: FILTER_PREFIX_CF, v6: false, timeoutMs: 6000 });
  log(`  후보 ${peers.length}개`);
  return peers.slice(0, opts.maxPeers);
}

async function main() {
  const t0 = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  const log = (s) => process.stderr.write(`${s}\n`);
  const report = { startedAt: new Date().toISOString(), byeorin: null, peer: null, results: {} };

  // --- 1. 벼린 주소 유형 -----------------------------------------------------
  log('== 1. 벼린이 파생하는 BTC 주소 유형 (SDK BtcAdapter) ==');
  const types = await byeorinAddressTypes();
  report.byeorin = types;
  for (const t of types) {
    log(`  ${t.type.padEnd(7)} ${t.path.padEnd(18)} ${t.address}`);
    log(`          script=${t.script} (${t.scriptType}) 공식벡터일치=${t.vectorMatch}`);
  }
  if (opts.offline) {
    log('\n--offline — 실피어 단계 건너뜀');
    finish(report, t0, opts, log);
    return;
  }

  // --- 2. 피어 붙기 ----------------------------------------------------------
  const candidates = await pickPeers(opts, log);
  let peer = null;
  let transport = null;
  let chosen = null;
  for (const c of candidates) {
    transport = new NodeTcpTransport();
    try {
      await transport.connect(c.host, c.port, { timeoutMs: opts.connectTimeoutMs });
      peer = new Peer(transport, MAINNET_MAGIC, opts.timeoutMs);
      const remote = await handshake(peer, '/byeorin-addrtypes:0.1/');
      chosen = { ...c, userAgent: remote.userAgent, startHeight: remote.startHeight };
      log(`== 2. 피어 ${c.host}:${c.port} — ${remote.userAgent} (height ${remote.startHeight}) ==`);
      break;
    } catch (e) {
      log(`  ${c.host}:${c.port} 실패 — ${e.message}`);
      await transport.close().catch(() => undefined);
      peer = null;
      transport = null;
    }
  }
  if (!peer) throw new Error('붙을 수 있는 BIP157 피어를 못 찾음');
  report.peer = chosen;

  let data;
  try {
    data = await fetchRecentBlocks(peer, { depth: opts.depth, log });
  } finally {
    await transport.close().catch(() => undefined);
  }

  const H = data.blocks.get(data.H);
  const prev = data.blocks.get(data.H - 1);
  const key = filterKeyFromBlockHash(H.hash);
  report.results.block = {
    height: H.height,
    hash: internalHashToDisplay(H.hash),
    txCount: H.block.transactions.length,
    filterBytes: H.filterBytes.length,
    filterHashVerified: H.filterVerified,
    prevHeight: prev.height,
    prevTxCount: prev.block.transactions.length,
  };

  // --- 3. 출력 유형별 매칭 ---------------------------------------------------
  log(`\n== 3. 블록 ${H.height} 출력 스크립트 유형별 필터 매칭 (표본 ${opts.sample}/유형) ==`);
  const { byType, all } = outputScriptsByType(H.block);
  const outRows = matchTable(byType, H.filterBytes, key, opts.sample);
  report.results.outputMatch = outRows;
  log('  유형              고유수  시험  매칭  기대');
  for (const r of outRows) {
    log(
      `  ${r.type.padEnd(16)}${String(r.uniqueInBlock).padStart(6)}${String(r.tested).padStart(6)}` +
        `${String(r.matched).padStart(6)}${String(r.expected).padStart(6)}` +
        `${r.matched === r.expected ? '' : '   <-- 불일치'}`,
    );
  }

  // 벼린 파생 주소(자금 없음) — 음성 대조군
  const negatives = types.map((t) => ({
    type: t.type,
    address: t.address,
    matched: gcsMatchAny(H.filterBytes, key, [hexToBytesLocal(t.script)]),
  }));
  report.results.negativeControl = negatives;
  log(`  음성 대조군(벼린 파생, 자금 없음): ${negatives.map((n) => `${n.type}=${n.matched}`).join(' ')}`);

  // --- 4. 입력 쪽 (지출) -----------------------------------------------------
  log(`\n== 4. 입력 쪽 — 블록 ${H.height} 이 소비한 ${prev.height} 의 출력 스크립트 ==`);
  const samples = inputSideSamples(H.block, prev.block, all);
  const inByType = new Map();
  for (const s of samples) {
    if (!inByType.has(s.type)) inByType.set(s.type, []);
    inByType.get(s.type).push(s);
  }
  const inRows = [];
  for (const [type, list] of [...inByType.entries()].sort()) {
    const sample = list.slice(0, opts.sample);
    let ok = 0;
    for (const s of sample) {
      if (gcsMatchAny(H.filterBytes, key, [hexToBytesLocal(s.scriptHex)])) ok += 1;
    }
    inRows.push({ type, candidates: list.length, tested: sample.length, matched: ok });
  }
  report.results.inputMatch = inRows;
  report.results.inputSampleCount = samples.length;
  log(`  판별 가능한 표본(=H 의 출력으로는 안 나타나는 이전 출력 스크립트): ${samples.length}개`);
  log('  유형              후보수  시험  매칭');
  for (const r of inRows) {
    log(
      `  ${r.type.padEnd(16)}${String(r.candidates).padStart(6)}${String(r.tested).padStart(6)}` +
        `${String(r.matched).padStart(6)}${r.matched === r.tested ? '' : '   <-- 불일치'}`,
    );
  }

  // 필터 항목 수 vs 출력 스크립트 고유수 — 입력 기여분의 존재 자체를 수로 확인
  const nonOpReturn = new Set([...all].filter((h) => !h.startsWith('6a') && h.length > 0));
  const { n: filterN } = decodeFilterN(H.filterBytes);
  report.results.filterItemCount = {
    filterN,
    uniqueOutputScriptsNonOpReturn: nonOpReturn.size,
    surplusFromInputs: filterN - nonOpReturn.size,
  };
  log(
    `  필터 항목 N=${filterN}, 출력 고유 스크립트(OP_RETURN 제외)=${nonOpReturn.size}` +
      ` → 입력 기여 추정 ${filterN - nonOpReturn.size}`,
  );

  // --- 5. bip157Scan 종단 ----------------------------------------------------
  log('\n== 5. bip157Scan 종단 실행 (체크포인트 → H) ==');
  const watch = [];
  const labels = [];
  for (const wanted of ['p2wpkh', 'p2tr', 'p2pkh', 'p2sh', 'p2wsh']) {
    const set = byType.get(wanted);
    if (!set || set.size === 0) continue;
    watch.push(hexToBytesLocal([...set][0]));
    labels.push({ role: 'receive-in-H', type: wanted, scriptHex: [...set][0] });
  }
  // 지출 검증용: H-1 에서 받고 H 에서 쓰인 스크립트 (양방향이 한 스캔에 들어간다).
  // 벼린이 실제로 쓰는 유형(p2wpkh·p2tr)을 우선으로 고르고, 없으면 아무거나 하나.
  const spendPicked = [];
  for (const wanted of ['p2wpkh', 'p2tr', 'p2sh', 'p2pkh', 'p2wsh']) {
    const s = samples.find((x) => x.type === wanted && !spendPicked.includes(x));
    if (s) spendPicked.push(s);
    if (spendPicked.length >= 3) break;
  }
  if (spendPicked.length === 0 && samples[0]) spendPicked.push(samples[0]);
  for (const s of spendPicked) {
    watch.push(hexToBytesLocal(s.scriptHex));
    labels.push({
      role: 'receive-in-H-1 + spent-in-H',
      type: s.type,
      scriptHex: s.scriptHex,
      outpoint: s.outpoint,
    });
  }

  const scanTransport = new NodeTcpTransport();
  const scanStart = Date.now();
  const scanResult = await bip157Scan(scanTransport, {
    host: chosen.host,
    port: chosen.port,
    watchScripts: watch,
    checkpoint: data.checkpoint,
    stopAtHeight: H.height,
    messageTimeoutMs: opts.timeoutMs,
    connectTimeoutMs: opts.connectTimeoutMs,
    userAgent: '/byeorin-addrtypes:0.1/',
  });
  const scanMs = Date.now() - scanStart;

  const perScript = labels.map((l) => {
    const received = [];
    const spent = [];
    for (const r of scanResult.records) {
      for (const o of r.receivedOutputs) {
        if (o.scriptPubKeyHex === l.scriptHex) received.push({ height: r.height, txid: r.txid, vout: o.vout, value: String(o.value) });
      }
      if (l.outpoint) {
        for (const s of r.spentOutpoints) {
          if (`${s.txid}:${s.vout}` === l.outpoint) spent.push({ height: r.height, txid: r.txid });
        }
      }
    }
    return { ...l, receivedCount: received.length, received, spentCount: spent.length, spent };
  });
  report.results.scan = {
    ms: scanMs,
    checkpointHeight: data.checkpoint.height,
    tipHeight: scanResult.tipHeight,
    scannedFilterCount: scanResult.scannedFilterCount,
    matchedBlockCount: scanResult.matchedBlockCount,
    recordCount: scanResult.records.length,
    perScript,
  };
  log(
    `  체크포인트 ${data.checkpoint.height} → ${scanResult.tipHeight}, 필터 ${scanResult.scannedFilterCount}개,` +
      ` 매칭 블록 ${scanResult.matchedBlockCount}, 기록 ${scanResult.records.length} (${scanMs}ms)`,
  );
  for (const p of perScript) {
    log(`  ${p.type.padEnd(7)} ${p.role.padEnd(28)} 받기=${p.receivedCount} 지출=${p.spentCount}`);
  }

  // --- 6. 지출만 보이는 구간 — knownOutpoints 유무 대조 ------------------------
  // 받기 블록(H-1)을 스캔 범위 밖에 두면, 필터는 (이전 출력 스크립트 덕분에)
  // 여전히 매칭되지만 블록 안에서 "내 outpoint"를 모르므로 지출을 기록하지 못한다.
  // knownOutpoints 를 주면 같은 조건에서 잡힌다 — 결함의 원인을 분리하는 대조군.
  if (spendPicked.length > 0) {
    log('\n== 6. 받기 블록을 범위 밖으로 둔 지출 스캔 (knownOutpoints 유무 대조) ==');
    const target = spendPicked[0];
    const cases = [
      { label: 'knownOutpoints 없음', knownOutpoints: undefined },
      { label: 'knownOutpoints 있음', knownOutpoints: [target.outpoint] },
    ];
    const rows = [];
    for (const c of cases) {
      const tr = new NodeTcpTransport();
      const r = await bip157Scan(tr, {
        host: chosen.host,
        port: chosen.port,
        watchScripts: [hexToBytesLocal(target.scriptHex)],
        checkpoint: data.checkpointAfterReceive,
        stopAtHeight: H.height,
        messageTimeoutMs: opts.timeoutMs,
        connectTimeoutMs: opts.connectTimeoutMs,
        userAgent: '/byeorin-addrtypes:0.1/',
        ...(c.knownOutpoints ? { knownOutpoints: c.knownOutpoints } : {}),
      });
      const spent = r.records.flatMap((rec) => rec.spentOutpoints).length;
      rows.push({
        label: c.label,
        matchedBlockCount: r.matchedBlockCount,
        recordCount: r.records.length,
        spentDetected: spent,
      });
      log(
        `  ${c.label.padEnd(20)} 필터매칭블록=${r.matchedBlockCount} 기록=${r.records.length} 지출검출=${spent}`,
      );
    }
    report.results.spendOnlyRange = { target, cases: rows, checkpointHeight: data.checkpointAfterReceive.height };
  }

  finish(report, t0, opts, log);
}

/** 필터 앞의 varint N 만 읽는다. */
function decodeFilterN(filterBytes) {
  const b0 = filterBytes[0];
  if (b0 < 0xfd) return { n: b0, size: 1 };
  if (b0 === 0xfd) return { n: filterBytes[1] | (filterBytes[2] << 8), size: 3 };
  if (b0 === 0xfe)
    return {
      n: filterBytes[1] | (filterBytes[2] << 8) | (filterBytes[3] << 16) | (filterBytes[4] << 24),
      size: 5,
    };
  let v = 0n;
  for (let i = 8; i >= 1; i--) v = (v << 8n) | BigInt(filterBytes[i]);
  return { n: Number(v), size: 9 };
}

function finish(report, t0, opts, log) {
  report.elapsedSec = Math.round((Date.now() - t0) / 100) / 10;
  log(`\n총 소요 ${report.elapsedSec}s`);
  if (opts.json) {
    writeFile(opts.json, JSON.stringify(report, null, 2)).then(
      () => log(`JSON 저장: ${opts.json}`),
      (e) => log(`JSON 저장 실패: ${e.message}`),
    );
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(`실패: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
