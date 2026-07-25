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
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
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
const outputs = [
  ['debug  ', join(androidDir, 'app/build/outputs/apk/debug/app-debug.apk')],
  ['release', join(androidDir, 'app/build/outputs/apk/release/app-release.apk')],
  ['release(unsigned)', join(androidDir, 'app/build/outputs/apk/release/app-release-unsigned.apk')],
];
console.log('\n[byeorin] APK:');
let found = false;
for (const [label, p] of outputs) {
  if (!existsSync(p)) continue;
  found = true;
  const mb = (statSync(p).size / 1024 / 1024).toFixed(1);
  console.log(`  ${label}  ${mb} MB  ${p}`);
}
if (!found) console.log('  (산출된 APK 없음)');

// ── helpers ───────────────────────────────────────────────────────────────

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
