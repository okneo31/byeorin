// activity-zion.test.ts — cosmos:zion 활동 소스 (LCD 양방향 병합).
// 모두 offline: ActivityQuery.fetch 주입으로 LCD 를 흉내 낸다. 네트워크 X.
//
// 응답 표본은 2026-08-12 lcd.zion1.top 실측 형태를 따른다
// (tx_responses[].{txhash,height,timestamp,code,tx.body.{memo,messages}}).

import { describe, expect, it } from 'vitest';
import {
  fetchCosmosActivity,
  ZION_ACTIVITY_LCD,
} from '../src/activity/sources/zion.js';

// 실측 응답에 나온 실존 형태의 주소들.
const SELF = 'zion1yp64nwygmxev2aej2ejsv6ywg4wy4jyqgaddfn';
const OTHER = 'zion1003khmp97tya4x5nsf3rxtn4my5rg4hm7wgthc';

const MSG_SEND = '/cosmos.bank.v1beta1.MsgSend';

interface TxLike {
  txhash: string;
  height?: string;
  timestamp?: string;
  code?: number;
  tx?: {
    body?: {
      memo?: string;
      messages?: Array<Record<string, unknown>>;
    };
  };
}

function send(
  txhash: string,
  height: string,
  opts: {
    from?: string;
    to?: string;
    denom?: string;
    amount?: string;
    code?: number;
    memo?: string;
    timestamp?: string;
  } = {},
): TxLike {
  return {
    txhash,
    height,
    timestamp: opts.timestamp ?? '2026-07-22T01:34:32Z',
    code: opts.code ?? 0,
    tx: {
      body: {
        memo: opts.memo ?? '',
        messages: [
          {
            '@type': MSG_SEND,
            from_address: opts.from ?? SELF,
            to_address: opts.to ?? OTHER,
            amount: [{ denom: opts.denom ?? 'utrg', amount: opts.amount ?? '1000000' }],
          },
        ],
      },
    },
  };
}

