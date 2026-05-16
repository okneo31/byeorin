// prices.test.ts — CoinGeckoPriceClient (60s 캐시 + 동시요청 dedupe).
// 모두 offline: fetch 와 시간을 mock 한다.

import { describe, expect, it, vi } from 'vitest';
import { CoinGeckoPriceClient } from '../src/index.js';

function mockJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function mockFail(): Response {
  return {
    ok: false,
    status: 500,
    json: async () => ({}),
  } as unknown as Response;
}

describe('CoinGeckoPriceClient', () => {
  it('정상 응답을 number 로 반환', async () => {
    const fetchImpl = vi.fn(async () => mockJson({ 'usd-coin': { usd: 1.0 } }));
    const client = new CoinGeckoPriceClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const p = await client.getPrice('usd-coin');
    expect(p).toBe(1.0);
  });

  it('빈 id 는 즉시 null + network 호출 없음', async () => {
    const fetchImpl = vi.fn();
    const client = new CoinGeckoPriceClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.getPrice('')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('60초 캐시 — 두 번째 호출은 fetch 안 함', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => mockJson({ ttl: { usd: 0.5 } }));
    const client = new CoinGeckoPriceClient({
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    expect(await client.getPrice('ttl')).toBe(0.5);
    now += 30_000;
    expect(await client.getPrice('ttl')).toBe(0.5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('60초 후엔 다시 fetch', async () => {
    let now = 1_000_000;
    const responses = [0.5, 0.7];
    let i = 0;
    const fetchImpl = vi.fn(async () =>
      mockJson({ ttl: { usd: responses[i++] } }),
    );
    const client = new CoinGeckoPriceClient({
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    expect(await client.getPrice('ttl')).toBe(0.5);
    now += 61_000;
    expect(await client.getPrice('ttl')).toBe(0.7);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('동시 호출은 dedupe 된다', async () => {
    const fetchImpl = vi.fn(
      () => new Promise<Response>((r) => setTimeout(() => r(mockJson({ x: { usd: 9 } })), 10)),
    );
    const client = new CoinGeckoPriceClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const [a, b, c] = await Promise.all([
      client.getPrice('x'),
      client.getPrice('x'),
      client.getPrice('x'),
    ]);
    expect(a).toBe(9);
    expect(b).toBe(9);
    expect(c).toBe(9);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 실패 → null (예외 안 던짐)', async () => {
    const fetchImpl = vi.fn(async () => mockFail());
    const client = new CoinGeckoPriceClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.getPrice('weird-coin')).toBeNull();
  });

  it('응답에 해당 id 가 없으면 null', async () => {
    const fetchImpl = vi.fn(async () => mockJson({}));
    const client = new CoinGeckoPriceClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.getPrice('nonexistent')).toBeNull();
  });
});
