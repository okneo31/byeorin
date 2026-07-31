// testnet-scan.mjs — BIP158 공식 벡터 삼각 검증 (우리 디코더 × 실피어 × 공식 벡터).
//
// 왜 testnet 인가: BIP158 이 규격 부록에 실어 놓은 공식 테스트 벡터는 전부
// testnet3 블록이다. mainnet 실피어 시험에서는 "받은 필터가 맞는지"를
// 필터헤더 체인으로 간접 확인할 수밖에 없지만, testnet 에서는 벡터에 적힌
// 필터 바이트와 실피어가 준 바이트를 hex 단위로 직접 대조할 수 있다.
//
//   벡터(BIP158 규격) ─┐
//   실피어(Bitcoin Core) ─┼─ 셋이 같은 바이트를 가리키면 삼각 검증 성립
//   우리 디코더(SDK)   ─┘
//
// 검증 항목 (높이마다):
//   1. cfilter.block_hash        == 벡터 blockHash          (피어가 같은 블록을 봤다)
//   2. cfilter.filter_bytes(hex) == 벡터 filter             ← 핵심 대조
//   3. cfheaders.prev_filter_header == 벡터 prevHeader      (피어의 필터헤더 체인)
//   4. dsha256(filter ‖ prevHeader) == 벡터 header          (우리 계산)
//   5. 우리 GCS 디코더가 받은 필터를 파싱 (N 값 · 빈 필터 처리)
//
// 전송은 공유 모듈(node-transport.mjs), 프로토콜·GCS 는 SDK 빌드본
// (packages/wallet-sdk/dist/btc-history.js). SDK 는 수정하지 않는다 —
// 네트워크 매직은 SDK 가 TESTNET_MAGIC 을 export 하고 모든 진입점이
// magic 을 인자로 받으므로 우회가 필요 없다.
//
// 사용:
//   node scripts/btc-p2p/testnet-scan.mjs
//   node scripts/btc-p2p/testnet-scan.mjs --targets 120 --concurrency 24 \
//        --vector-peers 3 --out /tmp/testnet-vectors.json
//
// 출력: 표준출력에 높이별 일치/불일치 표 + 실측 수치. --out 지정 시 JSON 저장.

import dns from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeTcpTransport } from './node-transport.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.resolve(HERE, '../../packages/wallet-sdk/dist/btc-history.js');

const {
  TESTNET_MAGIC,
  P2PFrameDecoder,
  SERVICE_NODE_NETWORK,
  SERVICE_NODE_WITNESS,
  buildVerackMessage,
  buildVersionPayload,
  buildPongPayload,
  parsePingPayload,
  encodeMessage,
  hasCompactFilters,
  parseVersionPayload,
  encodeGetCfilters,
  decodeCfilter,
  encodeGetCfHeaders,
  decodeCfHeaders,
  decodeGcsFilterValues,
  computeFilterHash,
  computeFilterHeader,
  displayHashToInternal,
  internalHashToDisplay,
  bytesToHex,
} = await import(path.sep === '\\' ? `file://${SDK.replace(/\\/g, '/')}` : SDK);

// ---------------------------------------------------------------------------
// BIP158 공식 테스트 벡터 (testnet3) — 대조에 필요한 필드만.
//
// 출처: packages/wallet-sdk/tests/btc-bip157.test.ts 의 BIP158_VECTORS
//       (그 자체는 BIP158 규격 부록의 testnet-19.json 에서 온 것).
//       블록 원문 hex 는 여기서 필요 없다 — 우리는 "만들지" 않고 "받아서 대조"한다.
// 표기: blockHash · prevHeader · header 는 display hex(탐색기 표기),
//       filter 는 와이어 바이트 그대로의 hex.
// ---------------------------------------------------------------------------

