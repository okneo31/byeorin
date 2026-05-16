// activity.test.ts — ActivityLog (explorer 우선 + RPC fallback).
// 모두 offline: fetch 와 EvmAdapter.client 를 mock 한다.

import { describe, expect, it } from 'vitest';
import { ActivityLog, EvmAdapter, TTL_CHAIN } from '../src/index.js';

function makeAdapter(): EvmAdapter {
  return new EvmAdapter({ chain: TTL_CHAIN });
}

function mockFetchOk(payload: unknown): typeof fetch {
  return (async () => {
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function mockFetch404(): typeof fetch {
  return (async () => {
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

interface Patched {
  client: Record<string, unknown>;
}

describe('ActivityLog — explorer 경로', () => {
  it('etherscan-호환 응답을 Activity[] 로 변환 + native/tokentx 병합', async () => {
    const fetchImpl = (async (url: string) => {
      // url 에 따라 두 종류 응답 분기.
      const isToken = url.includes('action=tokentx');
      const result = isToken
        ? [
            {
              hash: '0xtok1',
              blockNumber: '100',
              timeStamp: '1700000200',
              from: '0xfff0000000000000000000000000000000000000',
              to: '0xa0000000000000000000000000000000000000aa',
              value: '1000000',
              contractAddress: '0xc0000000000000000000000000000000000000cc',
              txreceipt_status: '1',
            },
          ]
        : [
            {
              hash: '0xnat1',
              blockNumber: '99',
              timeStamp: '1700000100',
              from: '0xa0000000000000000000000000000000000000aa',
              to: '0xbbb0000000000000000000000000000000000000',
              value: '500000000000000000',
              isError: '0',
              txreceipt_status: '1',
            },
            {
              hash: '0xfail',
              blockNumber: '98',
              timeStamp: '1700000050',
              from: '0xa0000000000000000000000000000000000000aa',
              to: '0xbbb0000000000000000000000000000000000000',
              value: '0',
              isError: '1',
            },
          ];
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: '1', result }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const log = new ActivityLog(makeAdapter(), { fetch: fetchImpl });
    const out = await log.list('0xa0000000000000000000000000000000000000aa', 20);
    expect(out.length).toBe(3);
    // blockNumber desc
    expect(out[0]!.hash).toBe('0xtok1');
    expect(out[0]!.token).toBe('0xc0000000000000000000000000000000000000cc');
    expect(out[1]!.hash).toBe('0xnat1');
    expect(out[1]!.token).toBeUndefined();
    expect(out[2]!.status).toBe('failed');
  });

  it('limit 보다 많은 항목이 와도 잘라낸다', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      hash: '0x' + i.toString().padStart(64, '0'),
      blockNumber: String(1000 - i),
      timeStamp: String(1700000000 - i),
      from: '0xa0000000000000000000000000000000000000aa',
      to: '0xbbb0000000000000000000000000000000000000',
      value: '1',
    }));
    const fetchImpl = mockFetchOk({ status: '1', result: rows });
    const log = new ActivityLog(makeAdapter(), { fetch: fetchImpl });
    const out = await log.list('0xa0000000000000000000000000000000000000aa', 20);
    expect(out.length).toBe(20);
  });
});

describe('ActivityLog — RPC fallback', () => {
  it('explorer 404 → eth_getLogs + 블록 스캔', async () => {
    const adapter = makeAdapter();
    const p = adapter as unknown as Patched;
    // 두 라운드의 getLogs 모킹 (from / to)
    let logsCall = 0;
    p.client.getLogs = async () => {
      logsCall += 1;
      if (logsCall === 1) {
        // from = address
        return [
          {
            transactionHash: '0xloga',
            blockNumber: 95n,
            address: '0xtok0000000000000000000000000000000000ccc',
            data: '0x' + (1234n).toString(16).padStart(64, '0'),
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x000000000000000000000000a0000000000000000000000000000000000000aa',
              '0x000000000000000000000000bbb0000000000000000000000000000000000000',
            ],
          },
        ];
      }
      // to = address
      return [];
    };
    p.client.getBlockNumber = async () => 100n;
    p.client.getBlock = async () => ({
      number: 100n,
      timestamp: 1700001234n,
      transactions: [
        {
          hash: '0xblktx',
          from: '0xa0000000000000000000000000000000000000aa',
          to: '0xbbb0000000000000000000000000000000000000',
          value: 999n,
        },
      ],
    });

    const log = new ActivityLog(adapter, {
      fetch: mockFetch404(),
      fallbackLookback: 5,
    });
    const out = await log.list('0xa0000000000000000000000000000000000000aa', 20);
    // 토큰 transfer 1건 + native 5블록 동안 같은 블록 0xblktx 5번
    // (mock 이 매 호출 동일 객체 리턴) — limit 20 내에서 모두 포함.
    expect(out.length).toBeGreaterThan(0);
    const tokenHits = out.filter((a) => a.token);
    expect(tokenHits.length).toBe(1);
    expect(tokenHits[0]!.value).toBe(1234n);
    expect(tokenHits[0]!.from.toLowerCase()).toBe(
      '0xa0000000000000000000000000000000000000aa',
    );
    expect(tokenHits[0]!.to.toLowerCase()).toBe(
      '0xbbb0000000000000000000000000000000000000',
    );
  });

  it('explorer 가 빈 result 일 때 fallback 으로 빠진다', async () => {
    const adapter = makeAdapter();
    const p = adapter as unknown as Patched;
    p.client.getLogs = async () => [];
    p.client.getBlockNumber = async () => 5n;
    p.client.getBlock = async () => ({
      number: 5n,
      timestamp: 1700000000n,
      transactions: [],
    });
    const fetchImpl = mockFetchOk({ status: '0', result: [] });
    const log = new ActivityLog(adapter, { fetch: fetchImpl, fallbackLookback: 5 });
    const out = await log.list('0xa0000000000000000000000000000000000000aa', 20);
    expect(out).toEqual([]);
  });
});
