#!/usr/bin/env node
/*
 * anchor-release.mjs — 릴리스 매니페스트 해시를 TTL 체인에 못 박는다.
 *
 * 왜 필요한가.
 *   매니페스트는 지금 저장소에만 있다. 저장소를 통제하는 쪽(= 우리)이 과거
 *   릴리스 기록을 조용히 바꿀 수 있다는 뜻이다. 실제로 이 저장소는 조금 전
 *   force push 로 이력이 재작성됐다 — 할 수 있다는 게 증명된 셈이다.
 *   체인에 한 번 들어간 기록은 우리도 못 바꾼다. 앵커링이 파는 건 그것 하나다.
 *
 * 설계 — 옥상옥이 되지 않도록 최소한만.
 *   · **컨트랙트를 쓰지 않는다.** 레지스트리 컨트랙트는 감사·업그레이드 대상이
 *     하나 느는 것뿐 보장은 늘지 않는다. 평범한 0-value 트랜잭션의 data 필드에
 *     텍스트 한 줄을 넣는다. 아무 블록 익스플로러로도 읽힌다.
 *   · **검증이 O(1) 이다.** 매니페스트에 앵커 txHash 를 적어 두므로, 검증기는
 *     `eth_getTransactionByHash` 한 번으로 끝난다. 블록 스캔도 인덱서도 없다.
 *     위조하려면 공개된 publisher 주소의 키로 실제 트랜잭션을 만들어야 한다.
 *   · **append-only.** 수정/폐기 기능을 만들지 않는다. 만드는 순간 가변성이
 *     돌아온다. 잘못 올린 앵커는 지우는 게 아니라 새 앵커로 덮어 설명한다.
 *
 * 이 앵커가 증명하는 것 / 못 하는 것 (섞어 말하지 않는다):
 *   증명함  — "publisher 키를 쥔 쪽이 블록 N 시점에 해시 H 를 공표했다"
 *   증명 못함 — "H 가 소스 S 에서 나왔다". 재현 빌드가 없으면 이건 여전히
 *              우리 주장이다. docs/VERIFIABILITY.md §2.1 참고.
 *
 * 사용:
 *   node scripts/anchor-release.mjs                # 드라이런 (기본) — 보낼 내용만 출력
 *   BYEORIN_ANCHOR_KEY=0x... node scripts/anchor-release.mjs --send
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 앵커 레코드 버전. 형식이 바뀌면 올린다. */
export const ANCHOR_MAGIC = 'byeorin:release:1';

/** TTL 메인넷. */
export const TTL_CHAIN = {
  chainId: 7777,
  rpcUrl: 'https://rpc.ttl1.top',
  explorer: 'https://scan.ttl1.top',
};

/**
 * 앵커 페이로드. 바이너리 대신 **사람이 읽는 텍스트**로 둔다 —
 * 블록 익스플로러에서 hex 를 디코드하면 그대로 읽히는 편이,
 * 전용 도구 없이 확인할 수 있어 원칙에 맞다.
 */
export function buildPayload(manifest) {
  return [
    ANCHOR_MAGIC,
    `sha256=${manifest.sha256}`,
    `v=${manifest.versionName}+${manifest.versionCode}`,
    `commit=${manifest.source?.commit ?? 'unknown'}`,
  ].join('|');
}

export function toHexData(text) {
  return '0x' + Buffer.from(text, 'utf8').toString('hex');
}

async function rpc(method, params) {
  const res = await fetch(TTL_CHAIN.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

/** 공개된 publisher 주소 목록. 파일이 없거나 깨졌으면 빈 배열. */
function loadPublishers() {
  try {
    const p = join(repoRoot, 'anchor-publishers.json');
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, 'utf8')).publishers ?? [];
  } catch {
    return [];
  }
}

/**
 * 0-value + data 트랜잭션의 실제 비용을 체인에 물어본다.
 * from 은 아무 주소나 써도 된다 — 순수 데이터 tx 라 결과가 발신자에 의존하지 않는다.
 */
async function estimateCost(data) {
  const probe = '0x000000000000000000000000000000000000dEaD';
  const [chainIdHex, gasHex, gasPriceHex] = await Promise.all([
    rpc('eth_chainId', []),
    rpc('eth_estimateGas', [{ from: probe, to: probe, value: '0x0', data }]),
    rpc('eth_gasPrice', []),
  ]);
  const gas = BigInt(gasHex);
  const gasPrice = BigInt(gasPriceHex);
  const wei = gas * gasPrice;
  return {
    chainId: parseInt(chainIdHex, 16),
    gas: Number(gas),
    gasPriceGwei: Number(gasPrice) / 1e9,
    wei: wei.toString(),
    costTtl: (Number(wei) / 1e18).toFixed(9).replace(/0+$/, ''),
  };
}

