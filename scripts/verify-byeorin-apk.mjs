#!/usr/bin/env node
/*
 * verify-byeorin-apk.mjs — 받은 APK 가 진짜 벼린인지 **직접** 확인한다.
 *
 * 이 스크립트는 벼린을 신뢰하지 않는 사람을 위한 것이다. 우리가 만든 매니페스트와
 * 손에 든 파일을 대조할 뿐, 우리 서버에 아무것도 묻지 않는다. 저장소 없이
 * 이 파일 하나 + APK + 매니페스트만 있으면 돌아간다.
 *
 *   node verify-byeorin-apk.mjs 벼린.apk 벼린.apk.manifest.json
 *
 * 확인하는 것:
 *   1. 무결성  — 파일 SHA-256 이 매니페스트와 같은가 (전송 중 변조/손상 없음)
 *   2. 진위    — 서명 인증서 지문이 벼린 키와 같은가 (남이 만든 가짜가 아님)
 *   3. 출처    — 어떤 커밋/도구로 만들었다고 주장하는가 (사람이 읽고 판단)
 *
 * 확인 **못** 하는 것 (여기서 분명히 해둔다):
 *   - "이 소스에서 이 바이트가 나온다" — 재현 빌드는 아직 보장하지 않는다.
 *     즉 매니페스트의 commit 이 진짜 그 APK 를 만들었는지는 이 도구로 증명되지
 *     않는다. 소스를 읽고 직접 빌드해 동작을 비교하는 것까지가 현재 한계다.
 *   - APK 안의 코드가 안전한가 — 그건 소스 감사의 몫이다.
 *
 * apksigner(Android SDK build-tools) 가 있으면 2번까지, 없으면 1번만 검사한다.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const apkPath = process.argv[2] ?? '벼린.apk';
const manifestPath = process.argv[3] ?? '벼린.apk.manifest.json';

if (!existsSync(apkPath) || !existsSync(manifestPath)) {
  console.error(`사용법: node verify-byeorin-apk.mjs <APK> <manifest.json>`);
  console.error(`  APK      : ${apkPath} ${existsSync(apkPath) ? '' : '(없음)'}`);
  console.error(`  manifest : ${manifestPath} ${existsSync(manifestPath) ? '' : '(없음)'}`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const results = [];

// ── 1. 무결성 ─────────────────────────────────────────────────────────────
const actual = createHash('sha256').update(readFileSync(apkPath)).digest('hex');
results.push({
  name: '무결성 (SHA-256)',
  pass: actual === manifest.sha256,
  detail: actual === manifest.sha256 ? actual : `기대 ${manifest.sha256}\n          실제 ${actual}`,
});

// ── 2. 진위 (서명 인증서) ─────────────────────────────────────────────────
const apksigner = findApksigner();
if (!apksigner) {
  results.push({
    name: '진위 (서명 인증서)',
    pass: null,
    detail: 'apksigner 를 찾지 못해 건너뜀. Android SDK build-tools 설치 후 재실행 권장.',
  });
} else {
  try {
    const out = execFileSync(apksigner, ['verify', '--print-certs', apkPath], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const m = /certificate SHA-256 digest:\s*([0-9a-f]+)/i.exec(out);
    const got = m ? m[1] : null;
    const want = manifest.signer?.certSha256 ?? null;
    results.push({
      name: '진위 (서명 인증서)',
      pass: got !== null && want !== null && got === want,
      detail: got === want ? got : `기대 ${want}\n          실제 ${got}`,
    });
  } catch (e) {
    results.push({ name: '진위 (서명 인증서)', pass: false, detail: `서명 검증 실패: ${e.message}` });
  }
}

// ── 3. 출처 (사람이 읽는 정보) ────────────────────────────────────────────
const src = manifest.source ?? {};
results.push({
  name: '출처 (주장)',
  pass: src.workingTreeClean === true ? true : null,
  detail:
    `commit ${src.commitShort ?? '?'} (${src.branch ?? '?'})` +
    (src.workingTreeClean === false
      ? '\n          ⚠ 커밋되지 않은 변경이 섞인 빌드 — 소스로 추적 불가'
      : ''),
});

// ── 4. 온체인 앵커 ────────────────────────────────────────────────────────
//
// 매니페스트는 저장소에만 있으므로, 저장소를 통제하는 쪽이 과거 기록을 바꿀 수
// 있다. 체인에 들어간 기록은 그럴 수 없다. 여기서는 매니페스트가 가리키는
// 앵커 트랜잭션을 **체인에서 직접** 읽어(우리 서버 아님) 다음을 본다:
//   ⓪ 이 RPC 가 매니페스트가 말하는 그 체인인가 (eth_chainId)
//   ① 그 트랜잭션이 실제로 존재하는가
//   ② 보낸 주소가 공개된 publisher 목록에 있는가
//   ③ data 안에 이 APK 의 sha256 이 들어 있는가
//   ④ 블록에 들어갔는가 (pending 은 확정이 아니다)
//
// publisher 목록이 비어 있으면 ② 를 검사할 수 없다. 그때는 **OK 를 주지 않는다** —
// SKIP 으로 내리고 경고를 찍는다. "누가 공표했는지 모르는 앵커" 를 초록불로
// 보여주면 앵커가 증명하는 것보다 많은 것을 주장하게 된다.
//
// 의존성 없이 순수 fetch 로 JSON-RPC 를 부른다 — 제3자가 아무것도 설치하지 않고
// 검증할 수 있어야 하기 때문이다.
const anchor = manifest.anchor;
if (!anchor?.txHash) {
  results.push({
    name: '온체인 앵커',
    pass: null,
    detail:
      '이 릴리스에는 앵커가 없다. 매니페스트가 저장소에서만 검증되므로,\n' +
      '          저장소 통제자가 과거 기록을 바꿀 수 있다는 한계가 남는다.',
  });
} else {
  const rpcUrl = process.env.TTL_RPC_URL ?? 'https://rpc.ttl1.top';
  const rpc = async (method, params) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const { result, error } = await res.json();
    if (error) throw new Error(error.message);
    return result;
  };
  try {
    // ⓪ 이 RPC 가 매니페스트가 가리키는 체인인가. TTL_RPC_URL 로 아무 체인이나
    //    가리킬 수 있으므로, 확인하지 않으면 "아무 체인에서나 통과" 가 된다.
    const wantChainId = anchor.chainId ?? null;
    const gotChainId = parseInt(await rpc('eth_chainId', []), 16);
    const chainMatch = wantChainId === null || gotChainId === wantChainId;

    const tx = await rpc('eth_getTransactionByHash', [anchor.txHash]);
    if (!tx) throw new Error('트랜잭션을 체인에서 찾을 수 없다');

    const publishers = loadPublishers().map((p) => p.toLowerCase());
    const from = typeof tx.from === 'string' ? tx.from.toLowerCase() : '';
    const publisherUnchecked = publishers.length === 0;
    const knownPublisher = !publisherUnchecked && from !== '' && publishers.includes(from);
    const dataText = hexToUtf8(tx.input ?? '0x');
    const hashInData = dataText.includes(manifest.sha256);
    const mined = Boolean(tx.blockNumber);

    // 확실히 틀린 것 = FAIL. 확인할 수 없는 것 = SKIP. 둘을 섞지 않는다.
    const hardFail = !chainMatch || !hashInData || (!publisherUnchecked && !knownPublisher);
    const warnings = [];
    if (!chainMatch)
      warnings.push(`⚠ 체인 불일치 — 매니페스트는 chainId ${wantChainId}, 이 RPC 는 ${gotChainId}`);
    if (!hashInData) warnings.push('⚠ data 에 이 APK 의 sha256 이 없음');
    if (!publisherUnchecked && !knownPublisher)
      warnings.push('⚠ from 이 공개된 publisher 목록에 없음');
    if (publisherUnchecked)
      warnings.push(
        '⚠ anchor-publishers.json 이 없거나 publishers 가 비어 있어 from 을 검사하지 못했다.\n' +
          '          → 이 앵커를 "누가" 공표했는지 확인되지 않았다. 아무나 만든\n' +
          '            트랜잭션이어도 여기까지는 통과한다. 목록을 채우기 전에는\n' +
          '            이 항목을 근거로 삼지 말 것.',
      );
    if (!mined)
      warnings.push('⚠ 아직 블록에 들어가지 않았다(pending) — 확정된 기록이 아니다');

    results.push({
      name: '온체인 앵커',
      pass: hardFail ? false : publisherUnchecked || !mined ? null : true,
      detail:
        `tx ${anchor.txHash}\n` +
        `          chainId ${gotChainId}${chainMatch ? '' : ` (기대 ${wantChainId})`}\n` +
        `          from ${tx.from ?? '(없음)'}\n` +
        `          block ${mined ? parseInt(tx.blockNumber, 16) : '(pending)'}\n` +
        `          data "${dataText.slice(0, 80)}"` +
        warnings.map((w) => `\n          ${w}`).join(''),
    });
  } catch (e) {
    results.push({
      name: '온체인 앵커',
      pass: false,
      detail: `체인 조회 실패: ${e.message}\n          (RPC: ${rpcUrl})`,
    });
  }
}

function hexToUtf8(hex) {
  try {
    return Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('utf8');
  } catch {
    return '';
  }
}

/** 공개된 publisher 주소 목록. 없으면 from 검사를 건너뛴다(경고와 함께). */
function loadPublishers() {
  try {
    const p = join(dirname(manifestPath) || '.', 'anchor-publishers.json');
    return JSON.parse(readFileSync(p, 'utf8')).publishers ?? [];
  } catch {
    return [];
  }
}

