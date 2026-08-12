// activity-xrp.test.ts — XRPL 활동 소스(account_tx) 테스트. fetch 주입 모킹, 네트워크 X.
// 실행: pnpm --filter @byeorin/wallet-sdk exec vitest run tests/activity-xrp

import { describe, expect, it } from 'vitest';
import {
  XRP_ACTIVITY_RPC,
  fetchXrpActivity,
} from '../src/activity/sources/xrp.js';

// 형식이 유효한 classic 주소들 (ripple base58 알파벳).
const SELF = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const OTHER = 'rLtCVnojydtQy7GYGTmDegkM15hLX8VuZk';

// ── 모의 fetch ────────────────────────────────────────────────────

interface Captured {
  url: string;
  body: unknown;
}

/** JSON 응답 1개를 재생하는 fetch. 요청을 captured 에 기록한다. */
function jsonFetch(payload: unknown, captured?: Captured[], status = 200): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    captured?.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

/** account_tx 성공 응답 골격. */
function accountTxResult(transactions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    result: {
      account: SELF,
      status: 'success',
      transactions,
      ...extra,
    },
  };
}

/** Payment 수신 1건 (drops 문자열 금액 + 메모 + Ripple epoch date). */
function paymentInEntry() {
  return {
    meta: { TransactionResult: 'tesSUCCESS' },
    validated: true,
    tx: {
      TransactionType: 'Payment',
      hash: 'B'.repeat(64),
      Account: OTHER,
      Destination: SELF,
      Amount: '1500000', // 1.5 XRP in drops
      date: 839820970, // Ripple epoch seconds
      ledger_index: 106235523,
      Memos: [{ Memo: { MemoData: '48656C6C6F' } }], // "Hello"
    },
  };
}

// ── 주소 사전검증 ────────────────────────────────────────────────

describe('fetchXrpActivity — 주소 사전검증', () => {
  it('classic 주소 형식이 아니면 unsupported, fetch 를 부르지 않는다', async () => {
    let called = 0;
    const f = (async () => {
      called++;
      return new Response('{}');
    }) as typeof fetch;
    for (const bad of ['', '0x1234', 'sEdV19...', 'r0OIl', 'X7AcgcsBL6XDcUb289X4', SELF + 'aaaaaaaaaaaaaaaa']) {
      const r = await fetchXrpActivity({ address: bad, fetch: f });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure).toBe('unsupported');
    }
    expect(called).toBe(0);
  });
});

// ── 요청 형태 ────────────────────────────────────────────────────

