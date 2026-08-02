#!/usr/bin/env node
// release-manifest.mjs — 배포한 APK 가 "어느 소스에서 나왔는지" 를 남긴다.
//
// 원칙: 누구나 검증 가능한 보안.
//   사용자가 받은 파일이 우리가 만들었다고 말하는 그 파일인지, **우리를 믿지 않고**
//   확인할 수 있어야 한다. 그러려면 최소한 다음 셋이 공개돼야 한다:
//     1. 산출물의 해시        — 파일이 중간에 바뀌지 않았는가
//     2. 서명 인증서 지문      — 우리 키로 서명됐는가 (남이 만든 가짜가 아닌가)
//     3. 출처 커밋 + 도구 버전 — 어떤 소스로 만들었는가
//
// 지금 이 매니페스트가 보장하는 것은 **무결성**이다. "같은 소스로 남이 빌드하면
// 같은 바이트가 나온다"(재현 빌드)는 아직 아니다 — 그건 별도 작업이고,
// docs/VERIFIABILITY.md 에 남은 과제로 적어 두었다. 할 수 있는 것만 정확히 주장한다.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');

export function buildManifest(apkPath) {
  const bytes = readFileSync(apkPath);
  return {
    // 실제로 배포되는 파일 이름을 그대로 적는다 — 사용자가 받은 파일과
    // 대조하는 값이라 고정 이름을 박아 두면 매니페스트가 거짓말을 한다.
    artifact: basename(apkPath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    ...readVersion(),
    signer: readSignerFingerprint(apkPath),
    source: readGitProvenance(),
    toolchain: readToolchain(),
    // 이 매니페스트가 무엇을 주장하고 무엇을 주장하지 않는지 파일 안에 박아 둔다.
    claims: {
      integrity: '이 해시와 일치하는 파일은 우리가 배포한 그 파일이다.',
      authenticity: '이 인증서 지문으로 서명된 APK 만 벼린이 만든 것이다.',
      notClaimed:
        '재현 빌드는 아직 보장하지 않는다 — 같은 커밋으로 빌드해도 바이트가 다를 수 있다.',
    },
  };
}

function readVersion() {
  const gradle = readFileSync(join(appRoot, 'android/app/build.gradle'), 'utf8');
  const code = /versionCode\s+(\d+)/.exec(gradle);
  const name = /versionName\s+"([^"]+)"/.exec(gradle);
  return {
    versionName: name ? name[1] : null,
    versionCode: code ? Number(code[1]) : null,
  };
}

/**
 * 배포 산출물 파일명. 버전을 하드코딩하지 않고 build.gradle 의 versionName 에서
 * 조립한다 — 버전을 올릴 때 고쳐야 할 곳이 build.gradle 하나로 끝나야 한다.
 * versionName 을 못 읽으면 버전 없는 옛 이름으로 떨어진다.
 */
export function apkFileName() {
  const { versionName } = readVersion();
  return versionName ? `벼린${versionName}.apk` : '벼린.apk';
}

