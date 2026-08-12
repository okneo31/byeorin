// activity-sui.test.ts — Sui 활동 소스. 전부 offline: fetch 를 주입해 모킹한다.

import { describe, expect, it, vi } from 'vitest';
import {
  SUI_ACTIVITY_RPC,
  fetchSuiActivity,
} from '../src/activity/sources/sui.js';

const SELF = '0x' + 'a'.repeat(64);
const OTHER = '0x' + 'b'.repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function rpcResult(data: unknown[], hasNextPage = false): unknown {
  return { jsonrpc: '2.0', id: 1, result: { data, hasNextPage } };
}

/** fetch body 의 filter(FromAddress/ToAddress)를 보고 응답을 고르는 mock. */
function fetchByFilter(pages: {
  from: unknown;
  to: unknown;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: [{ filter: Record<string, string> }, ...unknown[]];
    };
    expect(body.method).toBe('suix_queryTransactionBlocks');
    const filter = body.params[0].filter;
    if ('FromAddress' in filter) return jsonResponse(pages.from);
    return jsonResponse(pages.to);
  });
}

function tx(over: Record<string, unknown>): unknown {
  return {
    digest: 'D',
    timestampMs: '1700000000000',
    checkpoint: '123',
    effects: { status: { status: 'success' } },
    balanceChanges: [],
    ...over,
  };
}

describe('fetchSuiActivity', () => {
  it('From/To 2왕복 병합 — direction·amount·counterparty·정렬', async () => {
    const outTx = tx({
      digest: 'DigestOut1',
      timestampMs: '1700000200000',
      checkpoint: '200',
      balanceChanges: [
        { owner: { AddressOwner: SELF }, coinType: '0x2::sui::SUI', amount: '-1000000' },
        { owner: { AddressOwner: OTHER }, coinType: '0x2::sui::SUI', amount: '900000' },
      ],
    });
    const selfTx = tx({
      digest: 'DigestSelf',
      timestampMs: '1700000100000',
      checkpoint: '150',
    });
    const inTx = tx({
      digest: 'DigestIn1',
      timestampMs: null, // 서버가 못 주면 undefined 로 남아야 한다.
      checkpoint: null,
      effects: { status: { status: 'failure' } },
      balanceChanges: [
        { owner: { AddressOwner: SELF }, coinType: '0x2::sui::SUI', amount: '500' },
      ],
    });
    const fetchImpl = fetchByFilter({
      from: rpcResult([outTx, selfTx]),
      to: rpcResult([selfTx, inTx]),
    });

    const r = await fetchSuiActivity({
      address: SELF,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetchImpl).toHaveBeenCalledTimes(2); // From 1회 + To 1회.
    expect(r.chain).toBe('sui');
    expect(r.omitted).toEqual(['memo']); // Sui 에는 메모 필드가 없다.
    expect(r.truncated).toBe(false);

    // 최신(timestamp 큰 것)이 앞. timestamp 없는 행은 뒤.
    expect(r.rows.map((row) => row.id)).toEqual([
      'DigestOut1',
      'DigestSelf',
      'DigestIn1',
    ]);

    const [out, self, incoming] = r.rows;
    expect(out!.direction).toBe('out');
    expect(out!.amount).toBe(1000000n); // self SUI 변화 -1000000 의 절대값.
    expect(out!.symbol).toBe('SUI');
    expect(out!.counterparty).toBe(OTHER);
    expect(out!.timestamp).toBe(1700000200);
    expect(out!.blockNumber).toBe(200n);
    expect(out!.status).toBe('success');

    expect(self!.direction).toBe('self'); // 양쪽 filter 모두에 나온 digest.
    expect(self!.amount).toBeUndefined(); // balanceChanges 에 SUI 변화 없음.
    expect(self!.symbol).toBeUndefined();

    expect(incoming!.direction).toBe('in');
    expect(incoming!.status).toBe('failed');
    expect(incoming!.amount).toBe(500n);
    expect(incoming!.timestamp).toBeUndefined(); // null → 지어내지 않는다.
    expect(incoming!.blockNumber).toBeUndefined();
  });

  it('long-form coinType(0x000…002::sui::SUI)과 짧은 주소도 정규화해 비교', async () => {
    const longSui = '0x' + '0'.repeat(63) + '2' + '::sui::SUI';
    const fetchImpl = fetchByFilter({
      from: rpcResult([
        tx({
          digest: 'DigestLong',
          balanceChanges: [
            { owner: { AddressOwner: SELF.toUpperCase().replace('0X', '0x') }, coinType: longSui, amount: '-77' },
          ],
        }),
      ]),
      to: rpcResult([]),
    });
    const r = await fetchSuiActivity({
      address: SELF,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]!.amount).toBe(77n);
  });

  it('limit 초과 병합분은 잘라내고 truncated=true', async () => {
    const fetchImpl = fetchByFilter({
      from: rpcResult([
        tx({ digest: 'A', timestampMs: '3000' }),
        tx({ digest: 'B', timestampMs: '2000' }),
      ]),
      to: rpcResult([tx({ digest: 'C', timestampMs: '1000' })]),
    });
    const r = await fetchSuiActivity({
      address: SELF,
      limit: 2,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('hasNextPage=true 면 행이 적어도 truncated=true', async () => {
    const fetchImpl = fetchByFilter({
      from: rpcResult([tx({ digest: 'A' })], true),
      to: rpcResult([]),
    });
    const r = await fetchSuiActivity({
      address: SELF,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
  });

  it('주소 형식 아님 → unsupported + fetch 호출 없음', async () => {
    const fetchImpl = vi.fn();
    const r = await fetchSuiActivity({
      address: 'not-a-sui-address',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, chain: 'sui', failure: 'unsupported' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP 500 → network', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const r = await fetchSuiActivity({
      address: SELF,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, failure: 'network' });
  });

  it('fetch 거부(비-abort) → network, throw 하지 않음', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await fetchSuiActivity({
      address: SELF,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, failure: 'network' });
  });

  it('RPC error 객체 → server', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Invalid params' },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const r = await fetchSuiActivity({
      address: SELF,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, failure: 'server' });
    if (!r.ok) expect(r.message).toContain('Invalid params');
  });

  it('result.data 배열 없음 → protocol', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    const r = await fetchSuiActivity({
      address: SELF,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, failure: 'protocol' });
  });

  it('예산 초과 — AbortController abort → timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const r = await fetchSuiActivity({
      address: SELF,
      timeoutMs: 20,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, failure: 'timeout' });
  });

  it('digest 없는 항목은 행으로 만들지 않는다 (식별 불가)', async () => {
    const fetchImpl = fetchByFilter({
      from: rpcResult([{ timestampMs: '1000' }, tx({ digest: 'OK' })]),
      to: rpcResult([]),
    });
    const r = await fetchSuiActivity({
      address: SELF,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((row) => row.id)).toEqual(['OK']);
  });

  it('기본 엔드포인트는 publicnode — endpoint override 반영', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return jsonResponse(rpcResult([]));
    });
    await fetchSuiActivity({
      address: SELF,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await fetchSuiActivity({
      address: SELF,
      endpoint: 'https://example.invalid/rpc',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(seen.slice(0, 2)).toEqual([SUI_ACTIVITY_RPC, SUI_ACTIVITY_RPC]);
    expect(seen.slice(2)).toEqual([
      'https://example.invalid/rpc',
      'https://example.invalid/rpc',
    ]);
  });
});
