import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_PATH = path.resolve(__dirname, '../../.output/chrome-mv3');

// 각 test 마다 격리된 userDataDir 을 만들고 종료 시 정리한다.
//
// 왜 새 dir 마다 분리하는가?  같은 디렉토리를 동시/연속으로 두 컨텍스트가 잡으면
// Chromium 이 SingletonLock 으로 막아 두 번째가 즉시 실패한다. 또한 확장 storage 가
// 이전 test 로부터 오염되지 않도록 매번 깨끗한 상태로 시작한다.
async function launchWithExtension(slot: string): Promise<{ context: BrowserContext; userDataDir: string }> {
  const userDataDir = path.join(__dirname, `../.tmp-user-data-${slot}`);
  // 이전 run 의 잔존 dir 정리.
  await rm(userDataDir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    // Playwright 의 default args 에는 `--disable-extensions` 와
    // `--disable-component-extensions-with-background-pages` 가 포함돼 있어
    // 우리의 --load-extension 을 무력화한다. 이 둘만 제거하면 확장이 정상 로드된다.
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  return { context, userDataDir };
}

// MV3 service worker 를 얻는다. 두 가지 경로:
//  1. 이미 등록돼 있다면 context.serviceWorkers() 가 즉시 채워져 있다.
//  2. 아직 등록 전이라면 'serviceworker' 이벤트를 기다린다.
// 두 경로를 동시에 시도해 race 컨디션을 피한다 — 단독 waitForEvent 만 쓰면
// 이미 등록된 SW 는 이벤트를 발사하지 않아 timeout 한다.
async function getServiceWorker(context: BrowserContext, timeoutMs = 30_000): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  const deadline = Date.now() + timeoutMs;
  // race: polling + event
  return new Promise<Worker>((resolve, reject) => {
    let done = false;
    const finish = (sw: Worker | null, err?: Error): void => {
      if (done) return;
      done = true;
      if (sw) resolve(sw);
      else reject(err ?? new Error('SW timeout'));
    };
    context.once('serviceworker', (sw) => finish(sw));
    const poll = (): void => {
      if (done) return;
      const sw = context.serviceWorkers()[0];
      if (sw) return finish(sw);
      if (Date.now() >= deadline) return finish(null, new Error(`SW not registered within ${timeoutMs}ms`));
      setTimeout(poll, 250);
    };
    poll();
  });
}

async function teardown(context: BrowserContext, userDataDir: string): Promise<void> {
  await context.close();
  // userDataDir 은 컨텍스트 종료 후 비동기로 잡고 있을 수 있어 best-effort 로 지운다.
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}

test.describe('노동자의 지갑 extension smoke', () => {
  test('extension loads and popup renders Korean CTAs', async () => {
    const { context, userDataDir } = await launchWithExtension('popup');
    try {
      // service worker 등록을 기다린다 — 헬퍼는 polling + event race 로 안전하게 가져온다.
      const sw = await getServiceWorker(context);
      const extensionId = sw.url().split('/')[2];
      expect(extensionId).toMatch(/^[a-p]{32}$/);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);

      // 브랜드명: 어느 로케일에서도 "노동자의 지갑" 으로 표기된다.
      await expect(popup.locator('header.brand >> text=노동자의 지갑')).toBeVisible({ timeout: 10_000 });

      // home 모드의 CTA — popup.create_new = "새 지갑 만들기", popup.recover_by_mnemonic = "니모닉으로 복구"
      await expect(popup.getByRole('button', { name: '새 지갑 만들기' })).toBeVisible();
      await expect(popup.getByRole('button', { name: '니모닉으로 복구' })).toBeVisible();
    } finally {
      await teardown(context, userDataDir);
    }
  });

  test('inpage provider injects window.nodong on https page', async () => {
    const { context, userDataDir } = await launchWithExtension('inpage');
    try {
      const page = await context.newPage();
      await page.goto('https://example.com');

      // content script → inpage script 가 MAIN world 에 inject 될 때까지 대기.
      await page.waitForFunction(() => 'nodong' in window, undefined, { timeout: 15_000 });

      // 정적 chainId 노출(부팅 직후 동기 접근 dApp 대응) 확인.
      const chainId = await page.evaluate(() => {
        return (window as unknown as { nodong: { chainId: string } }).nodong.chainId;
      });
      expect(chainId).toBe('0x1e61');

      // 식별 플래그.
      const flags = await page.evaluate(() => {
        const n = (window as unknown as { nodong: { isNodong: boolean; isMetaMask: boolean } }).nodong;
        return { isNodong: n.isNodong, isMetaMask: n.isMetaMask };
      });
      expect(flags.isNodong).toBe(true);
      expect(flags.isMetaMask).toBe(false);

      // window.ethereum 슬롯도 차지하고 있어야 한다(다른 지갑이 없는 경우).
      // 단 inpage.ts 는 DOMContentLoaded 후 200ms 양보 + 즉시채움 경로가 있으므로 잠깐 기다린다.
      await page.waitForFunction(() => 'ethereum' in window && (window as any).ethereum?.isNodong === true, undefined, { timeout: 5_000 });
    } finally {
      await teardown(context, userDataDir);
    }
  });

  test('EIP-6963 announce dispatches with rdns top.ttl1.nodong', async () => {
    const { context, userDataDir } = await launchWithExtension('eip6963');
    try {
      const page = await context.newPage();
      await page.goto('https://example.com');

      // inpage 가 main world 에 들어올 때까지 대기 — nodong 가 정의되면 announce 도 이미 한 번 발사된 뒤다.
      // 하지만 우리는 *이후* 의 requestProvider 응답을 듣는다(매번 재announce).
      await page.waitForFunction(() => 'nodong' in window, undefined, { timeout: 15_000 });

      const announced = await page.evaluate(() => {
        return new Promise<{ uuid: string; name: string; icon: string; rdns: string }>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('announce timeout')), 5000);
          window.addEventListener(
            'eip6963:announceProvider',
            (e: Event) => {
              clearTimeout(t);
              const ce = e as CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string } }>;
              resolve(ce.detail.info);
            },
            { once: true },
          );
          window.dispatchEvent(new Event('eip6963:requestProvider'));
        });
      });
      expect(announced.rdns).toBe('top.ttl1.nodong');
      expect(announced.name).toMatch(/노동자/);
      expect(announced.uuid).toMatch(/^[0-9a-f-]{36}$/i);
      expect(announced.icon.startsWith('data:image/svg+xml')).toBe(true);
    } finally {
      await teardown(context, userDataDir);
    }
  });
});
