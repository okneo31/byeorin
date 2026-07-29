// finish-deploy.mjs — 중단된 배포의 마무리 (1회용 복구 도구).
//
// 상황(2026-07-29): deploy.ts 가 WTTL 을 배포한 직후, hardhat-ethers 의 tx 폴링이
// TTL geth 포크의 응답("hex string has length 6, want 64")에 걸려 죽었다. 체인
// 확인 결과 WTTL 은 살아 있고(코드 존재), Factory tx 는 전송되지 않았다
// (nonce 변화 없음, pending 없음). 남은 Factory·Router 두 개를 hardhat 을 거치지
// 않고 viem 으로 직접 배포한다 — 영수증 대기는 eth_getTransactionReceipt 폴링이라
// 문제의 경로를 타지 않는다.
//
// 산출물은 deploy.ts 의 DeploymentRecord 와 같은 형식으로 deployments/ttl.json 에
// 기록한다 — seed.ts 와 제3자 재현 검증이 그 형식을 읽는다.
//
// 사용: BYEORIN_DEPLOY_KEY=<hex> node scripts/finish-deploy.mjs [--send]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWalletClient, createPublicClient, http, defineChain, encodeDeployData, getAddress, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const RPC = 'https://rpc.ttl1.top';
const CHAIN_ID = 7777;
// deploy.ts 실행에서 이미 확정된 값들 — 체인에서 재확인한다.
const WTTL_ADDR = '0xC555ee718E5330Ac41a0587e464f6e4Aad5B8Def';
const WTTL_TX = '0x9cd0b6fe73af08e2e170c29952af20ddc8084386332ce7d540eabe0c448e1ead';
const WTTL_BLOCK = 1140755;