/** 서명 인증서 SHA-256. 사용자가 받은 APK 가 우리 키로 서명됐는지 대조하는 값. */
function readSignerFingerprint(apkPath) {
  const apksigner = findApksigner();
  if (!apksigner) return { certSha256: null, note: 'apksigner 미발견 — 지문 생략' };
  try {
    const out = execFileSync(apksigner, ['verify', '--print-certs', apkPath], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const m = /certificate SHA-256 digest:\s*([0-9a-f]+)/i.exec(out);
    return { certSha256: m ? m[1] : null };
  } catch (e) {
    return { certSha256: null, note: `apksigner 실패: ${e.message}` };
  }
}

function findApksigner() {
  const sdk =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null);
  if (!sdk) return null;
  const dir = join(sdk, 'build-tools');
  if (!existsSync(dir)) return null;
  const exe = process.platform === 'win32' ? 'apksigner.bat' : 'apksigner';
  // 가장 최신 build-tools 를 쓴다.
  const versions = readdirSync(dir).sort().reverse();
  for (const v of versions) {
    const p = join(dir, v, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 출처 커밋. **작업 트리가 더러우면 그대로 기록한다** — 커밋되지 않은 변경이
 * 섞인 빌드는 애초에 검증 대상이 될 수 없고, 그 사실을 숨기면 매니페스트가
 * 거짓말을 하게 된다.
 */
function readGitProvenance() {
  // core.quotepath=false — 이걸 끄지 않으면 git 이 한글 경로를 "ë²¼..."
  // 같은 8진 이스케이프로 내보내 경로 비교가 영영 안 맞는다.
  const git = (args) =>
    execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  try {
    // 산출물 자신은 더러움 판정에서 뺀다.
    //
    // 매니페스트는 **의도적으로 추적**된다 — 공개된 검증 근거라 저장소에 있어야
    // 한다. 그런데 빌드가 그 파일을 다시 쓰므로, 빼지 않으면 "매니페스트를 쓰는
    // 행위 자체가 트리를 더럽혀 다음 매니페스트가 더럽다고 말하는" 자기참조에
    // 빠진다. 여기서 보고 싶은 것은 **소스**가 커밋된 상태인가이다.
    //
    // 버전이 이름에 들어가므로 고정 목록이 아니라 패턴으로 판정한다 — 0.5.16 을
    // 찍고 나서 목록을 고쳐야 한다면 다음 릴리스에서 반드시 잊는다.
    // 버전 없는 옛 이름(벼린.apk / 벼린.apk.manifest.json)도 패턴에 포함한다:
    // 옛 매니페스트가 아직 추적 중이라 지우거나 남기는 판단이 끝나기 전까지는
    // 그 파일의 상태 변화가 소스의 더러움으로 오인되면 안 된다.
    const artifactRe = /^벼린[\d.]*\.apk(\.manifest\.json)?$/;
    const dirty = git(['status', '--porcelain'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // porcelain 형식: "XY path" — 상태 두 글자를 떼고 경로만 본다.
      // 한글 경로는 git 이 따옴표로 감싸므로 벗겨서 비교한다.
      .filter((l) => {
        const path = l.slice(2).trim().replace(/^"(.*)"$/, '$1');
        return !artifactRe.test(path);
      })
      .length > 0;
    return {
      commit: git(['rev-parse', 'HEAD']),
      commitShort: git(['rev-parse', '--short', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      workingTreeClean: !dirty,
      ...(dirty
        ? { warning: '커밋되지 않은 변경이 섞인 빌드다. 이 산출물은 소스로 추적할 수 없다.' }
        : {}),
    };
  } catch {
    return { commit: null, warning: 'git 정보를 읽지 못했다.' };
  }
}

function readToolchain() {
  const vars = readFileSync(join(appRoot, 'android/variables.gradle'), 'utf8');
  const pick = (k) => {
    const m = new RegExp(`${k}\\s*=\\s*['"]?([\\w.]+)`).exec(vars);
    return m ? m[1] : null;
  };
  let agp = null;
  try {
    const root = readFileSync(join(appRoot, 'android/build.gradle'), 'utf8');
    const m = /com\.android\.tools\.build:gradle:([\d.]+)/.exec(root);
    agp = m ? m[1] : null;
  } catch {
    /* 무시 */
  }
  let gradle = null;
  try {
    const wrap = readFileSync(
      join(appRoot, 'android/gradle/wrapper/gradle-wrapper.properties'),
      'utf8',
    );
    const m = /gradle-([\d.]+)-/.exec(wrap);
    gradle = m ? m[1] : null;
  } catch {
    /* 무시 */
  }
  return {
    node: process.version,
    gradle,
    androidGradlePlugin: agp,
    compileSdk: pick('compileSdkVersion'),
    minSdk: pick('minSdkVersion'),
    targetSdk: pick('targetSdkVersion'),
  };
}

// 직접 실행 시: 매니페스트를 만들어 저장소 루트에 쓴다.
//
// 직접 실행 판별에 문자열 조립을 쓰면 안 된다 — Windows 는 `file:///D:/...` 처럼
// 슬래시가 셋이라 `file://` + 경로 로는 영영 어긋난다 (실제로 조용히 아무것도
// 안 하고 끝나는 것을 확인했다). pathToFileURL 로 정규화해서 비교한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 인자 없이 단독 실행해도 동작하도록 기본 경로도 버전에서 조립한다.
  const apk = process.argv[2] ?? join(repoRoot, apkFileName());
  if (!existsSync(apk)) {
    console.error(`[byeorin] APK 가 없습니다: ${apk}`);
    process.exit(1);
  }
  const manifest = buildManifest(apk);
  // 매니페스트 이름은 산출물과 짝을 맞춘다 — 어느 APK 의 근거인지 이름만으로 안다.
  const dest = join(repoRoot, `${manifest.artifact}.manifest.json`);
  writeFileSync(dest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[byeorin] 릴리스 매니페스트: ${dest}`);
  console.log(`  sha256  ${manifest.sha256}`);
  console.log(`  commit  ${manifest.source.commitShort ?? '?'}${manifest.source.workingTreeClean === false ? ' (작업 트리 더러움 ⚠)' : ''}`);
  console.log(`  signer  ${manifest.signer.certSha256 ?? '(미확인)'}`);
}
