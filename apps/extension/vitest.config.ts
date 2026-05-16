import { defineConfig } from 'vitest/config';

// extension 테스트 — 순수 함수 단위 검증만 수행.
// (UI / WXT 빌드 파이프라인은 별도. 여기서는 src/lib/* 만 테스트.)
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10_000,
    include: ['src/**/*.test.ts'],
  },
});
