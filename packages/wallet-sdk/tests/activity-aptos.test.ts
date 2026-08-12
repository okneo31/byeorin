// activity-aptos.test.ts — Aptos 활동 소스. fetch 주입 모킹, 네트워크 X.
import { describe, expect, it } from 'vitest';
import {
  APTOS_ACTIVITY_REST,
  fetchAptosActivity,
} from '../src/activity/sources/aptos.js';

const ADDR =
  '0xbfef909638ef90885158fdab9f56e216fd811fe25b32ead0bc2a272d66522bb0';
const OTHER =
  '0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06';

/** fullnode user_transaction 1건 (실측 필드만: hash/version/success/timestamp/sender/payload). */
function tx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user_transaction',
    hash: '0x' + 'aa'.repeat(32),
    version: '100',
    success: true,
    timestamp: '1780511155096640', // 마이크로초 문자열 (실측 형식)
    sender: ADDR,
    payload: {
      type: 'entry_function_payload',
      function: '0x1::aptos_account::transfer',
      type_arguments: [],
      arguments: [OTHER, '12345'],
    },
    ...over,
  };
}

/** 고정 응답을 돌려주는 fetch. 요청 URL 을 기록한다. */
function fakeFetch(
  body: unknown,
  opts: { status?: number; urls?: string[] } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    opts.urls?.push(String(input));
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('fetchAptosActivity', () => {
  it('exposes the repo-standard fullnode REST base', () => {
    expect(APTOS_ACTIVITY_REST).toBe('https://fullnode.mainnet.aptoslabs.com/v1');
  });

  it('요청 URL: 주소는 64자 소문자 정규화, limit 반영, /v1 이하 경로', async () => {
    const urls: string[] = [];
    const r = await fetchAptosActivity({
      address: '0xA1', // 짧은 주소 + 대문자
      limit: 7,
      fetch: fakeFetch([], { urls }),
    });
    expect(r.ok).toBe(true);
    expect(urls).toEqual([
      `${APTOS_ACTIVITY_REST}/accounts/0x${'a1'.padStart(64, '0')}/transactions?limit=7`,
    ]);
  });

  it('native transfer 행: 수신자·octas 금액·APT 심볼·항상 out, 마이크로초→초 변환', async () => {
    const r = await fetchAptosActivity({ address: ADDR, fetch: fakeFetch([tx()]) });
    if (!r.ok) throw new Error(r.message);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.id).toBe('0x' + 'aa'.repeat(32));
    expect(row.blockNumber).toBe(100n);
    expect(row.status).toBe('success');
    expect(row.direction).toBe('out'); // fullnode 는 보낸 tx 만 준다
    expect(row.counterparty).toBe(OTHER);
    expect(row.amount).toBe(12345n);
    expect(row.symbol).toBe('APT');
    expect(row.timestamp).toBe(1780511155); // 1780511155096640 µs
    expect(r.omitted).toEqual(['memo']);
    expect(r.truncated).toBe(false); // 1건 < 기본 limit 20
  });

  it('오름차순 응답을 version 내림차순으로 재정렬한다 (실측: 서버는 오름차순)', async () => {
    const body = [
      tx({ hash: '0x' + '01'.repeat(32), version: '100' }),
      tx({ hash: '0x' + '02'.repeat(32), version: '200' }),
      tx({ hash: '0x' + '03'.repeat(32), version: '300' }),
    ];
    const r = await fetchAptosActivity({ address: ADDR, fetch: fakeFetch(body) });
    if (!r.ok) throw new Error(r.message);
    expect(r.rows.map((x) => x.blockNumber)).toEqual([300n, 200n, 100n]);
  });

  it('coin::transfer — APT type이면 native 금액, 다른 코인이면 금액을 지어내지 않는다', async () => {
    const apt = tx({
      hash: '0x' + '0a'.repeat(32),
      payload: {
        function: '0x1::coin::transfer',
        type_arguments: ['0x1::aptos_coin::AptosCoin'],
        arguments: [OTHER, '777'],
      },
    });
    const usdc = tx({
      hash: '0x' + '0b'.repeat(32),
      version: '99',
      payload: {
        function: '0x1::coin::transfer',
        type_arguments: ['0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC'],
        arguments: [OTHER, '999'],
      },
    });
    const r = await fetchAptosActivity({ address: ADDR, fetch: fakeFetch([apt, usdc]) });
    if (!r.ok) throw new Error(r.message);
    const [first, second] = [r.rows[0]!, r.rows[1]!];
    expect(first.amount).toBe(777n);
    expect(first.symbol).toBe('APT');
    // 다른 코인 금액을 octas 인 척 올리면 거짓 — amount/symbol 둘 다 undefined.
    expect(second.amount).toBeUndefined();
    expect(second.symbol).toBeUndefined();
    expect(second.counterparty).toBe(OTHER); // 수신자는 그대로 채운다
  });

  it('송금류가 아닌 payload 는 counterparty/amount 를 비워 둔다', async () => {
    const swap = tx({
      payload: {
        function: `${OTHER}::admin_apis::update_secondary_asset_oracle`,
        type_arguments: [],
        arguments: ['1', '2'],
      },
    });
    const r = await fetchAptosActivity({ address: ADDR, fetch: fakeFetch([swap]) });
    if (!r.ok) throw new Error(r.message);
    expect(r.rows[0]!.counterparty).toBeUndefined();
    expect(r.rows[0]!.amount).toBeUndefined();
  });

  it('success:false → failed, success 누락 → unknown, timestamp 누락 → undefined', async () => {
    const body = [
      tx({ hash: '0x' + '11'.repeat(32), success: false }),
      tx({ hash: '0x' + '22'.repeat(32), version: '99', success: undefined, timestamp: undefined }),
    ];
    const r = await fetchAptosActivity({ address: ADDR, fetch: fakeFetch(body) });
    if (!r.ok) throw new Error(r.message);
    expect(r.rows[0]!.status).toBe('failed');
    expect(r.rows[1]!.status).toBe('unknown');
    expect(r.rows[1]!.timestamp).toBeUndefined(); // 0 으로 지어내지 않는다
  });

  it('hash 없는 행은 버리고 나머지는 살린다', async () => {
    const r = await fetchAptosActivity({
      address: ADDR,
      fetch: fakeFetch([{ version: '1' }, tx()]),
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.rows).toHaveLength(1);
  });

  it('limit 만큼 꽉 차면 truncated:true', async () => {
    const body = [
      tx({ hash: '0x' + '31'.repeat(32), version: '1' }),
      tx({ hash: '0x' + '32'.repeat(32), version: '2' }),
    ];
    const r = await fetchAptosActivity({ address: ADDR, limit: 2, fetch: fakeFetch(body) });
    if (!r.ok) throw new Error(r.message);
    expect(r.truncated).toBe(true);
  });

  it('주소 형식 불일치 → unsupported (fetch 를 아예 부르지 않는다)', async () => {
    const urls: string[] = [];
    for (const bad of ['', 'apt1abc', '0x', '0x' + 'f'.repeat(65), 'r3AddR']) {
      const r = await fetchAptosActivity({ address: bad, fetch: fakeFetch([], { urls }) });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure).toBe('unsupported');
    }
    expect(urls).toHaveLength(0);
  });

  it('HTTP 4xx/5xx → network', async () => {
    const r = await fetchAptosActivity({
      address: ADDR,
      fetch: fakeFetch({ message: 'account not found', error_code: 'account_not_found' }, { status: 404 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('network');
  });

  it('fetch 거부 → network (throw 하지 않는다)', async () => {
    const rejecting = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await fetchAptosActivity({ address: ADDR, fetch: rejecting });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('network');
  });

  it('배열이 아닌 응답 → protocol', async () => {
    const r = await fetchAptosActivity({
      address: ADDR,
      fetch: fakeFetch({ not: 'an array' }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('protocol');
  });

  it('JSON 이 아닌 응답 → protocol', async () => {
    const html = (async () =>
      new Response('<html>webserver is functioning normally</html>', {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await fetchAptosActivity({ address: ADDR, fetch: html });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('protocol');
  });

  it('예산 초과 → timeout (AbortController 로 강제)', async () => {
    const hang = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const r = await fetchAptosActivity({ address: ADDR, timeoutMs: 20, fetch: hang });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('timeout');
  });

  it('endpoint override — 뒤 슬래시를 정리해서 쓴다', async () => {
    const urls: string[] = [];
    const r = await fetchAptosActivity({
      address: ADDR,
      endpoint: 'https://example.invalid/v1///',
      fetch: fakeFetch([], { urls }),
    });
    expect(r.ok).toBe(true);
    expect(urls[0]!.startsWith('https://example.invalid/v1/accounts/')).toBe(true);
  });
});
