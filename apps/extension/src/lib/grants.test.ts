// origin+method+address grant store 단위 테스트.
// chrome.storage.session 을 인메모리로 모킹하고 add/has/revoke/clear/expiry 의
// 의미론적 약속을 잠근다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── 테스트 상수 ────────────────────────────────────────────────────────────────
// EIP-55 / 표준 소문자 케이스 무관 — grants.ts 가 내부적으로 lowercase 정규화.
const ADDR_A = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ADDR_B = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

// ── chrome.storage.session 모킹 ────────────────────────────────────────────────
type SessionStore = Record<string, unknown>;
let SESSION: SessionStore;

function installChromeMock(): void {
  SESSION = {};
  const session = {
    get: vi.fn(async (key?: string | string[] | null) => {
      if (key === undefined || key === null) return { ...SESSION };
      if (typeof key === 'string') {
        return key in SESSION ? { [key]: SESSION[key] } : {};
      }
      const out: SessionStore = {};
      for (const k of key) if (k in SESSION) out[k] = SESSION[k];
      return out;
    }),
    set: vi.fn(async (items: SessionStore) => {
      Object.assign(SESSION, items);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete SESSION[k];
    }),
    clear: vi.fn(async () => {
      SESSION = {};
    }),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session },
  };
}

function uninstallChromeMock(): void {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

// import 는 mock 설치 후. 매 테스트마다 module cache 를 비워 깨끗한 상태 보장.
async function loadGrants() {
  vi.resetModules();
  return await import('./grants.js');
}

beforeEach(() => {
  installChromeMock();
  vi.useFakeTimers();
  // 결정적 시작 시점. (Date.now() = 2026-01-01T00:00:00Z)
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  uninstallChromeMock();
});

describe('grants: add / has / revoke', () => {
  it('hasGrant() returns false when nothing is stored', async () => {
    const g = await loadGrants();
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(false);
  });

  it('addGrant() then hasGrant() returns true for same (origin, method, address)', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'eth_sendTransaction', ADDR_A);
    expect(
      await g.hasGrant('https://app.foo', 'eth_sendTransaction', ADDR_A),
    ).toBe(true);
  });

  it('grants are isolated by method', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(true);
    expect(
      await g.hasGrant('https://app.foo', 'eth_sendTransaction', ADDR_A),
    ).toBe(false);
    expect(
      await g.hasGrant('https://app.foo', 'eth_signTypedData_v4', ADDR_A),
    ).toBe(false);
  });

  it('grants are isolated by origin', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    expect(await g.hasGrant('https://app.bar', 'personal_sign', ADDR_A)).toBe(false);
  });

  it('grants are isolated by address (account switch invalidates grant)', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(true);
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_B)).toBe(false);
  });

  it('address comparison is case-insensitive (EIP-55 checksum tolerated)', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A.toLowerCase());
    // 대문자 체크섬 형식으로 조회해도 같은 grant 로 인식해야 한다.
    const mixedCase = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    expect(
      await g.hasGrant('https://app.foo', 'personal_sign', mixedCase),
    ).toBe(true);
  });

  it('revokeGrant() removes a single grant', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    await g.addGrant('https://app.foo', 'eth_sendTransaction', ADDR_A);
    await g.revokeGrant('https://app.foo', 'personal_sign', ADDR_A);
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(false);
    // 다른 메서드의 grant 는 살아 있어야 한다.
    expect(
      await g.hasGrant('https://app.foo', 'eth_sendTransaction', ADDR_A),
    ).toBe(true);
  });

  it('revokeGrant() on a non-existent key is a no-op', async () => {
    const g = await loadGrants();
    await expect(
      g.revokeGrant('https://nope', 'personal_sign', ADDR_A),
    ).resolves.toBeUndefined();
  });

  it('revokeAllForOrigin() removes every grant for that origin only', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    await g.addGrant('https://app.foo', 'eth_sendTransaction', ADDR_A);
    await g.addGrant('https://app.bar', 'personal_sign', ADDR_A);
    await g.revokeAllForOrigin('https://app.foo');
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(false);
    expect(
      await g.hasGrant('https://app.foo', 'eth_sendTransaction', ADDR_A),
    ).toBe(false);
    expect(await g.hasGrant('https://app.bar', 'personal_sign', ADDR_A)).toBe(true);
  });

  it('clearAllGrants() wipes the whole store', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    await g.addGrant('https://app.bar', 'eth_sendTransaction', ADDR_A);
    await g.clearAllGrants();
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(false);
    expect(
      await g.hasGrant('https://app.bar', 'eth_sendTransaction', ADDR_A),
    ).toBe(false);
    expect(await g.listActiveGrants()).toEqual([]);
  });
});

