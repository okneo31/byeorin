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

describe('ActivityLog — TTL Scan 인덱서 경로', () => {
  // 인덱서 응답 한 벌. `/api/indexer/address/:addr/txs` 의 실제 형식.
  const indexerBody = {
    address: '0xa0000000000000000000000000000000000000aa',
    total: 2,
    page: 1,
    limit: 20,
    transactions: [
      {
        hash: '0xidx1',
        block_number: 1124800,
        from: '0xa0000000000000000000000000000000000000aa',
        to: '0x0000000000000000000000000000000000001000',
        value: '0',
        status: 1,
        timestamp: 1785246792,
        contract_address: null,
      },
      {
        hash: '0xidx2',
        block_number: 1123400,
        from: '0xbbb0000000000000000000000000000000000000',
        to: '0xa0000000000000000000000000000000000000aa',
        value: '1500000000000000000',
        status: 0,
        timestamp: 1785239792,
        contract_address: null,
      },
    ],
  };

  function noLogs(adapter: EvmAdapter): void {
    (adapter as unknown as Patched).client.request = async () => [];
  }

  it('인덱서 응답을 Activity[] 로 변환한다 (블록 내림차순, status 반영)', async () => {
    const adapter = makeAdapter();
    noLogs(adapter);
    const log = new ActivityLog(adapter, { fetch: mockFetchOk(indexerBody) });
    const out = await log.list('0xa0000000000000000000000000000000000000aa', 20);

    expect(out.length).toBe(2);
    expect(out[0]!.hash).toBe('0xidx1');
    expect(out[0]!.blockNumber).toBe(1124800n);
    expect(out[0]!.timestamp).toBe(1785246792);
    expect(out[0]!.status).toBe('success');
    expect(out[1]!.hash).toBe('0xidx2');
    expect(out[1]!.value).toBe(1500000000000000000n);
    // status 0 → failed. 성공으로 뭉개면 안 된다.
    expect(out[1]!.status).toBe('failed');
  });

  it('인덱서가 0건이면 그게 정답이다 — 느린 블록 스캔으로 떨어지지 않는다', async () => {
    const adapter = makeAdapter();
    noLogs(adapter);
    // 블록 스캔으로 떨어지면 이 두 개가 불린다. 불리면 실패다.
    let scanned = false;
    const p = adapter as unknown as Patched;
    p.client.getBlockNumber = async () => {
      scanned = true;
      return 100n;
    };
    p.client.getBlock = async () => {
      scanned = true;
      return { number: 100n, timestamp: 0n, transactions: [] };
    };

    const log = new ActivityLog(adapter, {
      fetch: mockFetchOk({ address: '0xa', total: 0, transactions: [] }),
    });
    const out = await log.list('0xa0000000000000000000000000000000000000aa', 20);

    expect(out).toEqual([]);
    expect(scanned).toBe(false);
  });

  it('인덱서 규격이 아니면(transactions 없음) 다음 경로로 넘어간다', async () => {
    const adapter = makeAdapter();
    noLogs(adapter);
    // etherscan 형식 응답이 인덱서 URL 로 돌아온 상황.
    // explorer 경로는 txlist 와 tokentx 를 둘 다 부르므로 URL 로 분기한다 —
    // 안 그러면 같은 행이 두 번 세어진다.
    const fetchImpl = (async (url: string) => {
      const rows = url.includes('action=tokentx')
        ? []
        : [
            {
              hash: '0xes1',
              blockNumber: '77',
              timeStamp: '1700000000',
              from: '0xa0000000000000000000000000000000000000aa',
              to: '0xbbb0000000000000000000000000000000000000',
              value: '7',
            },
          ];
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: '1', result: rows }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const log = new ActivityLog(adapter, { fetch: fetchImpl });
    const out = await log.list('0xa0000000000000000000000000000000000000aa', 20);
    // 인덱서 파서가 null 을 돌려주고 etherscan 파서가 받아냈다.
    expect(out.length).toBe(1);
    expect(out[0]!.hash).toBe('0xes1');
  });

  it('TTL 이 아닌 체인에서는 인덱서를 시도하지 않는다', async () => {
    // 체인 id 를 바꾸면 인덱서 자동 감지가 꺼져야 한다. 남의 explorer 에
    // TTL 전용 경로를 찔러 왕복을 버리지 않기 위한 규칙이다.
    const adapter = new EvmAdapter({
      chain: { ...TTL_CHAIN, id: 1 },
      rpcUrl: 'https://rpc.ttl1.top',
    });
    noLogs(adapter);
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: '1', result: [] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const p = adapter as unknown as Patched;
    p.client.getBlockNumber = async () => 1n;
    p.client.getBlock = async () => ({ number: 1n, timestamp: 0n, transactions: [] });

    const log = new ActivityLog(adapter, { fetch: fetchImpl, fallbackLookback: 1 });
    await log.list('0xa0000000000000000000000000000000000000aa', 20);

    expect(seen.some((u) => u.includes('/indexer/'))).toBe(false);
    expect(seen.some((u) => u.includes('module=account'))).toBe(true);
  });
});

describe('ActivityLog — RPC fallback', () => {
  it('explorer 404 → eth_getLogs + 블록 스캔', async () => {
    const adapter = makeAdapter();
    const p = adapter as unknown as Patched;
    // eth_getLogs 를 client.request 로 모킹한다 — 실사용이 타는 경로와 동일.
    // (예전엔 client.getLogs 를 모킹했는데, 그 경로는 실사용에서 41초 매달리다
    //  타임아웃하는 함정이라 제거했다.)
    let logsCall = 0;
    p.client.request = async ({ method }: { method: string }) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
      logsCall += 1;
      if (logsCall === 1) {
        // from = address. 실제 RPC 는 blockNumber 를 hex 로 준다.
        return [
          {
            transactionHash: '0xloga',
            blockNumber: '0x5f',
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
    p.client.request = async () => [];
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
