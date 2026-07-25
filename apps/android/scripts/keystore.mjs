#!/usr/bin/env node
// keystore.mjs — 릴리스 서명용 키스토어 생성.
//
// 안드로이드는 서명되지 않은 APK 를 설치하지 않는다. 디버그 빌드는 SDK 가 주는
// 공용 디버그 키로 자동 서명되지만, 그 키는 머신마다 다르고 Play 에 올릴 수도
// 없다. 그래서 프로젝트 전용 키스토어를 하나 만들어 둔다.
//
// 중요 — 이 키를 잃어버리면 **같은 앱으로 업데이트를 낼 수 없다.**
// (Play 는 서명 키로 앱 동일성을 판단한다.) 생성된 .jks 와 비밀번호는
// 저장소 바깥의 안전한 곳에 반드시 백업할 것. 두 파일 모두 gitignore 대상이다.
//
// 사용:
//   node scripts/keystore.mjs                 # 비밀번호 자동 생성
//   node scripts/keystore.mjs --pass <비밀번호>  # 직접 지정

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(appRoot, 'android');
const keyDir = join(androidDir, 'keys');
const keystorePath = join(keyDir, 'byeorin-release.jks');
const propsPath = join(androidDir, 'keystore.properties');
const alias = 'byeorin';

if (existsSync(keystorePath)) {
  console.log(`[byeorin] 키스토어가 이미 있습니다: ${keystorePath}`);
  console.log('          다시 만들려면 파일을 지운 뒤 실행하세요. (기존 키를 잃으면 업데이트 배포 불가)');
  process.exit(0);
}

const passIdx = process.argv.indexOf('--pass');
const password =
  passIdx >= 0 && process.argv[passIdx + 1]
    ? process.argv[passIdx + 1]
    : randomBytes(24).toString('base64url');

const keytool = findKeytool();
if (!keytool) {
  console.error('[byeorin] keytool 을 찾지 못했습니다. JAVA_HOME 을 설정하세요.');
  process.exit(1);
}

mkdirSync(keyDir, { recursive: true });

// 유효기간 10000일(≈27년) — Play 는 2033-10-22 이후까지 유효한 키를 요구한다.
const res = spawnSync(
  keytool,
  [
    '-genkeypair',
    '-v',
    '-keystore', keystorePath,
    '-alias', alias,
    '-keyalg', 'RSA',
    '-keysize', '4096',
    '-validity', '10000',
    '-storepass', password,
    '-keypass', password,
    '-dname', 'CN=Byeorin, OU=TTL Ecosystem, O=Byeorin, L=Seoul, C=KR',
  ],
  { stdio: 'inherit' },
);

if (res.status !== 0) {
  console.error('[byeorin] 키스토어 생성 실패');
  process.exit(res.status ?? 1);
}

writeFileSync(
  propsPath,
  [
    '# 벼린 릴리스 서명 자격증명 — 절대 커밋 금지 (.gitignore 등록됨).',
    '# 이 파일과 keys/byeorin-release.jks 를 함께 백업하세요.',
    `storeFile=keys/byeorin-release.jks`,
    `storePassword=${password}`,
    `keyAlias=${alias}`,
    `keyPassword=${password}`,
    '',
  ].join('\n'),
  'utf8',
);

console.log(`\n[byeorin] 키스토어 생성 완료`);
console.log(`  keystore : ${keystorePath}`);
console.log(`  props    : ${propsPath}`);
console.log(`  password : ${password}`);
console.log('\n  ↑ 이 두 파일을 저장소 바깥에 백업하세요. 잃어버리면 같은 앱으로 업데이트를 낼 수 없습니다.\n');

function findKeytool() {
  const exe = process.platform === 'win32' ? 'keytool.exe' : 'keytool';
  const roots = [
    process.env.JAVA_HOME,
    'C:/Program Files/Android/Android Studio/jbr',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/opt/android-studio/jbr',
  ].filter(Boolean);
  for (const r of roots) {
    const p = join(r, 'bin', exe);
    if (existsSync(p)) return p;
  }
  // PATH 에 있으면 그대로 쓴다.
  const probe = spawnSync(exe, ['-help'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return probe.status === 0 ? exe : null;
}
