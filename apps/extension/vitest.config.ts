import { defineConfig } from 'vitest/config';

// extension 테스트 — 순수 함수 단위 검증만 수행.
// (UI / WXT 빌드 파이프라인은 별도. 렌더링 테스트는 jsdom 이 없어 하지 않는다.)
//
// entrypoints/ 도 수집한다 — Stage E2/E3 에서 화면을 popup/screens 로 분리하면서
// 검증 대상 순수 로직(금액 파싱·자산 해석 등)이 그쪽으로 옮겨갔다. src/ 만
// 보고 있으면 그 테스트가 조용히 실행되지 않는다.
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10_000,
    include: ['src/**/*.test.ts', 'entrypoints/**/*.test.ts'],
  },
});
