import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// EIP-6963 아이콘 상수 ↔ 툴바 아이콘 PNG 동등성.
//
// entrypoints/inpage.ts 의 ICON_DATA_URL 은 public/icon/128.png 를 base64 로 실은
// 36,004자 문자열이다. 손으로 붙여넣은 것이라, 아이콘을 다시 뽑으면 상수만 옛 그림으로
// 남아 dApp picker 와 툴바가 다른 마크를 띄운다 — 조용히.
//
// 이 테스트가 그 갈라짐을 잡는다. 실패하면 고치는 법:
//   node scripts/sync-inpage-icon.mjs --write
//
// 로직 원본: scripts/inpage-icon-sync.mjs (CLI 와 같은 정규식을 쓴다).
// vitest 가 저장소 루트 밖 모듈을 못 물 수 있어 import 하지 않고 파일만 읽는다.

const EXT_ROOT = resolve(__dirname, '..');
const INPAGE_PATH = resolve(EXT_ROOT, 'entrypoints/inpage.ts');
const ICON_PNG_PATH = resolve(EXT_ROOT, 'public/icon/128.png');

// scripts/inpage-icon-sync.mjs 의 ICON_CONST_RE 와 같은 형태.
const ICON_CONST_RE =
  /(const ICON_DATA_URL =\s*\n\s*'data:image\/png;base64,'\s*\+\s*\n\s*')([A-Za-z0-9+/=]+)(')/;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// scripts/inpage-icon-sync.mjs 의 extractIconBase64 와 같은 계약.
// 못 찾으면 왜 못 찾았는지 말하고 던진다 — `!` 로 눌러 두면 실패가
// "undefined 의 length" 같은 엉뚱한 메시지로 나온다.
function extractIconBase64(src: string): string {
  const m = src.match(ICON_CONST_RE);
  if (m === null) {
    throw new Error(
      'ICON_DATA_URL 상수 형태가 바뀌었다 — scripts/inpage-icon-sync.mjs 의 ICON_CONST_RE 도 함께 고쳐라',
    );
  }
  const base64 = m[2];
  if (base64 === undefined) {
    throw new Error(
      'ICON_CONST_RE 의 2번 캡처 그룹이 비었다 — 정규식 그룹 구성이 바뀌었다',
    );
  }
  return base64;
}

describe('EIP-6963 아이콘 상수', () => {
  const source = readFileSync(INPAGE_PATH, 'utf8');
  const png = readFileSync(ICON_PNG_PATH);

  it('inpage.ts 에서 base64 상수를 뽑을 수 있다', () => {
    // 형태가 바뀌었으면 extractIconBase64 가 고치는 법을 담아 던진다.
    const base64 = extractIconBase64(source);
    expect(base64.length).toBeGreaterThan(0);
  });

  it('디코드한 바이트가 public/icon/128.png 와 해시까지 같다', () => {
    const base64 = extractIconBase64(source);
    const decoded = Buffer.from(base64, 'base64');
    expect(
      sha256(decoded),
      '아이콘 상수와 128.png 가 갈라졌다 — `node scripts/sync-inpage-icon.mjs --write` 로 맞춰라',
    ).toBe(sha256(png));
    expect(decoded.length).toBe(png.length);
  });

  it('128.png 는 PNG 이고 EIP-6963 권장(96px 이상) 정사각이다', () => {
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(96);
  });
});