/** URL 의 query= 조건에 따라 sender/recipient 응답을 나눠 주는 가짜 LCD. */
function mockLcd(sender: TxLike[], recipient: TxLike[], seen?: string[]): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    seen?.push(url);
    const body = url.includes(encodeURIComponent('message.sender'))
      ? { txs: [], tx_responses: sender, pagination: null, total: String(sender.length) }
      : { txs: [], tx_responses: recipient, pagination: null, total: String(recipient.length) };
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('fetchCosmosActivity — 주소 검증', () => {
  it('EVM 주소는 unsupported, fetch 를 부르지 않는다', async () => {
    let called = 0;
    const r = await fetchCosmosActivity({
      address: '0x1111111111111111111111111111111111111111',
      fetch: (async () => {
        called += 1;
        throw new Error('불려선 안 됨');
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('unsupported');
    expect(called).toBe(0);
  });

  it('bech32 문자셋 위반(b/i/o/1 포함)도 unsupported', async () => {
    const r = await fetchCosmosActivity({ address: 'zion1bio1bio1bio1bio1bio1bio1bio1bio1bio1bi' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('unsupported');
  });
});

describe('fetchCosmosActivity — 요청 형태', () => {
  it('query= 파라미터로 sender/recipient 2왕복 (events= 아님 — v0.50 실측)', async () => {
    const seen: string[] = [];
    const r = await fetchCosmosActivity({ address: SELF, fetch: mockLcd([], [], seen) });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
    for (const url of seen) {
      expect(url.startsWith(`${ZION_ACTIVITY_LCD}/cosmos/tx/v1beta1/txs?query=`)).toBe(true);
      expect(url).not.toContain('events=');
      expect(url).toContain('order_by=ORDER_BY_DESC');
    }
    expect(seen[0]).toContain(encodeURIComponent(`message.sender='${SELF}'`));
    expect(seen[1]).toContain(encodeURIComponent(`transfer.recipient='${SELF}'`));
  });

  it('endpoint override 를 쓴다', async () => {
    const seen: string[] = [];
    await fetchCosmosActivity({
      address: SELF,
      endpoint: 'https://example.invalid',
      fetch: mockLcd([], [], seen),
    });
    expect(seen[0]!.startsWith('https://example.invalid/cosmos/tx/v1beta1/txs?')).toBe(true);
  });
});

describe('fetchCosmosActivity — 병합·정렬·행 변환', () => {
  it('txhash 중복제거 + height 내림차순 + MsgSend 방향/금액/메모', async () => {
    const sent = [
      send('AAA', '100', { from: SELF, to: OTHER, amount: '2500000', memo: 'to friend' }),
      send('BBB', '90', { from: SELF, to: OTHER }),
    ];
    const received = [
      send('BBB', '90', { from: SELF, to: OTHER }), // 양쪽 쿼리에 다 잡힌 중복
      send('CCC', '120', { from: OTHER, to: SELF, amount: '7' }),
    ];
    const r = await fetchCosmosActivity({ address: SELF, fetch: mockLcd(sent, received) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.id)).toEqual(['CCC', 'AAA', 'BBB']);
    expect(r.omitted).toEqual([]);
    expect(r.truncated).toBe(false);

    const ccc = r.rows[0]!;
    expect(ccc.direction).toBe('in');
    expect(ccc.counterparty).toBe(OTHER);
    expect(ccc.amount).toBe(7n);
    expect(ccc.symbol).toBe('kWR');
    expect(ccc.blockNumber).toBe(120n);
    expect(ccc.status).toBe('success');
    // 2026-07-22T01:34:32Z (실측 표본)
    expect(ccc.timestamp).toBe(Math.floor(Date.parse('2026-07-22T01:34:32Z') / 1000));

    const aaa = r.rows[1]!;
    expect(aaa.direction).toBe('out');
    expect(aaa.counterparty).toBe(OTHER);
    expect(aaa.amount).toBe(2500000n);
    expect(aaa.memo).toBe('to friend');
  });

  it('같은 height 는 id 사전순 tie-break', async () => {
    const r = await fetchCosmosActivity({
      address: SELF,
      fetch: mockLcd([send('ZZZ', '50'), send('AAA', '50')], []),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows.map((x) => x.id)).toEqual(['AAA', 'ZZZ']);
  });

  it('자기 자신에게 보내면 direction=self, counterparty 없음', async () => {
    const tx = send('SSS', '10', { from: SELF, to: SELF });
    const r = await fetchCosmosActivity({ address: SELF, fetch: mockLcd([tx], [tx]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.direction).toBe('self');
    expect(r.rows[0]!.counterparty).toBeUndefined();
  });

  it('utrg 아닌 denom(upi 실측 존재)은 amount/symbol 을 지어내지 않는다', async () => {
    const r = await fetchCosmosActivity({
      address: SELF,
      fetch: mockLcd([send('UPI', '10', { denom: 'upi', amount: '500005147000000' })], []),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]!.amount).toBeUndefined();
    expect(r.rows[0]!.symbol).toBeUndefined();
    expect(r.rows[0]!.direction).toBe('out'); // 방향은 여전히 판정 가능
  });

  it('커스텀 메시지(MsgSwap)는 direction/counterparty/amount 전부 undefined', async () => {
    const tx: TxLike = {
      txhash: 'SWAP',
      height: '30',
      timestamp: '2026-08-01T00:00:00Z',
      code: 1, // 실패한 tx
      tx: { body: { memo: '', messages: [{ '@type': '/zion.amm.v1.MsgSwap' }] } },
    };
    const r = await fetchCosmosActivity({ address: SELF, fetch: mockLcd([tx], []) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.rows[0]!;
    expect(row.status).toBe('failed');
    expect(row.direction).toBeUndefined();
    expect(row.counterparty).toBeUndefined();
    expect(row.amount).toBeUndefined();
    expect(row.memo).toBeUndefined();
  });

  it('code 필드가 없으면 status=unknown (0 으로 지어내지 않는다)', async () => {
    const tx: TxLike = { txhash: 'NOC', height: '5' };
    delete (tx as Record<string, unknown>).code;
    const r = await fetchCosmosActivity({ address: SELF, fetch: mockLcd([tx], []) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0]!.status).toBe('unknown');
  });

  it('timestamp 파싱 불가면 undefined', async () => {
    const r = await fetchCosmosActivity({
      address: SELF,
      fetch: mockLcd([send('BAD', '5', { timestamp: '시각 아님' })], []),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0]!.timestamp).toBeUndefined();
  });

  it('LCD 가 pagination.limit 을 무시해도(실측) 클라이언트에서 절단한다', async () => {
    const sent = [send('A1', '3'), send('A2', '2'), send('A3', '1')];
    const r = await fetchCosmosActivity({ address: SELF, limit: 2, fetch: mockLcd(sent, []) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => x.id)).toEqual(['A1', 'A2']);
    expect(r.truncated).toBe(true);
  });
});

describe('fetchCosmosActivity — 실패는 값', () => {
  it('HTTP 500 + {code,message} JSON → server (실측: events= 가 이렇게 죽는다)', async () => {
    const r = await fetchCosmosActivity({
      address: SELF,
      fetch: (async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({ code: 13, message: 'query cannot be empty', details: [] }),
        }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure).toBe('server');
      expect(r.message).toContain('query cannot be empty');
    }
  });

  it('HTTP 502 본문 JSON 아님 → network', async () => {
    const r = await fetchCosmosActivity({
      address: SELF,
      fetch: (async () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('not json');
          },
        }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('network');
  });

  it('fetch reject → network (throw 하지 않는다)', async () => {
    const r = await fetchCosmosActivity({
      address: SELF,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('network');
  });

  it('timeoutMs 초과 → timeout (AbortController 신호)', async () => {
    const r = await fetchCosmosActivity({
      address: SELF,
      timeoutMs: 20,
      fetch: ((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('timeout');
  });

  it('tx_responses 가 배열이 아니면 protocol', async () => {
    const r = await fetchCosmosActivity({
      address: SELF,
      fetch: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ txs: [] }), // tx_responses 없음
        }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('protocol');
  });

  it('txhash 없는 원소 → protocol', async () => {
    const r = await fetchCosmosActivity({
      address: SELF,
      fetch: mockLcd([{ height: '1' } as unknown as TxLike], []),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe('protocol');
  });
});
