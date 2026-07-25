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
import { join } from 'node:path';

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