const ttl = defineChain({
  id: CHAIN_ID,
  name: 'TTL',
  nativeCurrency: { name: 'TTL', symbol: 'TTL', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

function artifact(name) {
  const p = join(pkgRoot, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode };
}

async function main() {
  const send = process.argv.includes('--send') || process.env.BYEORIN_SEND === '1';
  const keyRaw = (process.env.BYEORIN_DEPLOY_KEY ?? process.env.BYEORIN_ANCHOR_KEY ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(keyRaw)) {
    console.error('[finish] BYEORIN_DEPLOY_KEY 가 없거나 형식이 아니다');
    process.exitCode = 1;
    return;
  }
  const account = privateKeyToAccount(keyRaw);
  const pub = createPublicClient({ chain: ttl, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: ttl, transport: http(RPC) });

  // 사전 확인 — 이 도구는 정확히 "WTTL 만 배포된" 상태에서만 동작해야 한다.
  const chainId = await pub.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`chainId 불일치: ${chainId}`);
  const wttlCode = await pub.getCode({ address: WTTL_ADDR });
  if (!wttlCode || wttlCode === '0x') throw new Error('WTTL 코드가 없다 — 전제가 깨졌다');

  const file = join(pkgRoot, 'deployments', 'ttl.json');
  if (existsSync(file)) throw new Error(`${file} 이 이미 있다 — 이 복구 도구를 다시 쓸 상황이 아니다`);

  const fac = artifact('TtlAmmFactory');
  const rou = artifact('TtlAmmRouter');

  const nonce = await pub.getTransactionCount({ address: account.address });
  console.log(`[finish] 배포자 ${account.address} · nonce ${nonce} · ${send ? '실전' : '드라이런'}`);

  if (!send) {
    console.log('[finish] 드라이런 — 전송 없음. Factory → Router 순으로 배포 예정.');
    return;
  }

  // raw JSON-RPC — viem 의 send/wait 헬퍼가 이 geth 포크와 어긋나서
  // (hardhat-ethers 도 같은 지점에서 죽었다) 서명만 viem 계정으로 하고
  // 전송·영수증은 스펙 그대로의 eth_sendRawTransaction / eth_getTransactionReceipt.
  // 앵커 발행(anchor-release.mjs)이 성공한 것과 같은 경로다.
  // 실측: 이 RPC(프록시)는 keep-alive 연결에서 같은 id 요청들의 응답을 섞는다 —
  // eth_sendRawTransaction 이 직전 estimateGas 값(0x303d92)을 돌려줬다. 방어 3중:
  //   ① 요청마다 고유 id  ② connection: close (연결 재사용 차단)
  //   ③ 응답 형식 검증 — 그리고 애초에 send 응답을 믿지 않는다 (아래 deploy 참고)
  let rpcId = Date.now() % 1_000_000;
  const rawRpc = async (method, params) => {
    const r = await fetch(RPC, { method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  let nextNonce = nonce;

  async function deploy(name, art, args) {
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args });
    const gasHex = await rawRpc('eth_estimateGas', [{ from: account.address, data }]);
    const gasPriceHex = await rawRpc('eth_gasPrice', []);
    const signed = await account.signTransaction({
      type: 'legacy',
      chainId: CHAIN_ID,
      nonce: nextNonce,
      gasPrice: BigInt(gasPriceHex),
      gas: (BigInt(gasHex) * 12n) / 10n, // 20% 여유
      data,
    });
    // **해시를 로컬에서 계산한다** = keccak256(서명된 raw tx). 전송 응답이
    // 무엇이 오든(섞이든 깨지든) 우리가 찾을 해시는 이미 확정돼 있다.
    const hash = keccak256(signed);
    const sendResult = await rawRpc('eth_sendRawTransaction', [signed]).catch((e) => `(전송 응답 오류: ${e.message})`);
    if (String(sendResult).toLowerCase() !== hash.toLowerCase()) {
      console.log(`[finish] ${name} 전송 응답이 섞임(${String(sendResult).slice(0, 18)}…) — 로컬 해시로 추적한다`);
    }
    nextNonce += 1;
    console.log(`[finish] ${name} tx ${hash} — 영수증 대기…`);
    let rcpt = null;
    for (let i = 0; i < 120 && !rcpt; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      rcpt = await rawRpc('eth_getTransactionReceipt', [hash]);
    }
    if (!rcpt) throw new Error(`${name} 영수증 시간 초과`);
    if (rcpt.status !== '0x1') throw new Error(`${name} 배포 실패 (status=${rcpt.status})`);
    rcpt = { contractAddress: rcpt.contractAddress, blockNumber: parseInt(rcpt.blockNumber, 16) };
    const addr = getAddress(rcpt.contractAddress);
    // 배포 tx 성공 ≠ 코드 존재 확인 — 직접 읽는다.
    const code = await pub.getCode({ address: addr });
    if (!code || code === '0x') throw new Error(`${name} 코드가 없다`);
    console.log(`[finish] ${name} = ${addr} (block ${rcpt.blockNumber}, code ${(code.length - 2) / 2} bytes)`);
    return { address: addr, txHash: hash, blockNumber: rcpt.blockNumber };
  }

  const factory = await deploy('TtlAmmFactory', fac, [account.address, WTTL_ADDR]);
  const router = await deploy('TtlAmmRouter', rou, [factory.address, WTTL_ADDR]);

  // 생성자 배선 검증 — 주소만 맞고 인자가 틀리면 전 풀이 죽는다.
  const readFn = (addr, abi, fn) => pub.readContract({ address: addr, abi, functionName: fn });
  const facWttl = await readFn(factory.address, fac.abi, 'WTTL');
  const facSetter = await readFn(factory.address, fac.abi, 'feeToSetter');
  const rouFac = await readFn(router.address, rou.abi, 'factory');
  const rouWttl = await readFn(router.address, rou.abi, 'WTTL');
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (!eq(facWttl, WTTL_ADDR) || !eq(facSetter, account.address) || !eq(rouFac, factory.address) || !eq(rouWttl, WTTL_ADDR)) {
    throw new Error('생성자 배선 검증 실패 — 기록을 남기지 않는다');
  }
  console.log('[finish] 생성자 배선 검증 통과');

  const record = {
    version: 1,
    network: 'ttl',
    chainId: CHAIN_ID,
    deployer: account.address,
    feeToSetter: account.address,
    contracts: {
      wttl: { address: WTTL_ADDR, txHash: WTTL_TX, blockNumber: WTTL_BLOCK },
      factory,
      router,
    },
    compiler: {
      solcVersion: '0.8.28',
      optimizer: { enabled: true, runs: 999999 },
      evmVersion: 'paris',
    },
    deployedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  console.log(`[finish] 기록 완료: ${file}`);
}

main().catch((e) => {
  console.error('[finish] 실패:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
