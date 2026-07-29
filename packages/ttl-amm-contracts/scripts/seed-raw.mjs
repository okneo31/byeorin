// seed-raw.mjs — 창세 시딩 실행기 (raw JSON-RPC 판).
//
// seed.ts(hardhat)가 아니라 raw 를 쓰는 이유: 이 RPC 는 요청이 몰리면 응답을
// 섞는다 — hardhat-ethers 와 viem 의 send/wait 헬퍼가 모두 그 지점에서 죽었다.
// 배포에서 검증된 패턴을 그대로 쓴다: 요청은 한 번에 하나, 전송 응답은 믿지
// 않고 **keccak256(서명된 raw tx) 로 해시를 로컬 계산**해 영수증을 추적한다.
//
// 정책(EXCHANGE.md §0-5, seed.ts 와 동일):
//   - 수치는 genesis-seed.json 그대로. 재계산 없음.
//   - min == desired. 누가 먼저 왜곡된 비율을 넣어뒀으면 revert 가 정답이다.
//   - 풀 완료마다 진행 기록 → 재실행 = 재개. 이미 준비금 있는 페어는 건너뛰지
//     않고 보고 후 중단(조용한 누락 방지). 단 진행 기록에 있는 풀은 완료로 간주.
//
// 사용: BYEORIN_DEPLOY_KEY=<hex> node scripts/seed-raw.mjs [--send] [--max N]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeFunctionData, decodeFunctionResult, keccak256, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pkgRoot));
const RPC = 'https://rpc.ttl1.top';
const CHAIN_ID = 7777;
const GAS_PRICE = 50_000_000_000n;
const GAS_APPROVE = 100_000n;
// 첫 addLiquidity 는 createPair(Pair 배포 ~2.8M) + mint 까지 — 여유 있게.
const GAS_ADD = 5_000_000n;

const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const ROUTER_ABI = [
  { type: 'function', name: 'addLiquidityNative', stateMutability: 'payable', inputs: [
    { name: 'token', type: 'address' }, { name: 'amountTokenDesired', type: 'uint256' },
    { name: 'amountTokenMin', type: 'uint256' }, { name: 'amountNativeMin', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' },
  ], outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] },
];
const FACTORY_ABI = [
  { type: 'function', name: 'getPair', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }, { name: 'b', type: 'address' }], outputs: [{ type: 'address' }] },
];
const PAIR_ABI = [
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

let rpcId = 100_000 + (Date.now() % 100_000);
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(to, abi, fn, args = []) {
  await sleep(150);
  const data = encodeFunctionData({ abi, functionName: fn, args });
  const res = await rpc('eth_call', [{ to, data }, 'latest']);
  return decodeFunctionResult({ abi, functionName: fn, data: res });
}

/**
 * 전송 1건 — **nonce 경주 대응판**.
 *
 * 실측(2026-07-29): 트레저리 키를 체인 자동화(시스템 컨트랙트 0x…1000 호출,
 * M2 갱신 추정)가 동시에 쓴다. 우리가 nonce N 으로 서명해 두면 자동화가 먼저
 * N 을 소비해 우리 tx 가 조용히 무효가 된다 — 이것이 "유실"의 정체였다.
 *
 * 그래서 nonce 를 미리 추적하지 않는다. 매 시도마다:
 *   ① pending nonce 를 새로 읽고 ② 서명 ③ 전송 ④ 짧게 영수증 폴링
 *   ⑤ 없으면 — 체인 nonce 가 서명 nonce 를 지나쳤는지 확인. 지나쳤는데 우리
 *      영수증이 없으면 경주에서 진 것 → 새 nonce 로 재서명해 재시도.
 */
async function sendTx(account, _ignored, tx) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const nonce = parseInt(await rpc('eth_getTransactionCount', [account.address, 'pending']), 16);
    const signed = await account.signTransaction({ type: 'legacy', chainId: CHAIN_ID, nonce, gasPrice: GAS_PRICE, ...tx });
    const hash = keccak256(signed);
    await sleep(150);
    try {
      await rpc('eth_sendRawTransaction', [signed]);
    } catch (e) {
      const m = String(e.message || e);
      // nonce too low = 이미 누가(자동화 또는 우리 이전 시도) 그 nonce 를 썼다.
      // 우리 해시의 영수증이 있으면 성공, 없으면 경주 패배 → 재서명.
      if (!/already known|known transaction|nonce too low/i.test(m)) {
        process.stdout.write(`(전송오류: ${m.slice(0, 36)}) `);
      }
    }
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const rcpt = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (rcpt) {
        if (rcpt.status !== '0x1') throw new Error(`tx 실패 (status=${rcpt.status}, hash=${hash})`);
        return { hash, block: parseInt(rcpt.blockNumber, 16) };
      }
      const latest = parseInt(await rpc('eth_getTransactionCount', [account.address, 'latest']), 16);
      if (latest > nonce) {
        // nonce 는 소비됐는데 영수증이 없다. 두 경우다:
        //   a) 자동화에 밀림 (우리 tx 죽음)  b) **우리 tx 가 채굴됐는데 geth 의
        //      tx 인덱스가 비동기라 영수증이 몇 초 늦게 나옴** — 실측으로 확인된
        //      함정. b 에서 성급히 재서명하면 중복 실행이 되고, allowance 소진으로
        //      revert 하며 가스만 태운다 (KES 에서 실제 발생).
        // 그래서 결론 내리기 전에 영수증을 더 기다린다.
        let found = null;
        for (let k = 0; k < 10 && !found; k++) {
          await sleep(2000);
          found = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
        }
        if (found) {
          if (found.status !== '0x1') throw new Error(`tx 실패 (status=${found.status}, hash=${hash})`);
          return { hash, block: parseInt(found.blockNumber, 16) };
        }
        process.stdout.write(`(nonce 경주 패배 → 재서명) `);
        break;
      }
    }
  }
  throw new Error('10회 재서명 후에도 미채굴 — 자동화 트래픽 확인 필요');
}