const BIP158_VECTORS = [
  { height: 0, blockHash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943', prevHeader: '0000000000000000000000000000000000000000000000000000000000000000', filter: '019dfca8', header: '21584579b7eb08997773e5aeff3a7f932700042d0ed2a6129012b7d7ae81b750' },
  { height: 2, blockHash: '000000006c02c8ea6e4ff69651f7fcde348fb9d557a06e6957b65552002a7820', prevHeader: 'd7bdac13a59d745b1add0d2ce852f1a0442e8945fc1bf3848d3cbffd88c24fe1', filter: '0174a170', header: '186afd11ef2b5e7e3504f2e8cbf8df28a1fd251fe53d60dff8b1467d1b386cf0' },
  { height: 3, blockHash: '000000008b896e272758da5297bcd98fdc6d97c9b765ecec401e286dc1fdbe10', prevHeader: '186afd11ef2b5e7e3504f2e8cbf8df28a1fd251fe53d60dff8b1467d1b386cf0', filter: '016cf7a0', header: '8d63aadf5ab7257cb6d2316a57b16f517bff1c6388f124ec4c04af1212729d2a' },
  { height: 15007, blockHash: '0000000038c44c703bae0f98cdd6bf30922326340a5996cc692aaae8bacf47ad', prevHeader: '18b5c2b0146d2d09d24fb00ff5b52bd0742f36c9e65527abdb9de30c027a4748', filter: '013c3710', header: '07384b01311867949e0c046607c66b7a766d338474bb67f66c8ae9dbd454b20e' },
  { height: 49291, blockHash: '0000000018b07dca1b28b4b5a119f6d6e71698ce1ed96f143f54179ce177a19c', prevHeader: 'ed47705334f4643892ca46396eb3f4196a5e30880589e4009ef38eae895d4a13', filter: '0afbc2920af1b027f31f87b592276eb4c32094bb4d3697021b4c6380', header: 'b6d98692cec5145f67585f3434ec3c2b3030182e1cb3ec58b855c5c164dfaaa3' },
  { height: 987876, blockHash: '0000000000000c00901f2049055e2a437c819d79a3d54fd63e6af796cd7b8a79', prevHeader: 'fe4d230dbb0f4fec9bed23a5283e08baf996e3f32b93f52c7de1f641ddfd04ad', filter: '010c0b40', header: '0965a544743bbfa36f254446e75630c09404b3d164a261892372977538928ed5' },
  { height: 1263442, blockHash: '000000006f27ddfe1dd680044a34548f41bed47eba9e6f0b310da21423bc5f33', prevHeader: '31d66d516a9eda7de865df29f6ef6cb8e4bf9309e5dac899968a9a62a5df61e3', filter: '0385acb4f0fe889ef0', header: '4e6d564c2a2452065c205dd7eb2791124e0c4e0dbb064c410c24968572589dec' },
  { height: 1414221, blockHash: '0000000000000027b2b3b3381f114f674f481544ff2be37ae3788d7e078383b1', prevHeader: '5e5e12d90693c8e936f01847859404c67482439681928353ca1296982042864e', filter: '00', header: '021e8882ef5a0ed932edeebbecfeda1d7ce528ec7b3daa27641acf1189d7b5dc' },
];

// Bitcoin Core chainparams.cpp 의 testnet3 DNS 시드.
const DEFAULT_SEEDS = [
  'testnet-seed.bitcoin.jonasschnelli.ch',
  'seed.tbtc.petertodd.net',
  'seed.testnet.bitcoin.sprovoost.nl',
  'testnet-seed.bluematt.me',
  'testnet-seed.achownodes.xyz',
];

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    targets: 120,
    concurrency: 24,
    timeout: 8000,
    msgTimeout: 20000,
    port: 18333,
    vectorPeers: 3,
    out: null,
    seeds: null,
    dnsRounds: 1,
    peer: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--targets') out.targets = Number(next());
    else if (a === '--concurrency') out.concurrency = Number(next());
    else if (a === '--timeout') out.timeout = Number(next());
    else if (a === '--msg-timeout') out.msgTimeout = Number(next());
    else if (a === '--port') out.port = Number(next());
    else if (a === '--vector-peers') out.vectorPeers = Number(next());
    else if (a === '--dns-rounds') out.dnsRounds = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--peer') out.peer = next();
    else if (a === '--seeds') out.seeds = next().split(',').map((s) => s.trim());
    else if (a === '--help' || a === '-h') {
      console.log(
        'testnet-scan.mjs [--targets N] [--concurrency N] [--timeout ms] [--msg-timeout ms]\n' +
          '                 [--port N] [--vector-peers N] [--dns-rounds N] [--peer host[:port]]\n' +
          '                 [--seeds a,b] [--out file.json]',
      );
      process.exit(0);
    } else throw new Error(`알 수 없는 인자: ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DNS 시드
// ---------------------------------------------------------------------------

async function collectFromSeeds(seeds, rounds = 1) {
  const set = new Set();
  const tally = new Map();
  for (let round = 0; round < rounds; round++) {
    const results = await Promise.allSettled(seeds.map((s) => dns.resolve4(s)));
    for (let i = 0; i < results.length; i++) {
      const seed = seeds[i];
      const cur = tally.get(seed) ?? { seed, ok: false, count: 0 };
      const r = results[i];
      if (r.status === 'fulfilled') {
        for (const a of r.value) set.add(a);
        cur.ok = true;
        cur.count += r.value.length;
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
// 피어 래퍼 — 프레임 큐 + 명령 대기. ping 자동 pong.
// (SDK 의 scan.ts Peer 와 같은 구조지만, 벡터 시험은 scan 이 아니라
//  getcfilters/getcfheaders 단발 호출이라 여기에 최소 구현을 둔다.)
// ---------------------------------------------------------------------------

const IGNORED = new Set([
  'sendheaders', 'sendcmpct', 'wtxidrelay', 'sendaddrv2', 'addr', 'addrv2',
  'inv', 'tx', 'feefilter', 'getheaders', 'getaddr', 'alert', 'pong',
  'headers', 'notfound', 'reject',
]);

class Peer {
  #dec;
  #queue = [];
  #waiter = null;
  #closed = null;

  constructor(transport, magic, timeoutMs) {
    this.transport = transport;
    this.magic = magic;
    this.timeoutMs = timeoutMs;
    this.#dec = new P2PFrameDecoder(magic);
    transport.onData((chunk) => this.#onChunk(chunk));
    transport.onClose((e) => this.#onClose(e ?? new Error('peer closed connection')));
  }

  #onChunk(chunk) {
    let msgs;
    try {
      msgs = this.#dec.push(chunk);
    } catch (e) {
      this.#onClose(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    for (const m of msgs) {
      if (m.command === 'ping') {
        this.send('pong', buildPongPayload(parsePingPayload(m.payload))).catch(() => {});
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
    const msg = this.#queue.splice(i, 1)[0];
    clearTimeout(this.#waiter.timer);
    const { resolve } = this.#waiter;
    this.#waiter = null;
    resolve(msg);
  }

  send(command, payload) {
    return this.transport.send(encodeMessage(command, payload, this.magic));
  }

  next(commands, timeoutMs = this.timeoutMs) {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#waiter) return Promise.reject(new Error('peer: concurrent next()'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new Error(`timeout waiting for [${commands.join(', ')}]`));
      }, timeoutMs);
      this.#waiter = { commands: new Set(commands), resolve, reject, timer };
      this.#deliver();
    });
  }
}

// ---------------------------------------------------------------------------
// 1) 프로브: connect → version 교환 → services 비트만 보고 끊는다.
// ---------------------------------------------------------------------------

function classify(e) {
  const m = String(e?.message ?? e);
  if (/connect timeout/.test(m)) return 'ETIMEDOUT_CONNECT';
  if (/timeout waiting/.test(m)) return 'ETIMEDOUT_MSG';
  if (/handshake timeout/.test(m)) return 'ETIMEDOUT_HANDSHAKE';
  if (/closed before version/.test(m)) return 'EARLY_CLOSE';
  if (/closed connection/.test(m)) return 'PEER_CLOSED';
  if (/bad magic/.test(m)) return 'BAD_MAGIC';
  if (/bad checksum/.test(m)) return 'BAD_CHECKSUM';
  if (/socket closed with error/.test(m)) return 'SOCKET_ERROR';
  return m.slice(0, 60);
}

async function probePeer(host, port, timeoutMs) {
  const t0 = Date.now();
  const rec = { host, port, connected: false, handshake: false, connectMs: null, handshakeMs: null };
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
      const dec = new P2PFrameDecoder(TESTNET_MAGIC);
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, new Error('handshake timeout')), timeoutMs);
      tr.onClose((e) => finish(reject, e ?? new Error('peer closed before version')));
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
        encodeMessage('version', buildVersionPayload({ services: 0n, relay: false }), TESTNET_MAGIC),
      ).catch((e) => finish(reject, e));
    });

    try {
      await tr.send(buildVerackMessage(TESTNET_MAGIC));
    } catch {
      /* 측정에 영향 없음 */
    }

    rec.handshake = true;
    rec.handshakeMs = Date.now() - t0;
    rec.services = `0x${version.services.toString(16)}`;
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

// ---------------------------------------------------------------------------
// 2) 벡터 대조: 한 피어에 붙어 벡터 높이의 cfheaders·cfilter 를 받는다.
// ---------------------------------------------------------------------------

async function runVectors(host, port, args) {
  const res = {
    host,
    port,
    connected: false,
    handshake: false,
    userAgent: null,
    startHeight: null,
    vectors: [],
    error: null,
  };
  const tr = new NodeTcpTransport();
  const t0 = Date.now();
  try {
    await tr.connect(host, port, { timeoutMs: args.timeout });
  } catch (e) {
    res.error = `connect: ${e?.code ?? classify(e)}`;
    return res;
  }
  res.connected = true;
  res.connectMs = Date.now() - t0;

  const peer = new Peer(tr, TESTNET_MAGIC, args.msgTimeout);
  try {
    // 규격대로 version → (상대 version) → verack → (상대 verack).
    await peer.send('version', buildVersionPayload({ services: 0n, relay: false }));
    const vmsg = await peer.next(['version'], args.timeout);
    const version = parseVersionPayload(vmsg.payload);
    res.userAgent = version.userAgent;
    res.startHeight = version.startHeight;
    res.services = `0x${version.services.toString(16)}`;
    res.compactFilters = hasCompactFilters(version.services);
    await peer.send('verack', new Uint8Array(0));
    await peer.next(['verack'], args.timeout);
    res.handshake = true;
    res.handshakeMs = Date.now() - t0;

    for (const vec of BIP158_VECTORS) {
      const stop = displayHashToInternal(vec.blockHash);
      const v = { height: vec.height, ok: false };

      // (a) getcfheaders — 피어가 말하는 이전 필터헤더가 벡터의 prevHeader 인가.
      try {
        const a0 = Date.now();
        await peer.send('getcfheaders', encodeGetCfHeaders(vec.height, stop));
        const m = await peer.next(['cfheaders']);
        v.cfheadersMs = Date.now() - a0;
        const dec = decodeCfHeaders(m.payload);
        v.prevHeaderGot = internalHashToDisplay(dec.previousFilterHeader);
        v.prevHeaderMatch = v.prevHeaderGot === vec.prevHeader;
        v.cfheadersCount = dec.filterHashes.length;
        // 마지막 filter_hash 는 이 높이 필터의 dsha256 — 아래 (b) 와 교차 확인용.
        v.filterHashFromPeer =
          dec.filterHashes.length > 0
            ? internalHashToDisplay(dec.filterHashes[dec.filterHashes.length - 1])
            : null;
      } catch (e) {
        v.cfheadersError = classify(e);
      }

      // (b) getcfilters — 핵심. 받은 필터 바이트를 벡터와 hex 로 직접 대조.
      try {
        const b0 = Date.now();
        await peer.send('getcfilters', encodeGetCfilters(vec.height, stop));
        const m = await peer.next(['cfilter']);
        v.cfilterMs = Date.now() - b0;
        const dec = decodeCfilter(m.payload);
        v.blockHashGot = internalHashToDisplay(dec.blockHash);
        v.blockHashMatch = v.blockHashGot === vec.blockHash;
        v.filterGot = bytesToHex(dec.filterBytes);
        v.filterMatch = v.filterGot === vec.filter;
        v.filterBytes = dec.filterBytes.length;

        // 우리 GCS 디코더가 실피어 바이트를 파싱하는가 (빈 필터 포함).
        try {
          v.n = decodeGcsFilterValues(dec.filterBytes).n;
          v.decodeOk = true;
        } catch (e) {
          v.decodeOk = false;
          v.decodeError = classify(e);
        }

        // 우리 계산: dsha256(filter) 와 필터헤더 체인.
        const fh = computeFilterHash(dec.filterBytes);
        v.filterHashComputed = internalHashToDisplay(fh);
        v.filterHashMatch =
          v.filterHashFromPeer == null ? null : v.filterHashComputed === v.filterHashFromPeer;
        v.headerComputed = internalHashToDisplay(
          computeFilterHeader(fh, displayHashToInternal(vec.prevHeader)),
        );
        v.headerMatch = v.headerComputed === vec.header;
      } catch (e) {
        v.cfilterError = classify(e);
      }

      v.ok = Boolean(v.blockHashMatch && v.filterMatch && v.headerMatch && v.decodeOk);
      res.vectors.push(v);
      if (v.cfilterError === 'PEER_CLOSED' || v.cfilterError === 'SOCKET_ERROR') break;
      // 0x40 을 광고해 놓고 getcfilters 에 아예 응답하지 않는 피어가 실제로 있다
      // (구버전 btcd 등). 8개 전부에 타임아웃을 물리면 측정 시간만 쓰므로,
      // 연속 2회 무응답이면 "광고만 하고 서빙 안 함"으로 판정하고 끊는다.
      if (res.vectors.length >= 2 && res.vectors.every((x) => x.cfilterError === 'ETIMEDOUT_MSG')) {
        res.notServing = true;
        break;
      }
    }
    return res;
  } catch (e) {
    res.error = classify(e);
    return res;
  } finally {
    try {
      await tr.close();
    } catch {
      /* 이미 끊긴 소켓 */
    }
  }
}

// ---------------------------------------------------------------------------
// 병렬 풀 · 통계
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return out;
}

function stats(nums) {
  const s = nums.filter((n) => typeof n === 'number').sort((a, b) => a - b);
  if (s.length === 0) return null;
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

function mark(b) {
  return b === true ? '일치' : b === false ? '불일치' : '—';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const seeds = args.seeds ?? DEFAULT_SEEDS;

  console.log('== BTC testnet3 실피어 × BIP158 공식 벡터 삼각 검증 ==');
  console.log(
    `매직 ${bytesToHex(TESTNET_MAGIC)} · 포트 ${args.port} · 대상 ${args.targets} · 동시 ${args.concurrency}`,
  );
  console.log(`벡터 ${BIP158_VECTORS.length}개: ${BIP158_VECTORS.map((v) => v.height).join(', ')}`);

  // --- 대상 확보 ---
  let addrs;
  let perSeed = [];
  if (args.peer) {
    const [h, p] = args.peer.split(':');
    addrs = [h];
    if (p) args.port = Number(p);
    console.log(`\n[1] DNS 생략 — 지정 피어 ${h}:${args.port}`);
  } else {
    const got = await collectFromSeeds(seeds, args.dnsRounds);
    addrs = got.addrs;
    perSeed = got.perSeed;
    console.log(`\n[1] testnet3 DNS 시드 (${args.dnsRounds}회 조회 합집합)`);
    for (const s of perSeed) {
      console.log(`  ${s.ok ? 'OK ' : 'FAIL'} ${s.seed} ${s.ok ? `${s.count}개(중복 포함)` : s.error}`);
    }
    console.log(`  고유 주소 ${addrs.length}개`);
    if (addrs.length === 0) {
      console.error('testnet3 DNS 시드에서 주소를 하나도 얻지 못했다 — 측정 불가.');
      process.exitCode = 2;
      return;
    }
  }

  // --- 프로브 ---
  const targets = shuffle(addrs).slice(0, args.targets);
  console.log(`\n[2] 프로브 ${targets.length}개 (포트 ${args.port})…`);
  const probes = await runPool(targets, args.concurrency, (h) => probePeer(h, args.port, args.timeout));

  const connected = probes.filter((r) => r.connected);
  const handshook = probes.filter((r) => r.handshake);
  const cf = handshook.filter((r) => r.compactFilters);

  console.log('\n[3] 접속 실측');
  console.log(`  시도            ${probes.length}`);
  console.log(`  TCP 접속 성공   ${connected.length}  (${pct(connected.length, probes.length)})`);
  console.log(
    `  핸드셰이크 성공 ${handshook.length}  (시도 대비 ${pct(handshook.length, probes.length)} · 접속 대비 ${pct(handshook.length, connected.length)})`,
  );
  console.log(
    `  0x40 광고       ${cf.length}  (핸드셰이크 대비 ${pct(cf.length, handshook.length)} · 시도 대비 ${pct(cf.length, probes.length)})`,
  );
  const cs = stats(connected.map((r) => r.connectMs));
  const hs = stats(handshook.map((r) => r.handshakeMs));
  if (cs) console.log(`  TCP 접속 ms     min ${cs.min} · 중앙 ${cs.p50} · p90 ${cs.p90} · max ${cs.max} · 평균 ${cs.mean}`);
  if (hs) console.log(`  핸드셰이크 ms   min ${hs.min} · 중앙 ${hs.p50} · p90 ${hs.p90} · max ${hs.max} · 평균 ${hs.mean}`);

  const fails = probes.filter((r) => !r.handshake);
  if (fails.length > 0) {
    console.log(`\n  실패 사유 (${fails.length}건)`);
    for (const [e, n] of topCounts(fails.map((r) => `${r.stage}:${r.error}`), 10)) {
      console.log(`    ${String(n).padStart(4)}  ${e}`);
    }
  }
  if (connected.length === 0) {
    console.log(`\n[!] TCP 접속 0건 — 아웃바운드 ${args.port} 차단 가능성. 위 오류 분포가 근거.`);
  }

  const pool = cf.length > 0 ? cf : args.peer ? probes.filter((r) => r.handshake) : [];
  if (pool.length === 0) {
    console.log('\n[4] 0x40 광고 피어가 없다 — 벡터 대조 불가.');
    console.log(`\n소요 ${((Date.now() - started) / 1000).toFixed(1)}초`);
    process.exitCode = 3;
    return;
  }

  console.log('\n[4] 0x40 광고 피어');
  for (const r of cf.slice(0, 12)) {
    console.log(`  ${r.host}:${r.port}  ${r.services}  h=${r.startHeight}  ${r.userAgent}`);
  }

  // --- 벡터 대조 ---
  const chosen = pool.slice(0, args.vectorPeers);
  console.log(`\n[5] 벡터 대조 — 피어 ${chosen.length}개에 순차 요청`);
  const runs = [];
  for (const p of chosen) {
    const r = await runVectors(p.host, p.port, args);
    runs.push(r);

    console.log(`\n  --- ${r.host}:${r.port} ${r.userAgent ?? ''} (tip=${r.startHeight ?? '?'}) ---`);
    if (!r.handshake) {
      console.log(`  실패: ${r.error ?? '핸드셰이크 미완료'}`);
      continue;
    }
    console.log(
      '  높이       blockhash  필터바이트  prev헤더   헤더계산   N    cfilter ms  받은 필터 hex',
    );
    for (const v of r.vectors) {
      if (v.cfilterError && v.filterGot === undefined) {
        console.log(
          `  ${String(v.height).padStart(8)}  ${(v.cfheadersError ? `cfheaders:${v.cfheadersError}  ` : '')}cfilter:${v.cfilterError}`,
        );
        continue;
      }
      console.log(
        `  ${String(v.height).padStart(8)}  ${mark(v.blockHashMatch).padEnd(9)}  ${mark(v.filterMatch).padEnd(10)}  ${mark(v.prevHeaderMatch).padEnd(9)}  ${mark(v.headerMatch).padEnd(9)}  ${String(v.n ?? '-').padStart(3)}  ${String(v.cfilterMs ?? '-').padStart(10)}  ${v.filterGot}`,
      );
      if (v.filterMatch === false) {
        console.log(`             벡터 기대: ${BIP158_VECTORS.find((x) => x.height === v.height).filter}`);
      }
    }
    const done = r.vectors.filter((v) => v.filterGot !== undefined);
    const allOk = done.filter((v) => v.ok);
    console.log(
      `  → 수신 ${done.length}/${BIP158_VECTORS.length} · 전항목 일치 ${allOk.length}/${done.length}` +
        (r.notServing ? ' · 0x40 광고했으나 getcfilters 무응답 → 조기 중단' : ''),
    );
  }

  // --- 종합 ---
  console.log('\n[6] 삼각 검증 종합 (높이별, 응답한 피어 기준)');
  console.log('  높이       응답피어  필터일치  prev헤더일치  헤더일치  디코드OK  cfilter ms(중앙)');
  const perHeight = [];
  for (const vec of BIP158_VECTORS) {
    const got = runs.flatMap((r) => r.vectors.filter((v) => v.height === vec.height && v.filterGot !== undefined));
    const st = stats(got.map((v) => v.cfilterMs));
    const row = {
      height: vec.height,
      responded: got.length,
      filterMatch: got.filter((v) => v.filterMatch).length,
      prevHeaderMatch: got.filter((v) => v.prevHeaderMatch).length,
      headerMatch: got.filter((v) => v.headerMatch).length,
      decodeOk: got.filter((v) => v.decodeOk).length,
      cfilterMs: st,
    };
    perHeight.push(row);
    console.log(
      `  ${String(row.height).padStart(8)}  ${String(row.responded).padStart(8)}  ${String(row.filterMatch).padStart(8)}  ${String(row.prevHeaderMatch).padStart(12)}  ${String(row.headerMatch).padStart(8)}  ${String(row.decodeOk).padStart(8)}  ${String(row.cfilterMs?.p50 ?? '-').padStart(16)}`,
    );
  }

  const anyResponded = perHeight.filter((r) => r.responded > 0);
  const allMatched = anyResponded.filter((r) => r.filterMatch === r.responded && r.headerMatch === r.responded);
  console.log(
    `\n  응답 받은 높이 ${anyResponded.length}/${BIP158_VECTORS.length} · 그중 전원 일치 ${allMatched.length}`,
  );
  if (anyResponded.length === BIP158_VECTORS.length && allMatched.length === anyResponded.length) {
    console.log('  → 삼각 검증 성립: 공식 벡터 = 실피어 바이트 = 우리 디코더 해석.');
  } else if (anyResponded.length === 0) {
    console.log('  → 필터를 하나도 받지 못했다. 대조 불가.');
  } else {
    console.log('  → 부분 성립. 위 표의 불일치·미응답 항목이 근거.');
  }

  const allMs = runs.flatMap((r) => r.vectors.map((v) => v.cfilterMs));
  const ms = stats(allMs);
  if (ms) {
    console.log(
      `\n[7] cfilter 수신 ms (n=${ms.n})  min ${ms.min} · 중앙 ${ms.p50} · p90 ${ms.p90} · max ${ms.max} · 평균 ${ms.mean}`,
    );
  }
  const hMs = stats(runs.flatMap((r) => r.vectors.map((v) => v.cfheadersMs)));
  if (hMs) {
    console.log(
      `    cfheaders 수신 ms (n=${hMs.n})  min ${hMs.min} · 중앙 ${hMs.p50} · p90 ${hMs.p90} · max ${hMs.max} · 평균 ${hMs.mean}`,
    );
  }

  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n소요 ${elapsedSec}초`);

  if (args.out) {
    await writeFile(
      args.out,
      `${JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          network: 'testnet3',
          magic: bytesToHex(TESTNET_MAGIC),
          params: args,
          seeds: perSeed,
          probe: {
            attempted: probes.length,
            connected: connected.length,
            handshake: handshook.length,
            compactFilters: cf.length,
            connectMs: cs,
            handshakeMs: hs,
            failures: topCounts(fails.map((r) => `${r.stage}:${r.error}`), 30).map(([error, count]) => ({ error, count })),
          },
          vectorRuns: runs,
          perHeight,
          cfilterMs: ms,
          cfheadersMs: hMs,
          elapsedSec: Number(elapsedSec),
        },
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
        2,
      )}\n`,
      'utf8',
    );
    console.log(`결과 → ${args.out}`);
  }
}

await main();
