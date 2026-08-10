#!/usr/bin/env node
// 벼린 — EIP-6963 아이콘 상수 재생성 / 검사 CLI.
//
// 무엇을 하나:
//   apps/extension/public/icon/128.png 를 base64 로 실어
//   apps/extension/entrypoints/inpage.ts 의 ICON_DATA_URL 상수를 맞춘다.
//   손으로 36,004자를 다시 붙여넣지 않기 위한 경로다.
//
// 사용법:
//   node scripts/sync-inpage-icon.mjs            # 검사만 (기본). 갈라졌으면 exit 1
//   node scripts/sync-inpage-icon.mjs --check    # 위와 같음
//   node scripts/sync-inpage-icon.mjs --dry-run  # 갱신 결과를 계산만 하고 쓰지 않음
//   node scripts/sync-inpage-icon.mjs --write    # inpage.ts 를 실제로 고쳐 쓴다
//
// 아이콘 교체 순서:
//   1) node scripts/generate-extension-icons.mjs      (또는 pnpm --filter @byeorin/extension build:icons)
//   2) node scripts/sync-inpage-icon.mjs --write
//   3) pnpm --filter @byeorin/extension test          (동등성 테스트가 통과하는지)
//
// 갈라짐을 자동으로 잡는 곳은 CLI 가 아니라 테스트다:
//   apps/extension/src/inpage-icon-sync.test.ts

import { inspect, renderUpdatedSource, writeUpdatedSource, INPAGE_PATH, ICON_PNG_PATH } from './inpage-icon-sync.mjs';

const argv = process.argv.slice(2);
const wantWrite = argv.includes('--write');
const wantDryRun = argv.includes('--dry-run');
const unknown = argv.filter((a) => !['--write', '--dry-run', '--check'].includes(a));
if (unknown.length > 0) {
  console.error(`sync-inpage-icon: 모르는 인자 ${unknown.join(' ')}`);
  process.exit(2);
}
if (wantWrite && wantDryRun) {
  console.error('sync-inpage-icon: --write 와 --dry-run 을 같이 줄 수 없다');
  process.exit(2);
}

const state = inspect();
console.log(`inpage.ts : ${INPAGE_PATH}`);
console.log(`icon png  : ${ICON_PNG_PATH} (${state.size.width}x${state.size.height}, ${state.pngBytes.length} B)`);
console.log(`const     : base64 ${state.base64.length} chars → ${state.constBytes.length} B`);
console.log(`sha256 const : ${state.constSha}`);
console.log(`sha256 png   : ${state.pngSha}`);

if (state.ok) {
  console.log('OK — 상수와 128.png 가 같다.');
  if (!wantWrite && !wantDryRun) process.exit(0);
}

if (!wantWrite && !wantDryRun) {
  console.error('DRIFT — 상수와 128.png 가 다르다. `--write` 로 갱신해라.');
  process.exit(1);
}

const { source, changed, base64 } = renderUpdatedSource();
if (wantDryRun) {
  console.log(
    `dry-run: ${changed ? '갱신 필요' : '변경 없음'} — 새 상수 ${base64.length} chars, ` +
      `파일 ${source.length} chars. 쓰지 않았다.`,
  );
  process.exit(0);
}

writeUpdatedSource(source);
console.log(`wrote ${INPAGE_PATH} (${changed ? '갱신함' : '내용 동일'})`);
