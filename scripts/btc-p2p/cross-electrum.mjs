// cross-electrum.mjs — 두 이력 트랙의 교차 대조 (Electrum vs BIP157).
//
// 왜 필요한가: 지갑은 주소 이력을 두 경로로 얻을 수 있다.
//   (B) Electrum 서버에 scripthash 이력을 물어본다 — 서버가 답을 안다.
//   (C) BIP157 compact filter 로 블록을 직접 걸러 낸다 — 우리가 답을 만든다.
// 두 경로가 "같은 구간에서 같은 txid 집합"을 내놓지 않으면 둘 중 하나는 틀렸다.
// 이 스크립트는 같은 주소·같은 높이 창을 두 트랙으로 각각 훑고, 집합 차이와
// 소요 시간을 실측해 낸다. 판정은 하지 않는다 — 숫자만 낸다.
//
// 전송은 ./node-transport.mjs 하나로 고정한다(부대 간 측정값이 구현 차이로
// 흔들리지 않게). 프로토콜은 전부 SDK(packages/wallet-sdk/dist/btc-history.js).
//
// 사용:
//   node scripts/btc-p2p/cross-electrum.mjs
//   node scripts/btc-p2p/cross-electrum.mjs --addr <주소> --window 1000
//   node scripts/btc-p2p/cross-electrum.mjs --end 900000 --window 1000
//   node scripts/btc-p2p/cross-electrum.mjs --electrum-only
//   node scripts/btc-p2p/cross-electrum.mjs --json out.json
//
// ── 대조가 성립하는 조건 (실측으로 확인한 것) ─────────────────────────────
// BIP157 트랙의 지출 감지는 "checkpoint 시점에 이미 보유한 outpoint" 목록
// (knownOutpoints)을 시드로 요구한다. 시드가 비어 있으면, 창 이전에 받은 돈을
// 창 안에서 쓰기만 하고 우리 주소로 아무것도 돌려주지 않는 tx 는 기록되지 않는다.
// 필터는 그 블록을 맞히고 블록도 받아 오지만(prevout 의 scriptPubKey 가 필터에
// 들어 있으므로), 어느 입력이 우리 것인지 알 방법이 없어 행이 안 만들어진다.
//
//   실측 (2026-08-01, 이 스크립트):
//     --addr bc1pwrj78e… --end 959965 --window 1
//       → Electrum 3건 / BIP157 2건 / 누락 1건
//         (dd8ee334… — 959909·959917 에서 받은 돈을 959965 에서 지출만 함)
//       → matchedBlockCount=1 : 필터는 맞혔다. 손실 지점은 필터가 아니라 기록 단계다.
//
// 그래서 기본 주소는 창 안 활동이 전부 수신인 주소를 쓴다. 실측에서 창 안
// 8건이 모두 receivedOutputs≥1 · spentOutpoints=0 이었다.
// 지출이 섞인 주소를 대조하려면 knownOutpoints 시드를 주거나, 창의 시작을 그
// 주소의 첫 수신 이전으로 잡아야 한다.

import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { NodeTcpTransport } from './node-transport.mjs';
import { collectPeers, FILTER_PREFIX_CF } from './seeds.mjs';

import {
  ElectrumClient,
  addressToScripthash,
  addressToScriptPubKey,
  bip157Scan,
  P2PFrameDecoder,
  MAINNET_MAGIC,
  DEFAULT_USER_AGENT,
  buildVersionPayload,
  parseVersionPayload,
  hasCompactFilters,
  encodeMessage,
  encodeGetCfHeaders,
  decodeCfHeaders,
  computeFilterHeader,
  buildPongPayload,
  parsePingPayload,
  hexToBytes,
  dsha256,
  internalHashToDisplay,
} from '../../packages/wallet-sdk/dist/btc-history.js';

// 창 밀도도 기본값 선택의 기준이다: 매치된 블록은 통째로 받아 온다.
// 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa (제네시스) 는 1000블록 창에 357건이라
// 블록 수백 개를 내려받는다. 아래 주소는 같은 창에 8건이었다.
const DEFAULT_ADDR = '1BitcoinEaterAddressDontSendf59kuE';
const ELECTRUM_HOST = 'electrum.blockstream.info';
const ELECTRUM_TLS_PORT = 50002;
const ELECTRUM_TCP_PORT = 50001;

