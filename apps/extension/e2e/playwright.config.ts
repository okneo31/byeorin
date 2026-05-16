import { defineConfig } from '@playwright/test';

// Playwright config for "노동자의 지갑" MV3 extension smoke tests.
//
// 핵심:
//  - MV3 확장은 launchPersistentContext 로 --load-extension 인자를 줘야 로드된다.
//  - Headless 모드에서도 Chromium new headless ('chromium') 는 확장을 지원하지만
//    안정성 이슈가 있어 headless: false 로 두고 OS 의 GUI 없는 자동화 환경에서는
//    필요시 xvfb 등 가상 디스플레이로 감싼다.
//  - 확장 service worker / popup 의 라이프사이클 충돌을 피하려고 단일 워커, 순차 실행.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
  },
});
