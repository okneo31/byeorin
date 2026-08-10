// 벼린 — EIP-6963 아이콘 상수 ↔ 툴바 아이콘 PNG 동등성 모듈.
//
// 문제: apps/extension/entrypoints/inpage.ts 의 ICON_DATA_URL 은
// apps/extension/public/icon/128.png 를 base64 로 실은 **손으로 붙여넣은** 36,004자
// 문자열이다. 아이콘을 다시 뽑으면(scripts/generate-extension-icons.mjs 또는
// apps/extension/scripts/build-icons.mjs) 그 상수는 그대로 남아 두 그림이 조용히
// 갈라진다 — dApp picker 는 옛 마크를, 툴바는 새 마크를 띄운다.
//
// 이 모듈은 그 둘을 잇는 단 하나의 로직이다. 두 곳에서 쓴다:
//   1) scripts/sync-inpage-icon.mjs        — CLI. --check(기본) / --write.
//   2) apps/extension/src/inpage-icon-sync.test.ts — vitest. 갈라지면 실패.
//
// 상수의 형태(이 형태를 유지해야 정규식이 문다):
//   const ICON_DATA_URL =
//     'data:image/png;base64,' +
//     '<base64 한 줄>';

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 저장소 루트 (scripts/ 의 부모). */
export const repoRoot = resolve(__dirname, '..');

/** EIP-6963 상수를 들고 있는 파일. */
export const INPAGE_PATH = resolve(repoRoot, 'apps/extension/entrypoints/inpage.ts');

/** 진실의 원본 — 툴바 아이콘 128px. */
export const ICON_PNG_PATH = resolve(repoRoot, 'apps/extension/public/icon/128.png');

// 'data:image/png;base64,' + '....' 형태의 두 번째 문자열만 집는다.
// [\s\S]*? 가 아니라 공백/줄바꿈만 허용해 다른 상수를 잘못 물지 않게 한다.
const ICON_CONST_RE =
  /(const ICON_DATA_URL =\s*\n\s*'data:image\/png;base64,'\s*\+\s*\n\s*')([A-Za-z0-9+/=]+)(')/;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** inpage.ts 원문에서 base64 상수를 뽑는다. 못 찾으면 throw. */
export function extractIconBase64(source) {
  const m = source.match(ICON_CONST_RE);
  if (!m) {
    throw new Error(
      'inpage-icon-sync: ICON_DATA_URL base64 상수를 찾지 못했다. ' +
        "형태가 바뀌었으면 scripts/inpage-icon-sync.mjs 의 ICON_CONST_RE 를 함께 고쳐라.",
    );
  }
  return m[2];
}

/** PNG IHDR 을 읽어 시그니처와 크기를 확인한다. */
export function readPngSize(buf) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('inpage-icon-sync: PNG 시그니처가 아니다');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 현재 상태를 조사한다. 파일을 쓰지 않는다.
 * @returns {{ok: boolean, base64: string, constBytes: Buffer, pngBytes: Buffer,
 *            constSha: string, pngSha: string, size: {width:number,height:number}}}
 */
export function inspect() {
  const source = readFileSync(INPAGE_PATH, 'utf8');
  const base64 = extractIconBase64(source);
  const constBytes = Buffer.from(base64, 'base64');
  const pngBytes = readFileSync(ICON_PNG_PATH);
  return {
    ok: constBytes.equals(pngBytes),
    base64,
    constBytes,
    pngBytes,
    constSha: sha256(constBytes),
    pngSha: sha256(pngBytes),
    size: readPngSize(pngBytes),
  };
}

/**
 * 128.png 를 base64 로 다시 실어 inpage.ts 를 갱신한 **문자열**을 만든다.
 * 파일은 쓰지 않는다 — 쓰는 것은 CLI 의 --write 가 한다.
 * @returns {{source: string, changed: boolean, base64: string}}
 */
export function renderUpdatedSource() {
  const source = readFileSync(INPAGE_PATH, 'utf8');
  const base64 = readFileSync(ICON_PNG_PATH).toString('base64');
  const next = source.replace(ICON_CONST_RE, (_all, head, _old, tail) => head + base64 + tail);
  if (next === source && !ICON_CONST_RE.test(source)) {
    throw new Error('inpage-icon-sync: 상수를 찾지 못해 갱신하지 못했다');
  }
  return { source: next, changed: next !== source, base64 };
}

/** --write 실행부. 별도 함수로 둬 테스트가 실수로 부르지 않게 한다. */
export function writeUpdatedSource(nextSource) {
  writeFileSync(INPAGE_PATH, nextSource, 'utf8');
}