const now = () => Number(process.hrtime.bigint()) / 1e6; // ms
const ms = (t0) => Math.round((now() - t0) * 1000) / 1000;
const log = (...a) => console.error(...a);

/**
 * 전송 계량기 — NodeTcpTransport 를 그대로 위임하며 오간 바이트만 센다.
 * 시간만으로는 두 트랙의 비용을 비교할 수 없다(피어 회선 편차가 시간을 지배한다).
 * 바이트는 회선이 달라도 변하지 않는 양이라 정책 근거로 쓸 수 있다.
 * 전송 구현 자체는 건드리지 않는다 — 공유 파일은 하나로 고정한다.
 */
class CountingTransport {
  constructor() {
    this.inner = new NodeTcpTransport();
    this.rx = 0;
    this.tx = 0;
  }
  async connect(host, port, opts) {
    return this.inner.connect(host, port, opts);
  }
  async send(bytes) {
    this.tx += bytes.length;
    return this.inner.send(bytes);
  }
  onData(cb) {
    this.inner.onData((b) => {
      this.rx += b.length;
      cb(b);
    });
  }
  onClose(cb) {
    this.inner.onClose(cb);
  }
  async close() {
    return this.inner.close();
  }
}

// ---------------------------------------------------------------- Electrum 트랙

/**
 * Electrum 한 서버에 붙어 이력·헤더를 받아 온다.
 * 단계별 소요를 따로 잰다 — "핸드셰이크 비용"과 "질의 비용"은 정책상 다른 항목이다.
 */
async function electrumTrack({ address, windowSize, endOverride, timeoutMs }) {
  const attempts = [
    { port: ELECTRUM_TLS_PORT, tls: true },
    { port: ELECTRUM_TCP_PORT, tls: false },
  ];

  let lastErr = null;
  for (const a of attempts) {
    const transport = new CountingTransport();
    const client = new ElectrumClient(transport, { timeoutMs });
    const t0 = now();
    try {
      await client.connect(ELECTRUM_HOST, a.port, { tls: a.tls, timeoutMs: 8000 });
      const connectMs = ms(t0);

      const tv = now();
      const version = await client.version('byeorin-cross', '1.4');
      const versionMs = ms(tv);
      const handshakeMs = connectMs + versionMs;
      log(`[electrum] ${ELECTRUM_HOST}:${a.port} tls=${a.tls} 핸드셰이크 ${handshakeMs}ms (connect ${connectMs} + version ${versionMs}) ${JSON.stringify(version)}`);

      const th = now();
      const tipHeader = await client.headersSubscribe();
      const tipMs = ms(th);

      const scripthash = addressToScripthash(address);
      const rx0 = transport.rx;
      const tx0 = transport.tx;
      const tg = now();
      const items = await client.getHistory(scripthash, { timeoutMs });
      const historyMs = ms(tg);
      const historyRx = transport.rx - rx0;
      const historyTx = transport.tx - tx0;
      log(`[electrum] get_history ${historyMs}ms — ${items.length} 항목 (tip ${tipHeader.height})`);

      const confirmed = items.filter((i) => i.height > 0);
      const mempool = items.filter((i) => i.height <= 0);

      // 창 결정: 지정이 없으면 "이 주소의 마지막 컨펌 tx"를 창의 끝으로 삼는다.
      // 그래야 창 안에 최소 1건이 보장되고, 창이 팁의 재구성(reorg) 영역을 피한다.
      const maxAddrHeight = confirmed.length ? Math.max(...confirmed.map((i) => i.height)) : tipHeader.height - 10;
      const end = endOverride ?? Math.min(maxAddrHeight, tipHeader.height - 6);
      const start = end - windowSize + 1;
      const cpHeight = start - 1;

      // 창 밖/안 분리. 같은 txid 가 두 번 오는 경우(입출력 동시 관여)는 집합에서 접힌다.
      const inWindow = confirmed.filter((i) => i.height >= start && i.height <= end);
      // 프로토콜 1.4 원형 필드명은 tx_hash 다 (txid 아님).
      const txidSet = new Set(inWindow.map((i) => i.tx_hash));
      const heightByTxid = new Map(inWindow.map((i) => [i.tx_hash, i.height]));

      // checkpoint 블록 해시 — 헤더 원문을 받아 우리가 직접 dsha256 한다(서버 말 그대로 믿지 않는다).
      const tc = now();
      const cpHeaderHex = await client.request('blockchain.block.header', [cpHeight], { timeoutMs });
      const cpHeaderMs = ms(tc);
      if (typeof cpHeaderHex !== 'string' || cpHeaderHex.length !== 160) {
        throw new Error(`electrum: block.header(${cpHeight}) 응답 형태 이상 (len=${String(cpHeaderHex).length})`);
      }
      const cpHash = dsha256(hexToBytes(cpHeaderHex));

      await client.close();

      return {
        ok: true,
        server: { host: ELECTRUM_HOST, port: a.port, tls: a.tls, version },
        timing: {
          connectMs,
          versionMs,
          handshakeMs,
          headersSubscribeMs: tipMs,
          getHistoryMs: historyMs,
          blockHeaderMs: cpHeaderMs,
          totalMs: ms(t0),
        },
        bytes: {
          getHistoryRx: historyRx,
          getHistoryTx: historyTx,
          sessionRx: transport.rx,
          sessionTx: transport.tx,
        },
        tipHeight: tipHeader.height,
        historyTotal: items.length,
        historyConfirmed: confirmed.length,
        historyMempool: mempool.length,
        window: { start, end, size: windowSize, checkpointHeight: cpHeight },
        checkpoint: { height: cpHeight, hashDisplay: internalHashToDisplay(cpHash), hash: cpHash },
        inWindowEntries: inWindow.length,
        txids: txidSet,
        heightByTxid,
      };
    } catch (e) {
      lastErr = e;
      log(`[electrum] ${ELECTRUM_HOST}:${a.port} tls=${a.tls} 실패 — ${e.message}`);
      try {
        await client.close();
      } catch {
        /* 이미 끊긴 소켓 */
      }
    }
  }
  return { ok: false, error: lastErr?.message ?? 'unknown', stage: 'electrum' };
}

