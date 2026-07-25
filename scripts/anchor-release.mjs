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

import { readFileSync, writeFileSync } from 'node:fs';
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

async function main() {
  const manifestPath = join(repoRoot, '벼린.apk.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const payload = buildPayload(manifest);
  const data = toHexData(payload);

  console.log('\n[anchor] TTL 체인 릴리스 앵커\n');
  console.log(`  체인      ${TTL_CHAIN.chainId} (${TTL_CHAIN.rpcUrl})`);
  console.log(`  페이로드  ${payload}`);
  console.log(`  data      ${data.slice(0, 42)}… (${(data.length - 2) / 2} bytes)`);

  if (manifest.source?.workingTreeClean === false) {
    console.error(
      '\n[anchor] ⚠ 이 매니페스트는 커밋되지 않은 변경이 섞인 빌드에서 나왔다.\n' +
        '          소스로 추적할 수 없는 산출물을 체인에 못 박으면 안 된다. 중단.\n',
    );
    process.exit(1);
  }

  const send = process.argv.includes('--send');
  if (!send) {
    console.log('\n  (드라이런 — 실제 전송하려면 --send 와 BYEORIN_ANCHOR_KEY 필요)\n');
    return;
  }

  const key = process.env.BYEORIN_ANCHOR_KEY;
  if (!key) {
    console.error('[anchor] BYEORIN_ANCHOR_KEY 환경변수가 없습니다.');
    process.exit(1);
  }

  // viem 은 이 스크립트에서만 쓴다. 검증기(verify-byeorin-apk.mjs)는 의존성 0 을
  // 유지해야 하므로 그쪽은 순수 fetch 로 RPC 를 부른다 — 제3자가 설치 없이
  // 검증할 수 있어야 하기 때문이다.
  const { createWalletClient, http, defineChain } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');

  const chain = defineChain({
    id: TTL_CHAIN.chainId,
    name: 'TTL',
    nativeCurrency: { name: 'TTL', symbol: 'TTL', decimals: 18 },
    rpcUrls: { default: { http: [TTL_CHAIN.rpcUrl] } },
  });
  const account = privateKeyToAccount(key);
  const client = createWalletClient({ account, chain, transport: http() });

  console.log(`  publisher ${account.address}`);

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
  main().catch((e) => {
    console.error('[anchor] 실패:', e.message);
    process.exit(1);
  });
}
