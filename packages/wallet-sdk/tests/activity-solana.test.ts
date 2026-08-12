// activity-solana.test.ts — 솔라나 활동 소스 (activity/sources/solana) 테스트.
// 실행: pnpm --filter @byeorin/wallet-sdk exec vitest run tests/activity-solana
// 네트워크 금지 — fetch 는 전부 주입 목이다.

import { describe, expect, it } from 'vitest';
import {
  SOLANA_ACTIVITY_RPC,
  fetchSolanaActivity,
} from '../src/activity/sources/solana.js';

// ── 모의 fetch ─────────────────────────────────────────────────────

const GOOD_ADDR = 'Vote111111111111111111111111111111111111111';

interface Captured {
  url: string;
  init: RequestInit;
  body: { method: string; params: [string, { limit: number }] };
}

/** 고정 JSON 을 돌려주는 fetch 목. 요청을 captured 에 기록한다. */
function mockFetch(
  payload: unknown,
  captured: Captured[] = [],
  status = 200,
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    captured.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as Captured['body'],
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as Response;
  }) as typeof fetch;
}

function sigEntry(partial: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    signature: 'sigDEFAULT',
    slot: 100,
    err: null,
    blockTime: 1_700_000_000,
    memo: null,
    confirmationStatus: 'finalized',
    ...partial,
  };
}

// ── 성공 경로 ──────────────────────────────────────────────────────

describe('fetchSolanaActivity — 성공', () => {
  it('서명 목록을 행으로 사상한다 (필드·순서·omitted)', async () => {
    const captured: Captured[] = [];
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      result: [
        sigEntry({ signature: 'sigOld', slot: 90, blockTime: 1_699_000_000 }),
        sigEntry({ signature: 'sigNew', slot: 120, err: { InstructionError: [0, 'Custom'] }, memo: '[5] hello' }),
      ],
    };
    const r = await fetchSolanaActivity({ address: GOOD_ADDR, fetch: mockFetch(payload, captured) });

    // 요청 형태: 기본 엔드포인트 + 읽기 메서드 + 기본 limit 20.
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(SOLANA_ACTIVITY_RPC);
    expect(captured[0].body.method).toBe('getSignaturesForAddress');
    expect(captured[0].body.params[0]).toBe(GOOD_ADDR);
    expect(captured[0].body.params[1].limit).toBe(20);

    if (!r.ok) throw new Error(`expected ok, got ${r.failure}: ${r.message}`);
    expect(r.chain).toBe('solana');
    // slot 내림차순 — 최신이 앞.
    expect(r.rows.map((x) => x.id)).toEqual(['sigNew', 'sigOld']);

    const [failed, success] = r.rows;
    expect(failed.status).toBe('failed'); // err 객체 = 실패
    expect(failed.blockNumber).toBe(120n);
    expect(failed.memo).toBe('[5] hello');
    expect(success.status).toBe('success'); // err null = 성공
    expect(success.timestamp).toBe(1_699_000_000);
    expect(success.memo).toBeUndefined(); // memo null → 필드 없음

    // 서명 목록은 방향·상대·금액을 구조적으로 못 준다.
    expect([...r.omitted].sort()).toEqual(['amount', 'counterparty', 'direction']);
    for (const row of r.rows) {
      expect(row.amount).toBeUndefined();
      expect(row.symbol).toBeUndefined();
      expect(row.direction).toBeUndefined();
      expect(row.counterparty).toBeUndefined();
    }
    // 2건 < limit 20 → 잘리지 않음.
    expect(r.truncated).toBe(false);
  });

  it('blockTime null → timestamp undefined (0 으로 지어내지 않음)', async () => {
    const payload = { result: [sigEntry({ blockTime: null })] };
    const r = await fetchSolanaActivity({ address: GOOD_ADDR, fetch: mockFetch(payload) });
    if (!r.ok) throw new Error(r.message);
    expect(r.rows[0].timestamp).toBeUndefined();
  });

  it('err 필드 자체가 없으면 status unknown', async () => {
    const entry = sigEntry({});
    delete entry.err;
    const r = await fetchSolanaActivity({ address: GOOD_ADDR, fetch: mockFetch({ result: [entry] }) });
    if (!r.ok) throw new Error(r.message);
    expect(r.rows[0].status).toBe('unknown');
  });

  it('slot 동률은 id 사전순 tie-break, limit 만큼 차면 truncated', async () => {
    const captured: Captured[] = [];
    const payload = {
      result: [
        sigEntry({ signature: 'zzz', slot: 50 }),
        sigEntry({ signature: 'aaa', slot: 50 }),
      ],
    };
    const r = await fetchSolanaActivity({
      address: GOOD_ADDR,
      limit: 2,
      fetch: mockFetch(payload, captured),
    });
    expect(captured[0].body.params[1].limit).toBe(2);
    if (!r.ok) throw new Error(r.message);
    expect(r.rows.map((x) => x.id)).toEqual(['aaa', 'zzz']);
    expect(r.truncated).toBe(true); // 2건 == limit 2
  });

  it('endpoint override 를 그대로 쓴다', async () => {
    const captured: Captured[] = [];
    const r = await fetchSolanaActivity({
      address: GOOD_ADDR,
      endpoint: 'https://example.invalid/rpc',
      fetch: mockFetch({ result: [] }, captured),
    });
    expect(captured[0].url).toBe('https://example.invalid/rpc');
    if (!r.ok) throw new Error(r.message);
    expect(r.rows).toEqual([]);
  });
});

