// aptos-coins.test.ts — Aptos legacy Coin(체인 직접) + Fungible Asset(인덱서) 조회,
// 그리고 buildTransfer 의 asset 분기.
// 전부 offline: fetch 를 주입하고 SDK 의 트랜잭션 빌더는 가짜로 갈아 끼운다.

import { describe, expect, it } from 'vitest';
import { AptosAdapter } from '../src/chains/aptos.js';
import { discoverPortableTokens } from '../src/tokens/portable.js';
import { Wallet } from '../src/index.js';
import type { TransferIntent } from '../src/types.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';
const OWNER =
  '0xbfef909638ef90885158fdab9f56e216fd811fe25b32ead0bc2a272d66522bb0';

const USDC_TYPE = '0xdead::usdc::USDC';
const APT_TYPE = '0x1::aptos_coin::AptosCoin';

type FetchHandler = (url: string, init: RequestInit | undefined) => unknown;

/** 최소한의 Response 흉내. 코드가 쓰는 ok/json/headers.get 만 채운다. */
function res(
  body: unknown,
  opts: { ok?: boolean; headers?: Record<string, string> } = {},
): Response {
  const ok = opts.ok ?? true;
  const headers = opts.headers ?? {};
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

function makeFetch(h: FetchHandler): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(h(String(input), init))) as unknown as typeof fetch;
}

/** 계정 리소스 + CoinInfo 를 URL 로 라우팅하는 기본 fetch. */
function coinFetch(opts: {
  resources?: unknown;
  resourcesOk?: boolean;
  coinInfo?: Record<string, unknown>;
  graphql?: unknown;
  graphqlOk?: boolean;
}): typeof fetch {
  return makeFetch((url) => {
    if (url.includes('/resources')) {
      return res(opts.resources ?? [], { ok: opts.resourcesOk ?? true });
    }
    if (url.includes('/resource/')) {
      const type = decodeURIComponent(url.split('/resource/')[1] ?? '');
      const found = opts.coinInfo?.[type];
      if (!found) return res({}, { ok: false });
      return res(found);
    }
    if (url.includes('graphql')) {
      return res(opts.graphql ?? { data: { current_fungible_asset_balances: [] } }, {
        ok: opts.graphqlOk ?? true,
      });
    }
    return res({}, { ok: false });
  });
}

function coinStore(type: string, value: string): unknown {
  return { type: `0x1::coin::CoinStore<${type}>`, data: { coin: { value } } };
}

function coinInfo(decimals: unknown, symbol = 'USDC', name = 'USD Coin'): unknown {
  return { type: `0x1::coin::CoinInfo<${USDC_TYPE}>`, data: { decimals, name, symbol } };
}

