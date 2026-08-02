#!/usr/bin/env node
// gradle.mjs — Gradle 태스크 실행 래퍼.
//
// 존재 이유 세 가지:
//   1. `local.properties` (sdk.dir) 를 자동으로 맞춘다. 이 파일은 머신마다
//      경로가 달라 저장소에 넣을 수 없는데, 없으면 Gradle 이 곧바로 죽는다.
//   2. JAVA_HOME 이 비어 있으면 Android Studio 번들 JBR 을 찾아 넣는다.
//      (Windows 에서 JDK 를 따로 설치하지 않은 경우가 흔하다.)
//   3. 빌드가 끝나면 산출된 APK 경로와 크기를 그대로 찍어준다 — 실기기에
//      옮길 파일을 사람이 뒤지지 않게.
//
// 사용: node scripts/gradle.mjs assembleDebug [assembleRelease ...]

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(appRoot, 'android');

if (!existsSync(androidDir)) {
  fail(`android/ 프로젝트가 없습니다. 먼저 실행: cd ${appRoot} && npx cap add android`);
}

// ── 1. Android SDK 위치 확정 ──────────────────────────────────────────────
const sdkDir = findSdk();
if (!sdkDir) {
  fail(
    'Android SDK 를 찾지 못했습니다. ANDROID_HOME 또는 ANDROID_SDK_ROOT 를 설정하거나\n' +
      'Android Studio 를 기본 경로에 설치하세요.',
  );
}
writeLocalProperties(sdkDir);

// ── 2. JDK 확정 ───────────────────────────────────────────────────────────
const javaHome = process.env.JAVA_HOME ?? findBundledJbr();
if (!javaHome) {
  fail('JDK 17+ 를 찾지 못했습니다. JAVA_HOME 을 설정하세요.');
}

// ── 3. Gradle 실행 ────────────────────────────────────────────────────────
const tasks = process.argv.slice(2);
if (tasks.length === 0) fail('실행할 Gradle 태스크를 지정하세요 (예: assembleDebug).');

// 절대 경로로 부른다. cwd 를 android/ 로 줘도 Windows 는 현재 디렉터리를
// PATH 처럼 뒤지지 않아 'gradlew.bat' 만으로는 "명령을 찾을 수 없음" 이 난다.
const wrapper = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
console.log(`[byeorin] SDK   : ${sdkDir}`);
console.log(`[byeorin] JAVA  : ${javaHome}`);
console.log(`[byeorin] tasks : ${tasks.join(' ')}\n`);

const res = spawnSync(wrapper, [...tasks, '--no-daemon'], {
  cwd: androidDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdkDir, ANDROID_SDK_ROOT: sdkDir },
});

if (res.status !== 0) process.exit(res.status ?? 1);

// ── 4. 산출물 보고 ────────────────────────────────────────────────────────
const releaseApk = join(androidDir, 'app/build/outputs/apk/release/app-release.apk');
// 배포 파일명은 버전을 품는다 — 사용자가 받은 파일이 어느 릴리스인지 파일명만
// 보고 알 수 있어야 하고, 옛 버전을 덮어써 흔적이 사라지는 일도 없어야 한다.
const distName = existsSync(releaseApk) ? `벼린${readVersionName()}.apk` : null;
const outputs = [
  ['debug  ', join(androidDir, 'app/build/outputs/apk/debug/app-debug.apk')],
  ['release', releaseApk],
  ['release(unsigned)', join(androidDir, 'app/build/outputs/apk/release/app-release-unsigned.apk')],
];
console.log('\n[byeorin] APK:');
let found = false;
for (const [label, p] of outputs) {
  if (!existsSync(p)) continue;
  found = true;
  const mb = (statSync(p).size / 1024 / 1024).toFixed(1);
  // release 는 아래에서 배포 이름으로 복사되므로 그 이름을 같이 찍어준다.
  const as = p === releaseApk && distName ? `  → ${distName}` : '';
  console.log(`  ${label}  ${mb} MB  ${p}${as}`);
}
if (!found) console.log('  (산출된 APK 없음)');