// ── 실패 경로 (전부 값 — throw 금지) ───────────────────────────────

describe('fetchSolanaActivity — 실패는 값', () => {
  it('주소 형식 불일치 → unsupported, fetch 호출 없음', async () => {
    const captured: Captured[] = [];
    const r = await fetchSolanaActivity({
      address: '0xDEADBEEF', // EVM 주소 — base58 아님
      fetch: mockFetch({ result: [] }, captured),
    });
    expect(r).toMatchObject({ ok: false, chain: 'solana', failure: 'unsupported' });
    expect(captured).toHaveLength(0);
  });

  it('HTTP 4xx/5xx → network', async () => {
    const r = await fetchSolanaActivity({
      address: GOOD_ADDR,
      fetch: mockFetch({ result: [] }, [], 503),
    });
    expect(r).toMatchObject({ ok: false, failure: 'network', message: 'HTTP 503' });
  });

  it('fetch 거부(연결 실패) → network', async () => {
    const rejecting = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await fetchSolanaActivity({ address: GOOD_ADDR, fetch: rejecting });
    expect(r).toMatchObject({ ok: false, failure: 'network' });
  });

  it('timeoutMs 초과 → timeout (AbortController)', async () => {
    // signal 이 abort 될 때까지 영원히 안 끝나는 fetch.
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const r = await fetchSolanaActivity({ address: GOOD_ADDR, timeoutMs: 20, fetch: hanging });
    expect(r).toMatchObject({ ok: false, failure: 'timeout' });
  });

  it('RPC error 객체 → server', async () => {
    const payload = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param' } };
    const r = await fetchSolanaActivity({ address: GOOD_ADDR, fetch: mockFetch(payload) });
    expect(r).toMatchObject({ ok: false, failure: 'server' });
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('-32602');
  });

  it('result 가 배열이 아님 → protocol', async () => {
    const r = await fetchSolanaActivity({
      address: GOOD_ADDR,
      fetch: mockFetch({ result: 'nope' }),
    });
    expect(r).toMatchObject({ ok: false, failure: 'protocol' });
  });

  it('원소에 signature 없음 → protocol', async () => {
    const entry = sigEntry({});
    delete entry.signature;
    const r = await fetchSolanaActivity({ address: GOOD_ADDR, fetch: mockFetch({ result: [entry] }) });
    expect(r).toMatchObject({ ok: false, failure: 'protocol' });
  });

  it('본문이 JSON 이 아님 → protocol', async () => {
    const badJson = (async () =>
      ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) as unknown as Response
    ) as unknown as typeof fetch;
    const r = await fetchSolanaActivity({ address: GOOD_ADDR, fetch: badJson });
    expect(r).toMatchObject({ ok: false, failure: 'protocol' });
  });
});