describe('AptosAdapter.discoverTokens — CoinStore (체인 직접)', () => {
  it('CoinStore 를 훑고 CoinInfo 에서 메타를 읽는다', async () => {
    const aptos = new AptosAdapter({
      indexer: null,
      fetch: coinFetch({
        resources: [
          { type: '0x1::account::Account', data: {} },
          coinStore(USDC_TYPE, '1234567'),
        ],
        coinInfo: { [`0x1::coin::CoinInfo<${USDC_TYPE}>`]: coinInfo(6) },
      }),
    });

    const out = await aptos.discoverTokens(OWNER);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({
      id: USDC_TYPE,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      balance: 1_234_567n,
      // 체인에서 직접 읽었으므로 source 없음.
    });
    expect(out[0]!.source).toBeUndefined();
  });

  it('native APT 는 토큰 목록에서 뺀다 — getBalance 가 이미 주는 값이다', async () => {
    const aptos = new AptosAdapter({
      indexer: null,
      fetch: coinFetch({ resources: [coinStore(APT_TYPE, '5000')] }),
    });
    expect(await aptos.discoverTokens(OWNER)).toEqual([]);
  });

  it('CoinInfo 를 못 읽으면 그 항목을 버린다 (decimals 를 추측하지 않는다)', async () => {
    const aptos = new AptosAdapter({
      indexer: null,
      // coinInfo 를 아예 주지 않음 → 404
      fetch: coinFetch({ resources: [coinStore(USDC_TYPE, '10')] }),
    });
    expect(await aptos.discoverTokens(OWNER)).toEqual([]);
  });

  it('decimals 가 정수가 아니면 버린다', async () => {
    for (const bad of [undefined, '6', 1.5, -1, 99]) {
      const aptos = new AptosAdapter({
        indexer: null,
        fetch: coinFetch({
          resources: [coinStore(USDC_TYPE, '10')],
          coinInfo: { [`0x1::coin::CoinInfo<${USDC_TYPE}>`]: coinInfo(bad) },
        }),
      });
      expect(await aptos.discoverTokens(OWNER)).toEqual([]);
    }
  });

  it('잔액 값이 숫자 문자열이 아니면 버린다', async () => {
    const aptos = new AptosAdapter({
      indexer: null,
      fetch: coinFetch({
        resources: [{ type: `0x1::coin::CoinStore<${USDC_TYPE}>`, data: { coin: {} } }],
        coinInfo: { [`0x1::coin::CoinInfo<${USDC_TYPE}>`]: coinInfo(6) },
      }),
    });
    expect(await aptos.discoverTokens(OWNER)).toEqual([]);
  });

  it('리소스 조회가 실패해도 던지지 않고 빈 배열', async () => {
    const aptos = new AptosAdapter({
      indexer: null,
      fetch: coinFetch({ resourcesOk: false }),
    });
    expect(await aptos.discoverTokens(OWNER)).toEqual([]);
  });

  it('네트워크가 통째로 죽어도 빈 배열', async () => {
    const aptos = new AptosAdapter({
      fetch: (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch,
    });
    expect(await aptos.discoverTokens(OWNER)).toEqual([]);
  });

  it('타임아웃이 걸리면 빈 배열 — 첫 화면을 막지 않는다', async () => {
    const hang = ((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const aptos = new AptosAdapter({ fetch: hang, tokenTimeoutMs: 20 });
    expect(await aptos.discoverTokens(OWNER)).toEqual([]);
  });
});

describe('AptosAdapter.discoverTokens — FA (인덱서)', () => {
  const faRows = {
    data: {
      current_fungible_asset_balances: [
        {
          asset_type: '0xbeef',
          amount: '900',
          metadata: { name: 'Beef Token', symbol: 'BEEF', decimals: 8 },
        },
        // native APT 의 FA 얼굴 — 제외 대상.
        {
          asset_type: '0xa',
          amount: '5000',
          metadata: { name: 'Aptos Coin', symbol: 'APT', decimals: 8 },
        },
        // 메타가 없으면 버린다.
        { asset_type: '0xcafe', amount: '1', metadata: null },
      ],
    },
  };

  it('인덱서 값에는 source 를 남긴다 — 체인이 직접 말한 값이 아니다', async () => {
    const aptos = new AptosAdapter({ fetch: coinFetch({ graphql: faRows }) });
    const out = await aptos.discoverTokens(OWNER);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({
      id: '0xbeef',
      symbol: 'BEEF',
      name: 'Beef Token',
      decimals: 8,
      balance: 900n,
      source: 'aptos-indexer',
    });
  });

  it('같은 자산이 양쪽에 나오면 체인 직접 조회가 이긴다', async () => {
    const aptos = new AptosAdapter({
      fetch: coinFetch({
        resources: [coinStore(USDC_TYPE, '111')],
        coinInfo: { [`0x1::coin::CoinInfo<${USDC_TYPE}>`]: coinInfo(6) },
        graphql: {
          data: {
            current_fungible_asset_balances: [
              {
                asset_type: USDC_TYPE,
                amount: '999',
                metadata: { name: 'Wrong', symbol: 'WRONG', decimals: 2 },
              },
            ],
          },
        },
      }),
    });
    const out = await aptos.discoverTokens(OWNER);
    expect(out.length).toBe(1);
    expect(out[0]!.balance).toBe(111n);
    expect(out[0]!.decimals).toBe(6);
    expect(out[0]!.source).toBeUndefined();
  });

  it('인덱서가 죽어도 체인 직접 조회 결과는 살아남는다', async () => {
    const aptos = new AptosAdapter({
      fetch: coinFetch({
        resources: [coinStore(USDC_TYPE, '42')],
        coinInfo: { [`0x1::coin::CoinInfo<${USDC_TYPE}>`]: coinInfo(6) },
        graphqlOk: false,
      }),
    });
    const out = await aptos.discoverTokens(OWNER);
    expect(out.map((t) => t.balance)).toEqual([42n]);
  });

  it('indexer: null 이면 인덱서를 아예 호출하지 않는다', async () => {
    const seen: string[] = [];
    const aptos = new AptosAdapter({
      indexer: null,
      fetch: makeFetch((url) => {
        seen.push(url);
        return res([]);
      }),
    });
    await aptos.discoverTokens(OWNER);
    expect(seen.some((u) => u.includes('graphql'))).toBe(false);
  });

  it('공통 진입점 discoverPortableTokens 로도 같은 결과', async () => {
    const aptos = new AptosAdapter({ fetch: coinFetch({ graphql: faRows }) });
    const out = await discoverPortableTokens(aptos, OWNER);
    expect(out.map((t) => t.id)).toEqual(['0xbeef']);
  });
});

describe('AptosAdapter.buildTransfer — asset 분기', () => {
  interface BuildArgs {
    sender: string;
    data: {
      function: string;
      typeArguments?: string[];
      functionArguments: unknown[];
    };
  }

  /** SDK 의 트랜잭션 빌더를 가로채서 어떤 entry function 을 골랐는지만 본다. */
  function stubBuild(adapter: AptosAdapter): BuildArgs[] {
    const calls: BuildArgs[] = [];
    (
      adapter as unknown as {
        aptos: {
          transaction: {
            build: { simple: (a: BuildArgs) => Promise<unknown> };
          };
        };
      }
    ).aptos = {
      transaction: {
        build: {
          simple: async (a: BuildArgs) => {
            calls.push(a);
            return { fake: 'rawTxn' };
          },
        },
      },
    };
    return calls;
  }

  async function build(
    adapter: AptosAdapter,
    intent: TransferIntent,
  ): Promise<BuildArgs> {
    const calls = stubBuild(adapter);
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(adapter);
    await adapter.buildTransfer(intent, {
      sender: acc.address,
      signer: acc.signer,
    });
    return calls[0]!;
  }

  it('asset 없으면 native APT — 기존 entry function 그대로 (회귀 금지)', async () => {
    const aptos = new AptosAdapter();
    const call = await build(aptos, { to: OWNER, amount: 100n });
    expect(call.data.function).toBe('0x1::aptos_account::transfer');
    expect(call.data.typeArguments).toBeUndefined();
    expect(call.data.functionArguments).toEqual([OWNER, 100n]);
  });

  it('coin type 이면 transfer_coins<T>', async () => {
    const aptos = new AptosAdapter();
    const call = await build(aptos, { to: OWNER, amount: 100n, asset: USDC_TYPE });
    expect(call.data.function).toBe('0x1::aptos_account::transfer_coins');
    expect(call.data.typeArguments).toEqual([USDC_TYPE]);
    expect(call.data.functionArguments).toEqual([OWNER, 100n]);
  });

  it('FA metadata 주소면 primary_fungible_store::transfer', async () => {
    const aptos = new AptosAdapter();
    const call = await build(aptos, { to: OWNER, amount: 7n, asset: '0xbeef' });
    expect(call.data.function).toBe('0x1::primary_fungible_store::transfer');
    expect(call.data.typeArguments).toEqual(['0x1::fungible_asset::Metadata']);
    expect(call.data.functionArguments).toEqual(['0xbeef', OWNER, 7n]);
  });

  it('알 수 없는 asset 은 조용히 native 로 떨어지지 않고 던진다', async () => {
    const aptos = new AptosAdapter();
    stubBuild(aptos);
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(aptos);
    for (const asset of ['USDC', 'beef', '0x::a::b', 'not an address']) {
      await expect(
        aptos.buildTransfer(
          { to: OWNER, amount: 1n, asset },
          { sender: acc.address, signer: acc.signer },
        ),
      ).rejects.toThrow(/unsupported asset/);
    }
  });
});