/**
 * 산출물 이름은 build.gradle 의 versionName 에서 조립한다 — 버전을 여기 박아 두면
 * 릴리스마다 두 곳을 고쳐야 하고, 어긋나면 엉뚱한 매니페스트를 앵커링하게 된다.
 */
function readVersionName() {
  const gradle = readFileSync(join(repoRoot, 'apps/android/android/app/build.gradle'), 'utf8');
  const m = /versionName\s+"([^"]+)"/.exec(gradle);
  if (!m) throw new Error('build.gradle 에서 versionName 을 찾지 못했다');
  return m[1];
}

async function main() {
  const versionName = readVersionName();
  const versioned = join(repoRoot, `벼린${versionName}.apk.manifest.json`);
  // 옛 릴리스는 버전 없는 이름으로 남아 있다. 새 이름이 없을 때만 그쪽을 읽는다.
  const legacy = join(repoRoot, '벼린.apk.manifest.json');
  const manifestPath = existsSync(versioned) ? versioned : legacy;
  if (manifestPath === legacy) {
    console.log(`[anchor] 벼린${versionName}.apk.manifest.json 이 없어 옛 이름(벼린.apk.manifest.json)을 읽는다.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const payload = buildPayload(manifest);
  const data = toHexData(payload);

  console.log('\n[anchor] TTL 체인 릴리스 앵커\n');
  console.log(`  매니페스트 ${manifestPath.slice(repoRoot.length + 1)}`);
  console.log(`  체인      ${TTL_CHAIN.chainId} (${TTL_CHAIN.rpcUrl})`);
  console.log(`  페이로드  ${payload}`);
  console.log(`  data      ${data.slice(0, 42)}… (${(data.length - 2) / 2} bytes)`);

  if (manifest.source?.workingTreeClean === false) {
    console.error(
      '\n[anchor] ⚠ 이 매니페스트는 커밋되지 않은 변경이 섞인 빌드에서 나왔다.\n' +
        '          소스로 추적할 수 없는 산출물을 체인에 못 박으면 안 된다. 중단.\n',
    );
    return 1;
  }

  // 가스 예측. 키 없이도 돌아간다 — 발행 전에 얼마가 드는지 먼저 안다.
  // RPC 가 막혀 있어도 드라이런 자체는 실패시키지 않는다.
  const cost = await estimateCost(data).catch((e) => ({ error: e.message }));
  if (cost.error) {
    console.log(`  가스      추정 실패 (${cost.error})`);
  } else {
    console.log(`  체인확인  eth_chainId = ${cost.chainId}${cost.chainId === TTL_CHAIN.chainId ? '' : '  ⚠ 기대와 다름'}`);
    console.log(`  가스      ${cost.gas} × ${cost.gasPriceGwei} gwei = ${cost.costTtl} TTL`);
  }

  // 발행 주소가 공개 목록에 없으면 검증기가 나중에 FAIL 을 낸다. 미리 잡는다.
  const publishers = loadPublishers();
  const addr = process.env.BYEORIN_ANCHOR_ADDRESS ?? null;
  if (publishers.length === 0) {
    console.log(
      '\n  ⚠ anchor-publishers.json 의 publishers 가 비어 있다.\n' +
        '    발행 후 publisher 주소를 여기 넣지 않으면 검증기가 from 을 검사하지\n' +
        '    못하고 [ SKIP ] 으로 내린다 — 앵커가 "누구의" 것인지 증명되지 않는다.',
    );
  } else if (addr && !publishers.map((p) => p.toLowerCase()).includes(addr.toLowerCase())) {
    console.error(
      `\n[anchor] ⚠ BYEORIN_ANCHOR_ADDRESS(${addr}) 가 anchor-publishers.json 에 없다.\n` +
        '          이 주소로 발행하면 검증기가 FAIL 을 낸다. 중단.\n',
    );
    return 1;
  }

  const send = process.argv.includes('--send');
  if (!send) {
    console.log('\n  (드라이런 — 실제 전송하려면 --send 와 BYEORIN_ANCHOR_KEY 필요)\n');
    return;
  }

  const key = process.env.BYEORIN_ANCHOR_KEY;
  if (!key) {
    console.error('[anchor] BYEORIN_ANCHOR_KEY 환경변수가 없습니다.');
    return 1;
  }

  // viem 은 이 스크립트에서만 쓴다. 검증기(verify-byeorin-apk.mjs)는 의존성 0 을
  // 유지해야 하므로 그쪽은 순수 fetch 로 RPC 를 부른다 — 제3자가 설치 없이
  // 검증할 수 있어야 하기 때문이다.
  //
  // 주의: viem 은 워크스페이스 패키지의 의존성이지 루트 의존성이 아니다.
  // pnpm 은 기본적으로 호이스팅하지 않으므로 저장소 루트에서 이 import 는
  // 실패한다. 실패하면 무엇을 해야 하는지 알려준다.
  let viem, viemAccounts;
  try {
    viem = await import('viem');
    viemAccounts = await import('viem/accounts');
  } catch (e) {
    console.error(
      '\n[anchor] viem 을 불러올 수 없습니다.\n' +
        `          ${e.message.split('\n')[0]}\n\n` +
        '          viem 은 워크스페이스 패키지(apps/*, packages/wallet-sdk)의 의존성이고\n' +
        '          저장소 루트에는 설치돼 있지 않습니다. 둘 중 하나로 해결합니다:\n\n' +
        '            pnpm add -w -D viem            # 루트에 추가 (package.json 변경됨)\n' +
        '            npm i --no-save viem           # 일회성, package.json 안 건드림\n',
    );
    return 1;
  }
  const { createWalletClient, http, defineChain } = viem;
  const { privateKeyToAccount } = viemAccounts;

  const chain = defineChain({
    id: TTL_CHAIN.chainId,
    name: 'TTL',
    nativeCurrency: { name: 'TTL', symbol: 'TTL', decimals: 18 },
    rpcUrls: { default: { http: [TTL_CHAIN.rpcUrl] } },
  });
  const account = privateKeyToAccount(key);
  const client = createWalletClient({ account, chain, transport: http() });

  console.log(`  publisher ${account.address}`);

  // 발행 직전 최종 확인 — 여기서 틀리면 append-only 라 되돌릴 수 없다.
  const liveChainId = parseInt(await rpc('eth_chainId', []), 16);
  if (liveChainId !== TTL_CHAIN.chainId) {
    console.error(`[anchor] RPC 의 chainId 가 ${liveChainId} 다 (기대 ${TTL_CHAIN.chainId}). 중단.`);
    return 1;
  }
  if (publishers.length > 0 && !publishers.map((p) => p.toLowerCase()).includes(account.address.toLowerCase())) {
    console.error(
      `[anchor] 이 키의 주소 ${account.address} 가 anchor-publishers.json 에 없다.\n` +
        '          이대로 발행하면 검증기가 FAIL 을 낸다. 중단.',
    );
    return 1;
  }
  const balance = BigInt(await rpc('eth_getBalance', [account.address, 'latest']));
  console.log(`  잔액      ${(Number(balance) / 1e18).toFixed(9)} TTL`);
  if (!cost.error && balance < BigInt(cost.wei)) {
    console.error(`[anchor] 잔액 부족 — 최소 ${cost.costTtl} TTL 필요. 중단.`);
    return 1;
  }

  // 자기 자신에게 0 TTL 을 보내며 data 만 싣는다. 수신자를 두지 않는 편이
  // "이건 값 전송이 아니라 기록" 이라는 의도가 분명하다.
  const txHash = await client.sendTransaction({ to: account.address, value: 0n, data });
  console.log(`\n[anchor] 전송됨: ${txHash}`);
  console.log(`  ${TTL_CHAIN.explorer}/tx/${txHash}`);

  // 블록에 들어갈 때까지 기다렸다가 블록 번호까지 기록한다.
  let receipt = null;
  for (let i = 0; i < 60 && !receipt; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  }

  manifest.anchor = {
    chainId: TTL_CHAIN.chainId,
    txHash,
    publisher: account.address,
    blockNumber: receipt ? parseInt(receipt.blockNumber, 16) : null,
    payload,
    note: '이 앵커는 "publisher 가 이 해시를 공표했다" 만 증명한다. 소스↔바이너리 대응은 재현 빌드가 필요하다.',
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`\n[anchor] 매니페스트에 앵커 기록 완료 (block ${manifest.anchor.blockNumber ?? '대기중'})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // process.exit() 를 쓰지 않는다 — fetch 로 열린 소켓이 남은 상태에서 강제 종료하면
  // Windows 에서 libuv assertion 이 터지며 종료 코드가 127 로 뒤덮인다.
  // exitCode 만 세우고 이벤트 루프가 자연히 비도록 둔다.
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (e) => {
      console.error('[anchor] 실패:', e.message);
      process.exitCode = 1;
    },
  );
}
