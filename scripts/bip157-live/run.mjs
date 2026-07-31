// run.mjs — BIP157 실피어 스캔 CLI 러너 (부대 2/16).
//
// 사용법: node run.mjs --host <ip> [--port 8333] --fixture <fixture.json> --out <result.json>
//
// fixture.json:
//   { checkpoint: { height, blockHash(display hex), filterHeader(hex) },
//     stopAtHeight, watchScripts: [hex...], expected: [{txid, height}...] }
//
// result.json: 실패해도 ok:false 로 반드시 쓴다. exit code = ok ? 0 : 1.

import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DIST = resolve(REPO_ROOT, 'packages', 'wallet-sdk', 'dist', 'btc-history.js');

function usage() {
  console.log(
    'Usage: node run.mjs --host <ip> [--port 8333] --fixture <fixture.json> --out <result.json>',
  );
}

function parseArgs(argv) {
  const out = { port: 8333 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      return null;
    }
  }
  if (!out.host || !out.fixture || !out.out || !Number.isFinite(out.port)) return null;
  return out;
}

/** BigInt → 문자열로 직렬화. */
function jsonify(obj) {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exit(1);
  }
  const outPath = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);

  const result = {
    host: args.host,
    port: args.port,
    ok: false,
    error: null,
    connectMs: null,
    totalMs: null,
    bytesIn: null,
    bytesOut: null,
    tipHeight: null,
    tipHash: null,
    scannedFilterCount: null,
    matchedBlockCount: null,
    records: [],
    expectedFound: [],
    expectedMissing: [],
  };

  let stage = 'load-fixture';
  let transport = null;
  try {
    // fixture 읽기
    const fixturePath = isAbsolute(args.fixture)
      ? args.fixture
      : resolve(process.cwd(), args.fixture);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

    // SDK 로드 (Windows 절대경로 → file URL)
    stage = 'load-sdk';
    const sdk = await import(pathToFileURL(DIST).href);
    const { bip157Scan, displayHashToInternal, hexToBytes } = sdk;

    // 전송 계층 로드 (병렬 제작 계약: createNodeTcpTransport)
    stage = 'load-transport';
    const { createNodeTcpTransport } = await import(
      pathToFileURL(resolve(__dirname, 'node-transport.mjs')).href
    );
    transport = createNodeTcpTransport();

    // connect 래핑 — connectMs 실측
    stage = 'connect';
    const rawConnect = transport.connect.bind(transport);
    transport.connect = async (host, port, opts) => {
      const t0 = performance.now();
      try {
        await rawConnect(host, port, opts);
      } finally {
        result.connectMs = Math.round(performance.now() - t0);
      }
      stage = 'scan';
    };

    const opts = {
      host: args.host,
      port: args.port,
      watchScripts: fixture.watchScripts.map((h) => hexToBytes(h)),
      checkpoint: {
        height: fixture.checkpoint.height,
        blockHash: displayHashToInternal(fixture.checkpoint.blockHash),
        filterHeader: hexToBytes(fixture.checkpoint.filterHeader),
      },
      stopAtHeight: fixture.stopAtHeight,
      messageTimeoutMs: 30000,
      connectTimeoutMs: 8000,
    };
    if (fixture.knownOutpoints) opts.knownOutpoints = fixture.knownOutpoints;

    const t0 = performance.now();
    const scan = await bip157Scan(transport, opts);
    result.totalMs = Math.round(performance.now() - t0);

    result.tipHeight = scan.tipHeight;
    result.tipHash = scan.tipHash;
    result.scannedFilterCount = scan.scannedFilterCount;
    result.matchedBlockCount = scan.matchedBlockCount;
    result.records = scan.records.map((r) => ({
      height: r.height,
      blockHash: r.blockHash,
      txid: r.txid,
      timestamp: r.timestamp,
      receivedOutputs: r.receivedOutputs.map((o) => ({
        vout: o.vout,
        value: o.value.toString(),
        scriptPubKeyHex: o.scriptPubKeyHex,
      })),
      spentOutpoints: r.spentOutpoints,
    }));
    result.ownedOutpoints = scan.ownedOutpoints;

    // 기대치 대조
    const gotTxids = new Set(scan.records.map((r) => r.txid));
    const expected = Array.isArray(fixture.expected) ? fixture.expected : [];
    result.expectedFound = expected.filter((e) => gotTxids.has(e.txid)).map((e) => e.txid);
    result.expectedMissing = expected.filter((e) => !gotTxids.has(e.txid)).map((e) => e.txid);

    result.ok = result.expectedMissing.length === 0;
    if (!result.ok) {
      result.error = `stage=verify: expected txid missing (${result.expectedMissing.length})`;
    }
  } catch (err) {
    result.ok = false;
    result.error = `stage=${stage}: ${err && err.message ? err.message : String(err)}`;
  } finally {
    // 계측 바이트 — 전송 구현이 노출하면 수거
    if (transport) {
      if (typeof transport._bytesIn === 'number') result.bytesIn = transport._bytesIn;
      if (typeof transport._bytesOut === 'number') result.bytesOut = transport._bytesOut;
      try {
        await transport.close();
      } catch {
        /* 이미 닫힘 */
      }
    }
  }

  writeFileSync(outPath, jsonify(result), 'utf8');
  console.log(`${result.ok ? 'OK' : 'FAIL'} → ${outPath}`);
  if (result.error) console.error(result.error);
  process.exit(result.ok ? 0 : 1);
}

main();