describe('grants: 1-hour expiry', () => {
  it('GRANT_TTL_MS is exactly 60 minutes', async () => {
    const g = await loadGrants();
    expect(g.GRANT_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('grant expires after 60 minutes', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    // 59:59 — 아직 살아 있다.
    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(true);
    // 정확히 60:00 — 만료.
    vi.advanceTimersByTime(1);
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(false);
  });

  it('expired entries are cleaned up by hasGrant()', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A);
    expect(SESSION['nd:method-grants']).toEqual({});
  });

  it('addGrant() refreshes the expiry timer', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    vi.advanceTimersByTime(30 * 60 * 1000); // 30 분 경과
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A); // 재발급
    vi.advanceTimersByTime(45 * 60 * 1000);
    // 재발급 덕에 30 분 시점부터 60 분이므로 합계 75 분 < 90 분 — 살아 있다.
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(true);
  });

  it('listActiveGrants() skips expired entries', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    vi.advanceTimersByTime(30 * 60 * 1000);
    await g.addGrant('https://app.bar', 'eth_sendTransaction', ADDR_A);
    vi.advanceTimersByTime(31 * 60 * 1000); // foo 만료(61분), bar 생존(31분)
    const active = await g.listActiveGrants();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      origin: 'https://app.bar',
      method: 'eth_sendTransaction',
      address: ADDR_A.toLowerCase(),
    });
  });
});

describe('grants: race conditions', () => {
  it('has() then revoke() — revoke must invalidate even after has() observed true', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(true);
    await g.revokeGrant('https://app.foo', 'personal_sign', ADDR_A);
    // chrome.storage 쓰기는 serialized — read-after-write 보장.
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(false);
  });

  it('clearAllGrants() during a pending has() — next call observes empty', async () => {
    const g = await loadGrants();
    await g.addGrant('https://app.foo', 'personal_sign', ADDR_A);
    // has() 시작 → clear → 다음 has() 는 반드시 false.
    const pending = g.hasGrant('https://app.foo', 'personal_sign', ADDR_A);
    await g.clearAllGrants();
    const result = await pending;
    expect(typeof result).toBe('boolean');
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(false);
  });

  it('parallel addGrant() — at least one survives', async () => {
    const g = await loadGrants();
    await Promise.all([
      g.addGrant('https://app.foo', 'personal_sign', ADDR_A),
      g.addGrant('https://app.foo', 'eth_sendTransaction', ADDR_A),
      g.addGrant('https://app.bar', 'personal_sign', ADDR_A),
    ]);
    // chrome.storage 의 last-write-wins 위험 — 본 테스트는 "최소 한 키 생존" 만 보증.
    const active = await g.listActiveGrants();
    expect(active.length).toBeGreaterThanOrEqual(1);
  });
});

describe('grants: data corruption resistance', () => {
  it('hasGrant() returns false when stored value is not an object', async () => {
    const g = await loadGrants();
    SESSION['nd:method-grants'] = 'not-an-object';
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(false);
  });

  it('hasGrant() returns false when expiry is non-numeric', async () => {
    const g = await loadGrants();
    SESSION['nd:method-grants'] = {
      [`https://app.foo::personal_sign::${ADDR_A}`]: 'corrupted',
    };
    expect(await g.hasGrant('https://app.foo', 'personal_sign', ADDR_A)).toBe(false);
  });

  it('listActiveGrants() ignores malformed keys', async () => {
    const g = await loadGrants();
    const future = Date.now() + 60_000;
    SESSION['nd:method-grants'] = {
      // 잘못된 형식들 — 모두 걸러져야 한다.
      'malformed-no-separator': future,
      [`https://app.foo::unknown_method::${ADDR_A}`]: future,
      [`https://app.foo::personal_sign::not-a-real-address`]: future,
      // 정상 — 살아남아야 한다.
      [`https://app.foo::personal_sign::${ADDR_A}`]: future,
    };
    const active = await g.listActiveGrants();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      origin: 'https://app.foo',
      method: 'personal_sign',
      address: ADDR_A.toLowerCase(),
    });
  });
});