// ---------------------------------------------------------------- P2P 최소 피어 (preflight 전용)

/**
 * bip157Scan 은 checkpoint 의 filter header 를 요구한다. Electrum 은 그 값을 주지 않는다
 * (BIP157 헤더 체인은 Electrum 프로토콜에 없다). 그래서 P2P 피어 한 대에게
 * getcfheaders 로 받아 온다. 스캔 피어와 "다른" 피어에서 받아야 스캔 중의
 * "filter header chain does not connect" 검사가 실제 교차 검증이 된다.
 */
function makePeerPump(transport, timeoutMs) {
  const decoder = new P2PFrameDecoder(MAINNET_MAGIC);
  const queue = [];
  let waiter = null;
  let closedErr = null;

  const deliver = () => {
    if (!waiter) return;
    if (closedErr) {
      const w = waiter;
      waiter = null;
      clearTimeout(w.timer);
      w.reject(closedErr);
      return;
    }
    for (let i = 0; i < queue.length; i += 1) {
      if (waiter.commands.has(queue[i].command)) {
        const [msg] = queue.splice(i, 1);
        const w = waiter;
        waiter = null;
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
    }
  };

  transport.onData((chunk) => {
    let msgs;
    try {
      msgs = decoder.push(chunk);
    } catch (e) {
      closedErr = e;
      deliver();
      return;
    }
    for (const m of msgs) {
      if (m.command === 'ping') {
        // 응답하지 않으면 피어가 끊는다.
        transport
          .send(encodeMessage('pong', buildPongPayload(parsePingPayload(m.payload)), MAINNET_MAGIC))
          .catch(() => {});
        continue;
      }
      queue.push(m);
    }
    deliver();
  });
  transport.onClose((e) => {
    closedErr = e ?? new Error('peer: socket closed');
    deliver();
  });

  return {
    send: (command, payload) => transport.send(encodeMessage(command, payload, MAINNET_MAGIC)),
    next(...commands) {
      if (closedErr) return Promise.reject(closedErr);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new Error(`peer: timeout waiting for [${commands.join(', ')}]`));
        }, timeoutMs);
        waiter = { commands: new Set(commands), resolve, reject, timer };
        deliver();
      });
    },
  };
}

