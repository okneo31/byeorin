// ttlscan-tokens.test.ts — TTL Scan 발행 토큰 목록 로더.
// 전부 offline: fetch 를 주입한다.

import { describe, expect, it } from 'vitest';
import { fetchTtlScanTokens } from '../src/tokens/ttlscan.js';

function mockFetch(payload: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({ ok, status, json: async () => payload }) as unknown as Response) as unknown as typeof fetch;
}

const ROW = {
  address: '0xc00d0FF37e9CE83C269e762644202D4Ab82F023c',
  symbol: 'tUSD',
  name: 'TTL US Dollar Stable',
  decimals: 18,
};

describe('fetchTtlScanTokens', () => {
  it('정상 응답을 TokenInfo[] 로 변환한다', async () => {
    const out = await fetchTtlScanTokens({ fetch: mockFetch({ tokens: [ROW] }) });
    expect(out.length).toBe(1);
    expect(out[0]!.address).toBe(ROW.address);
    expect(out[0]!.symbol).toBe('tUSD');
    expect(out[0]!.decimals).toBe(18);
    // 코드에 박힌 빌트인이 아니라 밖에서 받아온 목록임을 표시한다.
    expect(out[0]!.custom).toBe(true);
  });

  it('주소가 EVM 형식이 아니면 버린다 — 레지스트리를 오염시키지 않는다', async () => {
    const bad = [
      { ...ROW, address: 'not-an-address' },
      { ...ROW, address: '0x123' },
      { ...ROW, address: undefined },
      ROW,
    ];
    const out = await fetchTtlScanTokens({ fetch: mockFetch({ tokens: bad }) });
    expect(out.length).toBe(1);
    expect(out[0]!.address).toBe(ROW.address);
  });

  it('decimals 가 정수가 아니면 버린다 — 추측해서 18 을 넣지 않는다', async () => {
    // 자릿수를 잘못 넣으면 잔액이 통째로 틀린 값이 된다. 버리는 편이 낫다.
    const bad = [
      { ...ROW, address: '0x1111111111111111111111111111111111111111', decimals: undefined },
      { ...ROW, address: '0x2222222222222222222222222222222222222222', decimals: 1.5 },
      { ...ROW, address: '0x3333333333333333333333333333333333333333', decimals: -1 },
      ROW,
    ];
    const out = await fetchTtlScanTokens({ fetch: mockFetch({ tokens: bad }) });
    expect(out.length).toBe(1);
    expect(out[0]!.decimals).toBe(18);
  });

  it('같은 주소가 여러 번 오면 하나만 남긴다', async () => {
    const dup = [ROW, { ...ROW, address: ROW.address.toLowerCase(), symbol: 'DUP' }];
    const out = await fetchTtlScanTokens({ fetch: mockFetch({ tokens: dup }) });
    expect(out.length).toBe(1);
    expect(out[0]!.symbol).toBe('tUSD');
  });

  it('HTTP 오류 / 형식 불일치 / 네트워크 실패는 던지지 않고 빈 배열', async () => {
    // 토큰 목록은 부가 정보다. 이것 때문에 지갑이 안 열리면 안 된다.
    expect(await fetchTtlScanTokens({ fetch: mockFetch({}, false, 500) })).toEqual([]);
    expect(await fetchTtlScanTokens({ fetch: mockFetch({ nope: 1 }) })).toEqual([]);
    expect(await fetchTtlScanTokens({ fetch: mockFetch({ tokens: 'x' }) })).toEqual([]);
    const boom = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await fetchTtlScanTokens({ fetch: boom })).toEqual([]);
  });

  it('limit 과 apiUrl 이 요청 URL 에 반영된다', async () => {
    let seen = '';
    const f = (async (url: string) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ tokens: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchTtlScanTokens({ fetch: f, apiUrl: 'https://example.test/api/', limit: 7 });
    expect(seen).toBe('https://example.test/api/tokens?limit=7');
  });

  it('타임아웃이 걸리면 빈 배열 — 첫 화면을 막지 않는다', async () => {
    const hang = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const out = await fetchTtlScanTokens({ fetch: hang, timeoutMs: 30 });
    expect(out).toEqual([]);
  });
});
