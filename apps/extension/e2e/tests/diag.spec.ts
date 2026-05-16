import { test, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_PATH = path.resolve(__dirname, '../../.output/chrome-mv3');

test('diag4: inspect chrome://extensions via shadow DOM', async () => {
  const userDataDir = path.join(__dirname, '../.tmp-user-data-diag');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const p = context.pages()[0] ?? await context.newPage();
  await p.goto('chrome://extensions');
  // Enable dev mode and read.
  await p.waitForTimeout(2000);
  const info = await p.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    const all: any[] = [];
    if (!mgr) return { error: 'no extensions-manager' };
    const itemList = (mgr as any).shadowRoot?.querySelector('extensions-item-list');
    if (!itemList) return { error: 'no extensions-item-list', mgrShadow: !!(mgr as any).shadowRoot };
    const items = (itemList as any).shadowRoot?.querySelectorAll('extensions-item') || [];
    for (const item of items) {
      const sr = item.shadowRoot;
      const name = sr?.querySelector('#name')?.textContent || '';
      const id = item.getAttribute('id') || '';
      const errors = sr?.querySelector('#errors-button')?.textContent || '';
      all.push({ id, name: name.trim(), errors: errors.trim() });
    }
    return { count: items.length, all };
  });
  console.log('[diag] extensions:', JSON.stringify(info, null, 2));

  // Try waiting for SW longer (60s)
  console.log('[diag] Waiting for SW up to 30s...');
  try {
    const sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
    console.log('[diag] SW arrived:', sw.url());
  } catch (e) {
    console.log('[diag] SW timeout 30s');
  }

  // Try directly opening the popup URL using known extension id
  if (info && (info as any).all && (info as any).all[0]) {
    const eid = (info as any).all[0].id;
    console.log('[diag] trying popup with id=', eid);
    try {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${eid}/popup.html`);
      const title = await popup.title();
      console.log('[diag] popup title=', title);
      await popup.waitForTimeout(2000);
      console.log('[diag] SWs after popup =', context.serviceWorkers().length);
      const text = await popup.locator('body').textContent({ timeout: 5000 }).catch((e) => 'err:' + e.message);
      console.log('[diag] popup body text (first 200):', (text || '').slice(0, 200));
    } catch (e) {
      console.log('[diag] popup error:', (e as Error).message);
    }
  }

  await context.close();
});