// ── 보고 ──────────────────────────────────────────────────────────────────
console.log(`\n벼린 APK 검증 — ${apkPath}`);
console.log(`버전 ${manifest.versionName} (${manifest.versionCode}) · ${manifest.sizeBytes} bytes\n`);
for (const r of results) {
  const mark = r.pass === true ? '  OK  ' : r.pass === false ? ' FAIL ' : ' SKIP ';
  console.log(`[${mark}] ${r.name}`);
  console.log(`          ${r.detail}`);
}
const failed = results.some((r) => r.pass === false);
console.log(
  failed
    ? '\n❌ 검증 실패 — 이 파일을 설치하지 마세요.\n'
    : '\n✅ 이 파일은 매니페스트와 일치합니다.\n' +
        '   (주의: 재현 빌드는 아직 보장되지 않습니다. 매니페스트의 commit 이\n' +
        '    이 바이트를 만들었다는 증명은 아닙니다 — docs/VERIFIABILITY.md 참고)\n',
);
process.exit(failed ? 1 : 0);

function findApksigner() {
  const sdk =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null);
  if (!sdk) return null;
  const dir = join(sdk, 'build-tools');
  if (!existsSync(dir)) return null;
  const exe = process.platform === 'win32' ? 'apksigner.bat' : 'apksigner';
  for (const v of readdirSync(dir).sort().reverse()) {
    const p = join(dir, v, exe);
    if (existsSync(p)) return p;
  }
  return null;
}