// ── 5. 실기기용 고정 경로로 복사 ──────────────────────────────────────────
//
// Gradle 산출 경로는 깊어서 매번 찾아 들어가기 번거롭다. 서명된 release APK 를
// 저장소 루트의 `벼린<versionName>.apk` 로 복사해, 폰에 옮길 파일 위치를 한 곳으로
// 고정하면서 버전은 파일명에 남긴다.
// 같은 키로 서명되므로 이 파일을 덮어 설치하면 기존 지갑(금고)이 그대로 유지된다.
if (existsSync(releaseApk)) {
  const repoRoot = resolve(appRoot, '..', '..');
  const dest = join(repoRoot, distName);
  copyFileSync(releaseApk, dest);
  const mb = (statSync(dest).size / 1024 / 1024).toFixed(1);
  console.log(`\n[byeorin] 실기기용 복사본 갱신: ${dest}  (${mb} MB)`);

  // ── 6. 검증 매니페스트 ────────────────────────────────────────────────
  //
  // 원칙: 누구나 검증 가능한 보안. 배포하는 파일과 함께 "이게 어디서 나왔는지"
  // 를 항상 같이 낸다. 매니페스트 없이 나간 APK 는 받는 사람이 우리를 믿는 것
  // 말고는 확인할 방법이 없다 — 그러면 원칙이 구호로 끝난다.
  const gen = spawnSync(process.execPath, [join(appRoot, 'scripts/release-manifest.mjs'), dest], {
    stdio: 'inherit',
  });
  if (gen.status !== 0) {
    console.error('[byeorin] ⚠ 매니페스트 생성 실패 — 이 APK 는 검증 정보 없이 나갑니다.');
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

// 배포 파일명에 넣을 versionName. **하드코딩하지 않고** build.gradle 에서 읽는다 —
// 버전을 올리는 곳은 한 군데뿐이어야 한다.
// 읽지 못하면 곧바로 죽인다. 옛 이름(`벼린.apk`)으로 조용히 떨어지면 이전 릴리스를
// 덮어쓰고, 매니페스트도 짝이 어긋난 채 나간다 — 실패는 드러나야 한다.
function readVersionName() {
  const file = join(androidDir, 'app/build.gradle');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    fail(`build.gradle 을 읽지 못했습니다 (${file}): ${e.message}`);
  }
  const m = /versionName\s+"([^"]+)"/.exec(text);
  if (!m) fail(`build.gradle 에서 versionName 을 찾지 못했습니다: ${file}`);
  return m[1];
}

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    process.env.HOME ? join(process.env.HOME, 'Android', 'Sdk') : null,
    process.env.HOME ? join(process.env.HOME, 'Library', 'Android', 'sdk') : null,
  ].filter(Boolean);
  return candidates.find((c) => existsSync(join(c, 'platform-tools'))) ?? null;
}

function writeLocalProperties(sdk) {
  const file = join(androidDir, 'local.properties');
  // Gradle 은 Windows 경로의 역슬래시를 이스케이프로 읽는다 — 반드시 escape.
  const line = `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`;
  if (existsSync(file) && readFileSync(file, 'utf8').includes(line.trim())) return;
  writeFileSync(file, line, 'utf8');
  console.log(`[byeorin] local.properties 갱신: ${sdk}`);
}

function findBundledJbr() {
  const candidates = [
    'C:/Program Files/Android/Android Studio/jbr',
    'C:/Program Files/Android/Android Studio1/jbr',
    process.env.HOME ? join(process.env.HOME, 'Applications/Android Studio.app/Contents/jbr/Contents/Home') : null,
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/opt/android-studio/jbr',
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

function fail(msg) {
  console.error(`\n[byeorin] ${msg}\n`);
  process.exit(1);
}