describe('fetchXrpActivity — 요청', () => {
  it('account_tx 를 forward:false·전 구간으로 부르고 limit 기본은 20', async () => {
    const captured: Captured[] = [];
    const r = await fetchXrpActivity({ address: SELF, fetch: jsonFetch(accountTxResult([]), captured) });
    expect(r.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(XRP_ACTIVITY_RPC);
    const body = captured[0]!.body as { method: string; params: Array<Record<string, unknown>> };
    expect(body.method).toBe('account_tx');
    expect(body.params[0]).toMatchObject({
      account: SELF,
      limit: 20,
      ledger_index_min: -1,
      ledger_index_max: -1,
      forward: false,
    });
  });

  it('endpoint override 와 limit 을 그대로 쓴다', async () => {
    const captured: Captured[] = [];
    await fetchXrpActivity({
      address: SELF,
      limit: 5,
      endpoint: 'https://example.invalid/rpc',
      fetch: jsonFetch(accountTxResult([]), captured),
    });
    expect(captured[0]!.url).toBe('https://example.invalid/rpc');
    expect((captured[0]!.body as { params: Array<{ limit: number }> }).params[0]!.limit).toBe(5);
  });
});

// ── 행 파싱 ──────────────────────────────────────────────────────

describe('fetchXrpActivity — 행 파싱', () => {
  it('Payment 수신: 금액·방향·상대·메모·epoch 보정까지 계약형으로', async () => {
    const r = await fetchXrpActivity({
      address: SELF,
      fetch: jsonFetch(accountTxResult([paymentInEntry()])),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.id).toBe('B'.repeat(64));
    expect(row.timestamp).toBe(839820970 + 946_684_800); // Ripple → UNIX
    expect(row.blockNumber).toBe(106235523n);
    expect(row.status).toBe('success');
    expect(row.direction).toBe('in');
    expect(row.counterparty).toBe(OTHER);
    expect(row.amount).toBe(1_500_000n);
    expect(row.symbol).toBe('XRP');
    expect(row.memo).toBe('Hello');
    expect(r.omitted).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('발신 Payment 는 out + 상대 = Destination, IOU(객체 Amount)는 금액 undefined', async () => {
    const entry = {
      meta: { TransactionResult: 'tesSUCCESS' },
      validated: true,
      tx: {
        TransactionType: 'Payment',
        hash: 'C'.repeat(64),
        Account: SELF,
        Destination: OTHER,
        Amount: { currency: 'USD', issuer: OTHER, value: '10' },
        date: 1000,
        ledger_index: 7,
      },
    };
    const r = await fetchXrpActivity({ address: SELF, fetch: jsonFetch(accountTxResult([entry])) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.rows[0]!;
    expect(row.direction).toBe('out');
    expect(row.counterparty).toBe(OTHER);
    expect(row.amount).toBeUndefined();
    expect(row.symbol).toBeUndefined(); // amount 없으면 symbol 도 없다.
  });

  it('자기 자신 송금은 self, DeliverMax(api_version 2 이름)도 drops 로 읽는다', async () => {
    const entry = {
      meta: { TransactionResult: 'tesSUCCESS' },
      validated: true,
      tx_json: {
        TransactionType: 'Payment',
        hash: 'D'.repeat(64),
        Account: SELF,
        Destination: SELF,
        DeliverMax: '42',
        date: 0,
        ledger_index: 1,
      },
    };
    const r = await fetchXrpActivity({ address: SELF, fetch: jsonFetch(accountTxResult([entry])) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]!.direction).toBe('self');
    expect(r.rows[0]!.amount).toBe(42n);
  });

  it('tec 코드는 failed, meta 없으면 unknown, hash 없는 행은 버린다', async () => {
    const entries = [
      {
        meta: { TransactionResult: 'tecUNFUNDED_PAYMENT' },
        tx: { hash: 'E'.repeat(64), Account: SELF, ledger_index: 3 },
      },
      { tx: { hash: 'F'.repeat(64), Account: SELF, ledger_index: 2 } }, // meta 없음
      { meta: { TransactionResult: 'tesSUCCESS' }, tx: { Account: SELF } }, // hash 없음 → 버림
    ];
    const r = await fetchXrpActivity({ address: SELF, fetch: jsonFetch(accountTxResult(entries)) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.status).toBe('failed');
    expect(r.rows[1]!.status).toBe('unknown');
  });

  it('OfferCreate(비-Payment): date 없으면 timestamp undefined, 방향은 out, 금액 없음', async () => {
    const entry = {
      meta: { TransactionResult: 'tesSUCCESS' },
      validated: true,
      tx: {
        TransactionType: 'OfferCreate',
        hash: '0AAAC05113FBDC9FC96DBFF6CFB762358B3A1CC98925452D0B3D083169D1BF36',
        Account: SELF,
        ledger_index: 106235523,
      },
    };
    const r = await fetchXrpActivity({ address: SELF, fetch: jsonFetch(accountTxResult([entry])) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.rows[0]!;
    expect(row.timestamp).toBeUndefined(); // 0 으로 지어내지 않는다.
    expect(row.direction).toBe('out');
    expect(row.counterparty).toBeUndefined();
    expect(row.amount).toBeUndefined();
  });

  it('UTF-8 이 아닌 메모는 undefined (깨진 글자를 지어내지 않는다)', async () => {
    const entry = paymentInEntry();
    entry.tx.Memos = [{ Memo: { MemoData: 'FFFE00' } }];
    const r = await fetchXrpActivity({ address: SELF, fetch: jsonFetch(accountTxResult([entry])) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]!.memo).toBeUndefined();
  });

  it('최신이 앞: ledger 내림차순, 동률은 id 사전순 + marker 있으면 truncated', async () => {
    const mk = (hash: string, ledger: number) => ({
      meta: { TransactionResult: 'tesSUCCESS' },
      tx: { hash, Account: SELF, ledger_index: ledger },
    });
    const r = await fetchXrpActivity({
      address: SELF,
      fetch: jsonFetch(
        accountTxResult(
          [mk('AA', 10), mk('CC', 20), mk('BB', 20)],
          { marker: { ledger: 10, seq: 1 } },
        ),
      ),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.id)).toEqual(['BB', 'CC', 'AA']);
    expect(r.truncated).toBe(true);
  });
});

// ── 실패 분류 ────────────────────────────────────────────────────

describe('fetchXrpActivity — 실패는 값', () => {
  it('actNotFound 는 오류가 아니라 빈 이력이다', async () => {
    const r = await fetchXrpActivity({
      address: SELF,
      fetch: jsonFetch({ result: { status: 'error', error: 'actNotFound' } }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('rippled error 응답 → server', async () => {
    const r = await fetchXrpActivity({
      address: SELF,
      fetch: jsonFetch({ result: { status: 'error', error: 'tooBusy', error_message: 'The server is too busy.' } }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toBe('server');
    expect(r.message).toContain('too busy');
  });

  it('HTTP 4xx/5xx → network', async () => {
    const r = await fetchXrpActivity({ address: SELF, fetch: jsonFetch({}, undefined, 503) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toBe('network');
    expect(r.message).toContain('503');
  });

  it('fetch 거부 → network', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const r = await fetchXrpActivity({ address: SELF, fetch: f });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toBe('network');
  });

  it('timeoutMs 초과 → timeout (AbortController 로 끊는다)', async () => {
    const f = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })) as typeof fetch;
    const r = await fetchXrpActivity({ address: SELF, timeoutMs: 20, fetch: f });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toBe('timeout');
  });

  it('JSON 이 아닌 본문 → protocol', async () => {
    const f = (async () => new Response('<html>proxy error</html>', { status: 200 })) as typeof fetch;
    const r = await fetchXrpActivity({ address: SELF, fetch: f });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toBe('protocol');
  });

  it('result 형태 불일치(transactions 비배열) → protocol', async () => {
    const r = await fetchXrpActivity({
      address: SELF,
      fetch: jsonFetch({ result: { status: 'success', transactions: 'nope' } }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toBe('protocol');
  });

  it('result 자체가 없음 → protocol', async () => {
    const r = await fetchXrpActivity({ address: SELF, fetch: jsonFetch({}) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toBe('protocol');
  });

  it('어떤 실패도 throw 로 새지 않는다', async () => {
    const f = (async () => new Response(JSON.stringify({ result: { status: 'success', transactions: [null, 1, {}] } }))) as typeof fetch;
    const r = await fetchXrpActivity({ address: SELF, fetch: f });
    expect(r.ok).toBe(true); // 쓸 수 없는 행은 버리고 나머지로 답한다.
    if (!r.ok) return;
    expect(r.rows).toEqual([]);
  });
});