/** 피어 한 대에서 checkpoint 의 filter header 를 얻는다. 실패는 예외. */
async function fetchCheckpointFilterHeader(peerAddr, cpHeight, cpHash, { timeoutMs, connectTimeoutMs }) {
  const transport = new CountingTransport();
  const t0 = now();
  await transport.connect(peerAddr.host, peerAddr.port, { timeoutMs: connectTimeoutMs });
  const connectMs = ms(t0);
  const peer = makePeerPump(transport, timeoutMs);
  try {
    await peer.send('version', buildVersionPayload({ userAgent: DEFAULT_USER_AGENT, relay: false }));
    const versionMsg = await peer.next('version');
    const remote = parseVersionPayload(versionMsg.payload);
    if (!hasCompactFilters(remote.services)) {
      throw new Error(`peer lacks NODE_COMPACT_FILTERS (services=0x${remote.services.toString(16)})`);
    }
    await peer.send('verack', new Uint8Array(0));
    await peer.next('verack');
    const handshakeMs = ms(t0);

    // startHeight=cpHeight, stopHash=hash(cpHeight) → previousFilterHeader = header(cpHeight-1),
    // filterHashes = [filterHash(cpHeight)]. 둘을 접으면 header(cpHeight).
    const tf = now();
    await peer.send('getcfheaders', encodeGetCfHeaders(cpHeight, cpHash));
    const msg = await peer.next('cfheaders');
    const cf = decodeCfHeaders(msg.payload);
    const cfMs = ms(tf);
    if (cf.filterHashes.length !== 1) {
      throw new Error(`cfheaders 개수 ${cf.filterHashes.length} != 1`);
    }
    const filterHeader = computeFilterHeader(cf.filterHashes[0], cf.previousFilterHeader);
    return {
      filterHeader,
      peer: `${peerAddr.host}:${peerAddr.port}`,
      userAgent: remote.userAgent,
      startHeight: remote.startHeight,
      connectMs,
      handshakeMs,
      cfheadersMs: cfMs,
      rx: transport.rx,
      tx: transport.tx,
    };
  } finally {
    await transport.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- BIP157 트랙

async function bip157Track({ address, checkpoint, stopAtHeight, peers, maxPeerTries, timeoutMs, connectTimeoutMs }) {
  const watchScripts = [addressToScriptPubKey(address)];
  const failures = [];

  // 1) preflight: checkpoint filter header 확보 (피어 여러 대 시도).
  let pre = null;
  for (const p of peers.slice(0, maxPeerTries)) {
    try {
      log(`[bip157] preflight → ${p.host}:${p.port}`);
      pre = await fetchCheckpointFilterHeader(p, checkpoint.height, checkpoint.hash, {
        timeoutMs,
        connectTimeoutMs,
      });
      log(
        `[bip157] preflight OK ${pre.peer} (${pre.userAgent}) 핸드셰이크 ${pre.handshakeMs}ms · cfheaders ${pre.cfheadersMs}ms · filterHeader=${internalHashToDisplay(pre.filterHeader)}`,
      );
      break;
    } catch (e) {
      failures.push({ stage: 'preflight', peer: `${p.host}:${p.port}`, error: e.message });
      log(`[bip157] preflight 실패 ${p.host}:${p.port} — ${e.message}`);
    }
  }
  if (!pre) {
    return { ok: false, stage: 'preflight', error: 'checkpoint filter header 확보 실패', failures };
  }

  // 2) 스캔: preflight 와 "다른" 피어를 우선한다 (같은 피어면 자기 말끼리 맞춘 것뿐이다).
  const scanCandidates = peers.filter((p) => `${p.host}:${p.port}` !== pre.peer).slice(0, maxPeerTries);
  let scanErr = null;
  for (const p of scanCandidates) {
    const transport = new CountingTransport();
    const t0 = now();
    try {
      log(`[bip157] scan → ${p.host}:${p.port} (창 ${checkpoint.height + 1}..${stopAtHeight})`);
      const result = await bip157Scan(transport, {
        host: p.host,
        port: p.port,
        watchScripts,
        checkpoint: { height: checkpoint.height, blockHash: checkpoint.hash, filterHeader: pre.filterHeader },
        knownOutpoints: [],
        stopAtHeight,
        messageTimeoutMs: timeoutMs,
        connectTimeoutMs,
      });
      const scanMs = ms(t0);
      log(
        `[bip157] scan OK ${p.host}:${p.port} ${scanMs}ms — 필터 ${result.scannedFilterCount}개 · 매치블록 ${result.matchedBlockCount} · 기록 ${result.records.length} · 수신 ${(transport.rx / 1048576).toFixed(2)}MiB`,
      );
      return {
        ok: true,
        preflight: pre,
        peer: `${p.host}:${p.port}`,
        crossPeer: true,
        timing: { scanMs, preflightHandshakeMs: pre.handshakeMs, preflightCfheadersMs: pre.cfheadersMs },
        bytes: { scanRx: transport.rx, scanTx: transport.tx, preflightRx: pre.rx, preflightTx: pre.tx },
        result,
        failures,
      };
    } catch (e) {
      scanErr = e;
      failures.push({ stage: 'scan', peer: `${p.host}:${p.port}`, ms: ms(t0), error: e.message });
      log(`[bip157] scan 실패 ${p.host}:${p.port} (${ms(t0)}ms) — ${e.message}`);
      await transport.close().catch(() => {});
    }
  }
  return { ok: false, stage: 'scan', error: scanErr?.message ?? 'no peer', preflight: pre, failures };
}

// ---------------------------------------------------------------- 대조

function compare(electrum, scan) {
  const e = electrum.txids;
  const b = new Set(scan.records.map((r) => r.txid));

  const both = [...e].filter((t) => b.has(t));
  const missing = [...e].filter((t) => !b.has(t)); // Electrum 은 알고 BIP157 은 못 찾음
  const extra = [...b].filter((t) => !e.has(t)); // BIP157 만 찾음

  // 같은 txid 라도 높이가 다르면 그것도 불일치다.
  const heightMismatch = [];
  for (const r of scan.records) {
    const h = electrum.heightByTxid.get(r.txid);
    if (h !== undefined && h !== r.height) heightMismatch.push({ txid: r.txid, electrum: h, bip157: r.height });
  }

  return {
    electrumCount: e.size,
    bip157Count: b.size,
    matched: both.length,
    missingCount: missing.length,
    extraCount: extra.length,
    identical: missing.length === 0 && extra.length === 0,
    missing: missing.map((t) => ({ txid: t, height: electrum.heightByTxid.get(t) })),
    extra: extra.map((t) => {
      const r = scan.records.find((x) => x.txid === t);
      return {
        txid: t,
        height: r?.height,
        received: r?.receivedOutputs.length ?? 0,
        spent: r?.spentOutpoints.length ?? 0,
      };
    }),
    heightMismatch,
  };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = {
    addr: DEFAULT_ADDR,
    windowSize: 1000,
    end: null,
    timeoutMs: 20000,
    connectTimeoutMs: 6000,
    electrumTimeoutMs: 30000,
    maxPeerTries: 8,
    electrumOnly: false,
    json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--addr') o.addr = argv[++i];
    else if (a === '--window') o.windowSize = Number(argv[++i]);
    else if (a === '--end') o.end = Number(argv[++i]);
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]);
    else if (a === '--peers') o.maxPeerTries = Number(argv[++i]);
    else if (a === '--electrum-only') o.electrumOnly = true;
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(
      'node scripts/btc-p2p/cross-electrum.mjs [--addr A] [--window N] [--end H] [--peers N] [--electrum-only] [--json out.json]',
    );
    return 0;
  }

  const t0 = now();
  log(`[대조] 주소 ${o.addr} · 창 ${o.windowSize}블록`);

  const electrum = await electrumTrack({
    address: o.addr,
    windowSize: o.windowSize,
    endOverride: o.end,
    timeoutMs: o.electrumTimeoutMs,
  });
  if (!electrum.ok) {
    const out = { ok: false, stage: 'electrum', error: electrum.error, totalMs: ms(t0) };
    console.log(JSON.stringify(out, null, 2));
    return 1;
  }
  log(
    `[대조] 창 ${electrum.window.start}..${electrum.window.end} · checkpoint ${electrum.window.checkpointHeight} (${electrum.checkpoint.hashDisplay}) · 창 안 Electrum tx ${electrum.txids.size}건`,
  );

  const report = {
    address: o.addr,
    scripthash: addressToScripthash(o.addr),
    window: electrum.window,
    checkpointHash: electrum.checkpoint.hashDisplay,
    electrum: {
      server: electrum.server,
      timing: electrum.timing,
      bytes: electrum.bytes,
      tipHeight: electrum.tipHeight,
      historyTotal: electrum.historyTotal,
      historyConfirmed: electrum.historyConfirmed,
      historyMempool: electrum.historyMempool,
      inWindowEntries: electrum.inWindowEntries,
      inWindowTxids: [...electrum.txids],
    },
  };

  if (o.electrumOnly) {
    report.bip157 = { skipped: true, reason: '--electrum-only' };
    report.totalMs = ms(t0);
    await emit(report, o.json);
    return 0;
  }

  const tp = now();
  const { peers, uniqueCount } = await collectPeers({ prefix: FILTER_PREFIX_CF, v6: false });
  const seedMs = ms(tp);
  log(`[seeds] ${uniqueCount}개 피어 (x49) ${seedMs}ms`);
  // 시드가 준 순서는 서버 정렬 그대로다 — 섞어서 특정 피어 편향을 줄인다.
  const shuffled = peers.slice().sort(() => Math.random() - 0.5);

  const bip = await bip157Track({
    address: o.addr,
    checkpoint: { height: electrum.window.checkpointHeight, hash: electrum.checkpoint.hash },
    stopAtHeight: electrum.window.end,
    peers: shuffled,
    maxPeerTries: o.maxPeerTries,
    timeoutMs: o.timeoutMs,
    connectTimeoutMs: o.connectTimeoutMs,
  });

  report.seeds = { peerCount: uniqueCount, ms: seedMs };

  if (!bip.ok) {
    report.bip157 = { ok: false, stage: bip.stage, error: bip.error, failures: bip.failures };
    report.comparison = { possible: false, reason: `BIP157 ${bip.stage} 실패 — 대조 불가` };
    report.totalMs = ms(t0);
    await emit(report, o.json);
    return 2;
  }

  const cmp = compare(electrum, bip.result);
  report.bip157 = {
    ok: true,
    preflightPeer: bip.preflight.peer,
    scanPeer: bip.peer,
    crossPeer: bip.crossPeer,
    timing: bip.timing,
    bytes: bip.bytes,
    tipHeight: bip.result.tipHeight,
    scannedFilterCount: bip.result.scannedFilterCount,
    matchedBlockCount: bip.result.matchedBlockCount,
    recordCount: bip.result.records.length,
    records: bip.result.records.map((r) => ({
      height: r.height,
      txid: r.txid,
      received: r.receivedOutputs.length,
      spent: r.spentOutpoints.length,
      valueSats: r.receivedOutputs.reduce((s, x) => s + x.value, 0n).toString(),
    })),
    failures: bip.failures,
  };
  report.comparison = { possible: true, ...cmp };
  report.cost = {
    electrumGetHistoryMs: electrum.timing.getHistoryMs,
    electrumHandshakeMs: electrum.timing.handshakeMs,
    electrumTotalMs: electrum.timing.totalMs,
    bip157ScanMs: bip.timing.scanMs,
    bip157PreflightMs: bip.timing.preflightHandshakeMs + bip.timing.preflightCfheadersMs,
    ratioScanOverHistory:
      Math.round((bip.timing.scanMs / electrum.timing.getHistoryMs) * 100) / 100,
    electrumGetHistoryRxBytes: electrum.bytes.getHistoryRx,
    electrumSessionRxBytes: electrum.bytes.sessionRx,
    bip157ScanRxBytes: bip.bytes.scanRx,
    bip157PreflightRxBytes: bip.bytes.preflightRx,
    ratioRxScanOverHistory:
      Math.round((bip.bytes.scanRx / electrum.bytes.getHistoryRx) * 100) / 100,
  };
  report.totalMs = ms(t0);

  log(
    `[대조] 일치 ${cmp.matched} · 누락 ${cmp.missingCount} · 초과 ${cmp.extraCount} · 동일=${cmp.identical}`,
  );
  await emit(report, o.json);
  return cmp.identical ? 0 : 3;
}

async function emit(report, jsonPath) {
  const text = JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  console.log(text);
  if (jsonPath) {
    await writeFile(jsonPath, text + '\n', 'utf8');
    log(`[대조] 보고서 → ${jsonPath}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      log('[대조] 치명적 오류:', e?.stack ?? e);
      process.exit(1);
    });
}

export { electrumTrack, bip157Track, fetchCheckpointFilterHeader, compare };
