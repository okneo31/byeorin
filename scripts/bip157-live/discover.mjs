// discover.mjs — BIP157 지원 피어 발굴 (DNS 시드 x49 → TCP 8333 reachability)
// 사용법: node discover.mjs --out <path>/peers.json [--max 40]
import { resolve4 } from "node:dns/promises";
import net from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SEEDS = [
  "x49.seed.btc.petertodd.org",
  "x49.seed.bitcoin.sipa.be",
  "x49.seed.bitcoin.sprovoost.nl",
  "x49.dnsseed.emzy.de",
  "x49.seed.bitcoin.wiz.biz",
];

const PORT = 8333;
const TCP_TIMEOUT_MS = 3000;
const CONCURRENCY = 20;

function parseArgs(argv) {
  const out = { out: null, max: 40 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--max") out.max = Number(argv[++i]);
  }
  if (!out.out) {
    console.error("usage: node discover.mjs --out <peers.json> [--max 40]");
    process.exit(1);
  }
  return out;
}

async function resolveSeeds() {
  const t0 = Date.now();
  const results = await Promise.allSettled(SEEDS.map((s) => resolve4(s)));
  const perSeed = {};
  const ips = new Set();
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      perSeed[SEEDS[i]] = r.value.length;
      for (const ip of r.value) ips.add(ip);
    } else {
      perSeed[SEEDS[i]] = `FAIL: ${r.reason?.code ?? r.reason}`;
    }
  });
  return { ips: [...ips], perSeed, dnsMs: Date.now() - t0 };
}

function tcpCheck(host) {
  return new Promise((res) => {
    const sock = net.connect({ host, port: PORT });
    const done = (ok) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(TCP_TIMEOUT_MS, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function checkAll(ips, max) {
  const t0 = Date.now();
  const reachable = [];
  let idx = 0;
  let stop = false;
  async function worker() {
    while (!stop) {
      const i = idx++;
      if (i >= ips.length) return;
      const ok = await tcpCheck(ips[i]);
      if (ok) {
        reachable.push(ips[i]);
        if (reachable.length >= max) stop = true;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { reachable: reachable.slice(0, max), tcpCheckMs: Date.now() - t0 };
}

async function main() {
  const { out, max } = parseArgs(process.argv);

  let attempt = 1;
  let dns = await resolveSeeds();
  let check = await checkAll(dns.ips, max);

  if (check.reachable.length < 10) {
    attempt = 2;
    const dns2 = await resolveSeeds();
    const merged = [...new Set([...dns.ips, ...dns2.ips])];
    const check2 = await checkAll(merged, max);
    dns = { ips: merged, perSeed: dns2.perSeed, dnsMs: dns.dnsMs + dns2.dnsMs };
    check = { reachable: check2.reachable, tcpCheckMs: check.tcpCheckMs + check2.tcpCheckMs };
  }

  const peers = check.reachable.map((host) => ({ host, port: PORT }));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(peers, null, 2) + "\n");

  const report = {
    dnsMs: dns.dnsMs,
    tcpCheckMs: check.tcpCheckMs,
    resolvedTotal: dns.ips.length,
    reachableTotal: peers.length,
    attempts: attempt,
    perSeed: dns.perSeed,
    out,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