async function main() {
  const send = process.argv.includes('--send') || process.env.BYEORIN_SEND === '1';
  const maxIdx = process.argv.indexOf('--max');
  const maxPools = maxIdx !== -1 ? Number(process.argv[maxIdx + 1]) : Infinity;

  const keyRaw = (process.env.BYEORIN_DEPLOY_KEY ?? process.env.BYEORIN_ANCHOR_KEY ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(keyRaw)) { console.error('[seed] 키 없음'); process.exitCode = 1; return; }
  const account = privateKeyToAccount(keyRaw);

  const dep = JSON.parse(readFileSync(join(pkgRoot, 'deployments', 'ttl.json'), 'utf8'));
  const seedPlan = JSON.parse(readFileSync(join(repoRoot, 'genesis-seed.json'), 'utf8'));
  const ROUTER = dep.contracts.router.address;
  const FACTORY = dep.contracts.factory.address;
  const WTTL = dep.contracts.wttl.address;

  const progressFile = join(pkgRoot, 'deployments', 'seed-progress.json');
  const progress = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, 'utf8')) : { router: ROUTER, chainId: CHAIN_ID, done: {} };
  if (progress.router.toLowerCase() !== ROUTER.toLowerCase()) throw new Error('진행 기록이 다른 배포의 것이다');
  const saveProgress = () => writeFileSync(progressFile, JSON.stringify(progress, null, 2) + '\n', 'utf8');

  const chainId = parseInt(await rpc('eth_chainId', []), 16);
  if (chainId !== CHAIN_ID) throw new Error(`chainId 불일치: ${chainId}`);

  const remaining = seedPlan.pools.filter((p) => !progress.done[p.iso]);
  console.log(`[seed] ${send ? '실전' : '드라이런'} · 완료 ${Object.keys(progress.done).length} / 전체 ${seedPlan.pools.length} · 남은 ${remaining.length}`);
  if (remaining.length === 0) { console.log('[seed] 전부 완료'); return; }

  // ── 사전 검사 (남은 풀 전부) ──
  const problems = [];
  const ttlBal = BigInt(await rpc('eth_getBalance', [account.address, 'latest']));
  const ttlNeed = remaining.reduce((a, p) => a + BigInt(p.ttlWei), 0n) + GAS_PRICE * (GAS_APPROVE + GAS_ADD) * BigInt(remaining.length);
  if (ttlBal < ttlNeed) problems.push(`TTL 부족: 보유 ${ttlBal} < 필요 ${ttlNeed}`);
  for (const p of remaining) {
    // viem 은 출력이 1개면 배열이 아니라 값 자체를 돌려준다.
    const bal = await call(p.token, ERC20_ABI, 'balanceOf', [account.address]);
    if (bal < BigInt(p.tokenWei)) problems.push(`${p.iso} 토큰 부족: ${bal} < ${p.tokenWei}`);
    const pair = await call(FACTORY, FACTORY_ABI, 'getPair', [WTTL, p.token]);
    if (pair !== '0x0000000000000000000000000000000000000000') {
      const [r0, r1] = await call(pair, PAIR_ABI, 'getReserves', []);
      if (r0 > 0n || r1 > 0n) problems.push(`${p.iso} 페어에 이미 준비금이 있다 (${pair}) — 수동 확인 필요`);
    }
  }
  if (problems.length) { console.log('[seed] 사전 검사 실패 — tx 0건:'); for (const x of problems) console.log('  ✘', x); process.exitCode = 1; return; }
  console.log(`[seed] 사전 검사 통과 (${remaining.length} 풀) · TTL 보유 ${(Number(ttlBal) / 1e18).toLocaleString()}`);
  if (!send) { console.log('[seed] 드라이런 종료 — BYEORIN_SEND=1 로 실전'); return; }

  // ── 실행: 풀당 approve → addLiquidityNative ──
  let count = 0;
  for (const p of remaining) {
    if (count >= maxPools) { console.log(`[seed] --max ${maxPools} 도달 — 재실행으로 계속`); break; }
    const t0 = Date.now();
    process.stdout.write(`[seed] ${p.iso.padEnd(4)} approve… `);
    const a = await sendTx(account, 0, {
      to: p.token, gas: GAS_APPROVE,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, BigInt(p.tokenWei)] }),
    });
    process.stdout.write(`✔ addLiquidity… `);
    const blockTs = parseInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp, 16);
    const add = await sendTx(account, 0, {
      to: ROUTER, gas: GAS_ADD, value: BigInt(p.ttlWei),
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'addLiquidityNative', args: [p.token, BigInt(p.tokenWei), BigInt(p.tokenWei), BigInt(p.ttlWei), account.address, BigInt(blockTs + 1800)] }),
    });
    progress.done[p.iso] = { approveTx: a.hash, addTx: add.hash, block: add.block };
    saveProgress();
    count++;
    console.log(`✔ block ${add.block} (${((Date.now() - t0) / 1000).toFixed(0)}s) [${Object.keys(progress.done).length}/${seedPlan.pools.length}]`);
  }
  console.log(`[seed] 이번 실행 ${count} 풀 완료 · 총 ${Object.keys(progress.done).length}/${seedPlan.pools.length}`);
}

main().catch((e) => { console.error('[seed] 실패:', e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
