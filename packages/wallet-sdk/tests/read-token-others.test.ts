// read-token-others.test.ts — 수동 토큰 추가(`readToken`) : Cosmos · Sui · Aptos · TON · XRP.
//
// 전부 offline. 각 어댑터가 이미 `discoverTokens` 에서 쓰는 창구만 갈아끼운다
// (cosmos-denoms / sui-coins / aptos-coins / ton-jettons / xrp-issued 와 같은 방식).
//
// 이 스위트의 핵심 질문은 하나다: **자동 발견과 수동 추가가 같은 값을 주는가.**
// 두 경로가 갈라지면 같은 토큰이 목록과 수동 추가에서 다른 id·다른 자릿수로
// 보이고, 송금이 조회와 어긋난다. 그래서 체인마다 "같은 입력 → 두 경로 →
// toEqual" 을 한 번씩 못박아 둔다.

import { describe, expect, it } from 'vitest';
import { Address as TonAddress } from '@ton/ton';
import { CosmosAdapter } from '../src/chains/cosmos.js';
import { SuiAdapter } from '../src/chains/sui.js';
import { AptosAdapter } from '../src/chains/aptos.js';
import { TonAdapter } from '../src/chains/ton.js';
import { XrpAdapter, XRP_ISSUED_DECIMALS } from '../src/chains/xrp.js';
import {
  readPortableToken,
  supportsManualToken,
} from '../src/tokens/portable.js';
import type { Payment } from 'xrpl';

/* ================================================================== */
/* Cosmos (ZION)                                                       */
/* ================================================================== */

type Coin = { denom: string; amount: bigint };

function zionAdapter(
  extra?: ConstructorParameters<typeof CosmosAdapter>[0]['denomMetadata'],
): CosmosAdapter {
  return new CosmosAdapter({
    chainId: 'zion',
    bech32Prefix: 'zion',
    rpcUrl: 'http://localhost',
    denom: 'utrg',
    decimals: 6,
    defaultFee: 0n,
    ...(extra ? { denomMetadata: extra } : {}),
  });
}

function patchBalances(
  adapter: CosmosAdapter,
  impl: (address: string) => Promise<Coin[]>,
): void {
  adapter.getAllBalances = impl;
}

const ZION_OWNER = 'zion1abc';

describe('CosmosAdapter.readToken', () => {
  it('수동 추가를 지원한다고 알린다', () => {
    expect(supportsManualToken(zionAdapter())).toBe(true);
  });

  it('내장 표의 denom 을 읽는다 (ubtc 는 8 — u 접두를 6 으로 유추하지 않는다)', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [{ denom: 'ubtc', amount: 250_000_000n }]);

    const out = await adapter.readToken('ubtc', ZION_OWNER);
    expect(out).toEqual({
      id: 'ubtc',
      symbol: 'BTC',
      name: 'Bitcoin (ZION peg)',
      decimals: 8,
      balance: 250_000_000n,
      source: 'cosmos:builtin-denom-table',
    });
  });

  it('discoverTokens 와 완전히 같은 값을 준다 (두 경로가 갈라지면 안 된다)', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [
      { denom: 'utrg', amount: 1_500_000n },
      { denom: 'ubtc', amount: 250_000_000n },
      { denom: 'uusdt', amount: 42_000_000n },
      { denom: 'ueth', amount: 7_000_000n },
    ]);

    const listed = await adapter.discoverTokens(ZION_OWNER);
    for (const token of listed) {
      expect(await adapter.readToken(token.id, ZION_OWNER)).toEqual(token);
    }
  });

  it('앞뒤 공백은 무시하고 같은 id 로 정규화한다', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [{ denom: 'uusdt', amount: 5n }]);
    const out = await adapter.readToken('  uusdt  ', ZION_OWNER);
    expect(out!.id).toBe('uusdt');
  });

  it('decimals 를 모르는 denom 은 null — 6 으로 추측하지 않는다', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [{ denom: 'umystery', amount: 999n }]);
    // 잔액은 실제로 있지만 자릿수를 모른다. 잔액을 보여주는 것보다 안 보여주는
    // 편이 낫다 — 100 배 틀린 숫자는 사용자가 알아채지 못한다.
    expect(await adapter.readToken('umystery', ZION_OWNER)).toBeNull();
  });

  it('ibc/... denom 도 알려주지 않으면 null, denomMetadata 로 알려주면 읽힌다', async () => {
    const ibc =
      'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2';
    const bare = zionAdapter();
    patchBalances(bare, async () => [{ denom: ibc, amount: 77n }]);
    expect(await bare.readToken(ibc, ZION_OWNER)).toBeNull();

    const told = zionAdapter({
      [ibc]: { symbol: 'ATOM', name: 'Cosmos Hub ATOM (IBC)', decimals: 6 },
    });
    patchBalances(told, async () => [{ denom: ibc, amount: 77n }]);
    expect(await told.readToken(ibc, ZION_OWNER)).toEqual({
      id: ibc,
      symbol: 'ATOM',
      name: 'Cosmos Hub ATOM (IBC)',
      decimals: 6,
      balance: 77n,
      source: 'cosmos:denomMetadata-option',
    });
  });

  it('아직 안 받은 denom 도 잔액 0 으로 등록된다', async () => {
    const adapter = zionAdapter();
    // 보유 목록에 ubtc 가 아예 없다.
    patchBalances(adapter, async () => [{ denom: 'utrg', amount: 1n }]);
    const out = await adapter.readToken('ubtc', ZION_OWNER);
    expect(out!.balance).toBe(0n);
    expect(out!.decimals).toBe(8);
  });

  it('잔액 조회가 실패해도 메타는 채워 등록한다', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => {
      throw new Error('rpc down');
    });
    const out = await adapter.readToken('uusdt', ZION_OWNER);
    expect(out).toEqual({
      id: 'uusdt',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      balance: 0n,
      source: 'cosmos:builtin-denom-table',
    });
  });

  it('denom 문법이 아니면 던진다 (조용한 null 보다 이유를 알린다)', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => []);
    for (const bad of ['', '   ', '0xdeadbeef', '1utrg', 'ab', 'has space']) {
      await expect(adapter.readToken(bad, ZION_OWNER)).rejects.toThrow(
        /token id must be a denom/,
      );
    }
  });

  it('공통 진입점 readPortableToken 을 그대로 통과한다', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [{ denom: 'ueth', amount: 7n }]);
    const out = await readPortableToken(adapter, 'ueth', ZION_OWNER);
    expect(out!.decimals).toBe(6);
  });
});

/* ================================================================== */
/* Sui                                                                 */
/* ================================================================== */

const SUI_OWNER =
  '0xc88ef07b9b8b2fc3b7daad9478f4e1337f01792e2eab9c3794494e610636026e';
const SUI_SHORT = '0x2::sui::SUI';
const SUI_FULL =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const SUI_USDC =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

interface CoinBalanceLike {
  coinType: string;
  coinObjectCount: number;
  totalBalance: string;
  lockedBalance: Record<string, string>;
}
interface CoinMetadataLike {
  decimals: number;
  description: string;
  name: string;
  symbol: string;
}

interface SuiClientSlot {
  getAllBalances: (i: { owner: string }) => Promise<CoinBalanceLike[]>;
  getBalance: (i: { owner: string; coinType?: string }) => Promise<CoinBalanceLike>;
  getCoinMetadata: (i: { coinType: string }) => Promise<CoinMetadataLike | null>;
}

function suiSlot(adapter: SuiAdapter): SuiClientSlot {
  return (adapter as unknown as { client: SuiClientSlot }).client;
}

function suiMeta(symbol: string, decimals: number, name = symbol): CoinMetadataLike {
  return { symbol, decimals, name, description: '' };
}

function suiBalance(coinType: string, total: string): CoinBalanceLike {
  return { coinType, coinObjectCount: 1, totalBalance: total, lockedBalance: {} };
}

describe('SuiAdapter.readToken', () => {
  it('수동 추가를 지원한다고 알린다', () => {
    expect(supportsManualToken(new SuiAdapter())).toBe(true);
  });

  it('getCoinMetadata + getBalance 로 읽는다', async () => {
    const adapter = new SuiAdapter();
    suiSlot(adapter).getCoinMetadata = async () => suiMeta('USDC', 6, 'USD Coin');
    suiSlot(adapter).getBalance = async () => suiBalance(SUI_USDC, '5000000');

    expect(await adapter.readToken(SUI_USDC, SUI_OWNER)).toEqual({
      id: SUI_USDC,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      balance: 5_000_000n,
      source: 'sui:getCoinMetadata',
    });
  });

  it('discoverTokens 와 완전히 같은 값을 준다', async () => {
    const adapter = new SuiAdapter();
    suiSlot(adapter).getAllBalances = async () => [
      suiBalance(SUI_FULL, '1234567890'),
      suiBalance(SUI_USDC, '5000000'),
    ];
    suiSlot(adapter).getCoinMetadata = async ({ coinType }) =>
      coinType === SUI_FULL ? suiMeta('SUI', 9, 'Sui') : suiMeta('USDC', 6, 'USD Coin');
    suiSlot(adapter).getBalance = async ({ coinType }) =>
      coinType === SUI_FULL
        ? suiBalance(SUI_FULL, '1234567890')
        : suiBalance(SUI_USDC, '5000000');

    const listed = await adapter.discoverTokens(SUI_OWNER);
    expect(listed).toHaveLength(2);
    for (const token of listed) {
      expect(await adapter.readToken(token.id, SUI_OWNER)).toEqual(token);
    }
  });

  it('짧은 표기로 넣어도 목록과 같은 id 가 나온다 (0x2 == 0x000…002)', async () => {
    const adapter = new SuiAdapter();
    suiSlot(adapter).getAllBalances = async () => [suiBalance(SUI_FULL, '10')];
    suiSlot(adapter).getCoinMetadata = async () => suiMeta('SUI', 9, 'Sui');
    // 풀노드는 자기 표기(여기서는 정규형)를 돌려준다 — 그 값을 id 로 쓴다.
    suiSlot(adapter).getBalance = async () => suiBalance(SUI_FULL, '10');

    const [listed] = await adapter.discoverTokens(SUI_OWNER);
    const manual = await adapter.readToken(SUI_SHORT, SUI_OWNER);
    expect(manual!.id).toBe(SUI_FULL);
    expect(manual).toEqual(listed);
  });

  it('metadata 가 없으면 null — decimals 를 추측하지 않는다', async () => {
    const adapter = new SuiAdapter();
    suiSlot(adapter).getCoinMetadata = async () => null;
    suiSlot(adapter).getBalance = async () => suiBalance(SUI_USDC, '1');
    expect(await adapter.readToken(SUI_USDC, SUI_OWNER)).toBeNull();
  });

  it('decimals 가 정수가 아니면 null', async () => {
    const adapter = new SuiAdapter();
    suiSlot(adapter).getBalance = async () => suiBalance(SUI_USDC, '1');
    for (const bad of [6.5, -1]) {
      suiSlot(adapter).getCoinMetadata = async () => suiMeta('USDC', bad);
      expect(await adapter.readToken(SUI_USDC, SUI_OWNER)).toBeNull();
    }
  });

  it('잔액을 못 구해도 메타는 채워 등록한다 (아직 안 받은 코인)', async () => {
    const adapter = new SuiAdapter();
    suiSlot(adapter).getCoinMetadata = async () => suiMeta('USDC', 6, 'USD Coin');
    suiSlot(adapter).getBalance = async () => {
      throw new Error('rpc down');
    };
    const out = await adapter.readToken(SUI_USDC, SUI_OWNER);
    expect(out!.balance).toBe(0n);
    expect(out!.decimals).toBe(6);
    // 잔액 조회가 죽었으므로 정규화한 값을 id 로 쓴다.
    expect(out!.id).toBe(SUI_USDC);
  });

  it('coin type 문법이 아니면 던진다', async () => {
    const adapter = new SuiAdapter();
    suiSlot(adapter).getCoinMetadata = async () => suiMeta('X', 1);
    for (const bad of ['', '  ', 'erc20', 'ubtc', '0xdeadbeef']) {
      await expect(adapter.readToken(bad, SUI_OWNER)).rejects.toThrow(
        /token id must be a coin type/,
      );
    }
  });
});

/* ================================================================== */
/* Aptos                                                               */
/* ================================================================== */

const APTOS_OWNER =
  '0xbfef909638ef90885158fdab9f56e216fd811fe25b32ead0bc2a272d66522bb0';
const APTOS_USDC = '0xdead::usdc::USDC';
const APT_COIN = '0x1::aptos_coin::AptosCoin';
const FA_BEEF = '0xbeef';

function aptosRes(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

interface AptosFetchOpts {
  /** 계정 리소스 목록 (discoverTokens 의 CoinStore 훑기용). */
  resources?: unknown[];
  /** 단건 리소스 조회: 리소스 타입 → 응답 본문. 없으면 404. */
  resource?: Record<string, unknown>;
  /** GraphQL: 쿼리 이름(ByeorinFaBalances | ByeorinReadFa) → 응답 본문. */
  graphql?: Record<string, unknown>;
  graphqlOk?: boolean;
}

function aptosFetch(opts: AptosFetchOpts): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/resources')) return Promise.resolve(aptosRes(opts.resources ?? []));
    if (url.includes('/resource/')) {
      const type = decodeURIComponent(url.split('/resource/')[1] ?? '');
      const found = opts.resource?.[type];
      return Promise.resolve(found ? aptosRes(found) : aptosRes({}, false));
    }
    if (url.includes('graphql')) {
      if (opts.graphqlOk === false) return Promise.resolve(aptosRes({}, false));
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
      const name = /query (\w+)/.exec(body.query ?? '')?.[1] ?? '';
      return Promise.resolve(
        aptosRes(opts.graphql?.[name] ?? { data: {} }),
      );
    }
    return Promise.resolve(aptosRes({}, false));
  }) as unknown as typeof fetch;
}

function coinStoreRes(type: string, value: string): unknown {
  return { type: `0x1::coin::CoinStore<${type}>`, data: { coin: { value } } };
}

function coinInfoRes(decimals: unknown, symbol = 'USDC', name = 'USD Coin'): unknown {
  return { type: `0x1::coin::CoinInfo<${APTOS_USDC}>`, data: { decimals, name, symbol } };
}

describe('AptosAdapter.readToken — legacy Coin (체인 직접)', () => {
  it('수동 추가를 지원한다고 알린다', () => {
    expect(supportsManualToken(new AptosAdapter())).toBe(true);
  });

  it('CoinInfo + CoinStore 로 읽고 source 를 남기지 않는다', async () => {
    const aptos = new AptosAdapter({
      indexer: null,
      fetch: aptosFetch({
        resource: {
          [`0x1::coin::CoinInfo<${APTOS_USDC}>`]: coinInfoRes(6),
          [`0x1::coin::CoinStore<${APTOS_USDC}>`]: coinStoreRes(APTOS_USDC, '1234567'),
        },
      }),
    });
    const out = await aptos.readToken(APTOS_USDC, APTOS_OWNER);
    expect(out).toEqual({
      id: APTOS_USDC,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      balance: 1_234_567n,
    });
    expect(out!.source).toBeUndefined();
  });

  it('discoverTokens 와 완전히 같은 값을 준다', async () => {
    const aptos = new AptosAdapter({
      indexer: null,
      fetch: aptosFetch({
        resources: [
          { type: '0x1::account::Account', data: {} },
          coinStoreRes(APTOS_USDC, '1234567'),
        ],
        resource: {
          [`0x1::coin::CoinInfo<${APTOS_USDC}>`]: coinInfoRes(6),
          [`0x1::coin::CoinStore<${APTOS_USDC}>`]: coinStoreRes(APTOS_USDC, '1234567'),
        },
      }),
    });
    const listed = await aptos.discoverTokens(APTOS_OWNER);
    expect(listed).toHaveLength(1);
    expect(await aptos.readToken(listed[0]!.id, APTOS_OWNER)).toEqual(listed[0]);
  });

  it('CoinStore 가 없으면 잔액 0 으로 등록한다 (아직 register 안 한 계정)', async () => {
    const aptos = new AptosAdapter({
      indexer: null,
      fetch: aptosFetch({
        resource: { [`0x1::coin::CoinInfo<${APTOS_USDC}>`]: coinInfoRes(6) },
      }),
    });
    const out = await aptos.readToken(APTOS_USDC, APTOS_OWNER);
    expect(out!.balance).toBe(0n);
    expect(out!.decimals).toBe(6);
  });

  it('CoinInfo 를 못 읽으면 null — decimals 를 추측하지 않는다', async () => {
    const aptos = new AptosAdapter({
      indexer: null,
      fetch: aptosFetch({
        resource: { [`0x1::coin::CoinStore<${APTOS_USDC}>`]: coinStoreRes(APTOS_USDC, '10') },
      }),
    });
    expect(await aptos.readToken(APTOS_USDC, APTOS_OWNER)).toBeNull();
  });

  it('decimals 가 정수가 아니면 null', async () => {
    for (const bad of [undefined, '6', 1.5, -1, 99]) {
      const aptos = new AptosAdapter({
        indexer: null,
        fetch: aptosFetch({
          resource: { [`0x1::coin::CoinInfo<${APTOS_USDC}>`]: coinInfoRes(bad) },
        }),
      });
      expect(await aptos.readToken(APTOS_USDC, APTOS_OWNER)).toBeNull();
    }
  });

  it('native APT 는 null — discoverTokens 가 빼는 것과 같은 이유', async () => {
    const aptos = new AptosAdapter({ indexer: null, fetch: aptosFetch({}) });
    expect(await aptos.readToken(APT_COIN, APTOS_OWNER)).toBeNull();
  });
});

describe('AptosAdapter.readToken — Fungible Asset (인덱서)', () => {
  const faBalanceRow = {
    asset_type: FA_BEEF,
    amount: '900',
    metadata: { name: 'Beef Token', symbol: 'BEEF', decimals: 8 },
  };

  it('인덱서에서 읽고 source 를 남긴다', async () => {
    const aptos = new AptosAdapter({
      fetch: aptosFetch({
        graphql: {
          ByeorinReadFa: {
            data: {
              current_fungible_asset_balances: [faBalanceRow],
              fungible_asset_metadata: [],
            },
          },
        },
      }),
    });
    expect(await aptos.readToken(FA_BEEF, APTOS_OWNER)).toEqual({
      id: FA_BEEF,
      symbol: 'BEEF',
      name: 'Beef Token',
      decimals: 8,
      balance: 900n,
      source: 'aptos-indexer',
    });
  });

  it('discoverTokens 와 완전히 같은 값을 준다', async () => {
    const aptos = new AptosAdapter({
      fetch: aptosFetch({
        graphql: {
          ByeorinFaBalances: {
            data: { current_fungible_asset_balances: [faBalanceRow] },
          },
          ByeorinReadFa: {
            data: {
              current_fungible_asset_balances: [faBalanceRow],
              fungible_asset_metadata: [],
            },
          },
        },
      }),
    });
    const listed = await aptos.discoverTokens(APTOS_OWNER);
    expect(listed).toHaveLength(1);
    expect(await aptos.readToken(listed[0]!.id, APTOS_OWNER)).toEqual(listed[0]);
  });

  it('잔액 행이 없으면 자산 메타로 잔액 0 등록 (아직 안 받은 FA)', async () => {
    const aptos = new AptosAdapter({
      fetch: aptosFetch({
        graphql: {
          ByeorinReadFa: {
            data: {
              current_fungible_asset_balances: [],
              fungible_asset_metadata: [
                { asset_type: FA_BEEF, name: 'Beef Token', symbol: 'BEEF', decimals: 8 },
              ],
            },
          },
        },
      }),
    });
    expect(await aptos.readToken(FA_BEEF, APTOS_OWNER)).toEqual({
      id: FA_BEEF,
      symbol: 'BEEF',
      name: 'Beef Token',
      decimals: 8,
      balance: 0n,
      source: 'aptos-indexer',
    });
  });

  it('메타의 decimals 가 없으면 null', async () => {
    const aptos = new AptosAdapter({
      fetch: aptosFetch({
        graphql: {
          ByeorinReadFa: {
            data: {
              current_fungible_asset_balances: [],
              fungible_asset_metadata: [
                { asset_type: FA_BEEF, name: 'Beef', symbol: 'BEEF', decimals: null },
              ],
            },
          },
        },
      }),
    });
    expect(await aptos.readToken(FA_BEEF, APTOS_OWNER)).toBeNull();
  });

  it('인덱서가 모르는 주소면 null', async () => {
    const aptos = new AptosAdapter({
      fetch: aptosFetch({
        graphql: {
          ByeorinReadFa: {
            data: { current_fungible_asset_balances: [], fungible_asset_metadata: [] },
          },
        },
      }),
    });
    expect(await aptos.readToken('0xcafe', APTOS_OWNER)).toBeNull();
  });

  it('native APT 의 FA 얼굴(0xa)도 null', async () => {
    const aptos = new AptosAdapter({ fetch: aptosFetch({}) });
    expect(await aptos.readToken('0xa', APTOS_OWNER)).toBeNull();
    expect(
      await aptos.readToken(`0x${'0'.repeat(63)}a`, APTOS_OWNER),
    ).toBeNull();
  });

  it('인덱서를 껐으면 "없다" 가 아니라 "물어볼 곳이 없다" 로 던진다', async () => {
    const aptos = new AptosAdapter({ indexer: null, fetch: aptosFetch({}) });
    await expect(aptos.readToken(FA_BEEF, APTOS_OWNER)).rejects.toThrow(
      /indexer is disabled/,
    );
  });

  it('인덱서 HTTP 오류는 던진다 (조용한 null 로 뭉개지 않는다)', async () => {
    const aptos = new AptosAdapter({ fetch: aptosFetch({ graphqlOk: false }) });
    await expect(aptos.readToken(FA_BEEF, APTOS_OWNER)).rejects.toThrow(
      /indexer returned HTTP/,
    );
  });
});

describe('AptosAdapter.readToken — 잘못된 id', () => {
  it('coin type 도 주소도 아니면 던진다', async () => {
    const aptos = new AptosAdapter({ fetch: aptosFetch({}) });
    for (const bad of ['', 'USDC', 'beef', '0x::a::b', 'not an address']) {
      await expect(aptos.readToken(bad, APTOS_OWNER)).rejects.toThrow(
        /unsupported token id/,
      );
    }
  });

  it('갈래 판별이 송금(buildTransfer)과 같은 규칙을 쓴다', async () => {
    // coin type 은 Coin 갈래(체인 직접, source 없음), 주소는 FA 갈래(인덱서).
    // 송금의 buildTransferPayload 도 같은 두 판별식으로 갈린다.
    const aptos = new AptosAdapter({
      fetch: aptosFetch({
        resource: {
          [`0x1::coin::CoinInfo<${APTOS_USDC}>`]: coinInfoRes(6),
        },
        graphql: {
          ByeorinReadFa: {
            data: {
              current_fungible_asset_balances: [],
              fungible_asset_metadata: [
                { asset_type: FA_BEEF, name: 'Beef', symbol: 'BEEF', decimals: 8 },
              ],
            },
          },
        },
      }),
    });
    expect((await aptos.readToken(APTOS_USDC, APTOS_OWNER))!.source).toBeUndefined();
    expect((await aptos.readToken(FA_BEEF, APTOS_OWNER))!.source).toBe('aptos-indexer');
  });
});

/* ================================================================== */
/* TON                                                                 */
/* ================================================================== */

const TON_MASTER = new TonAddress(0, Buffer.alloc(32, 0x11));
const TON_JETTON_WALLET = new TonAddress(0, Buffer.alloc(32, 0x22));
const TON_OWNER = 'EQAtUn6khf4MxnAB4aQNcDlUPNOsLtU8IOVZbIabFzw9Kbar';
const TON_MASTER_FRIENDLY = TON_MASTER.toString({
  bounceable: true,
  testOnly: false,
  urlSafe: true,
});

function tonBalanceRow(over: Record<string, unknown> = {}): unknown {
  return {
    balance: '1500000000',
    wallet_address: { address: TON_JETTON_WALLET.toRawString() },
    jetton: {
      address: TON_MASTER.toRawString(),
      name: 'Test Jetton',
      symbol: 'TJT',
      decimals: 9,
    },
    ...over,
  };
}

interface TonFetchOpts {
  /** `/v2/accounts/{owner}/jettons` — 목록. */
  list?: unknown;
  /** `/v2/accounts/{owner}/jettons/{master}` — 단건 잔액. undefined 면 404. */
  held?: unknown;
  /** `/v2/jettons/{master}` — master 메타. undefined 면 404. */
  master?: unknown;
}

function tonFetch(opts: TonFetchOpts): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = String(input);
    const ok = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    const missing = (): Response =>
      ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response;
    if (url.includes('/v2/accounts/')) {
      if (url.endsWith('/jettons')) {
        return Promise.resolve(opts.list === undefined ? missing() : ok(opts.list));
      }
      return Promise.resolve(opts.held === undefined ? missing() : ok(opts.held));
    }
    if (url.includes('/v2/jettons/')) {
      return Promise.resolve(opts.master === undefined ? missing() : ok(opts.master));
    }
    return Promise.resolve(missing());
  }) as unknown as typeof fetch;
}

describe('TonAdapter.readToken', () => {
  it('수동 추가를 지원한다고 알린다', () => {
    expect(supportsManualToken(new TonAdapter())).toBe(true);
  });

  it('소유자의 jetton wallet 잔액을 읽고 인덱서 출처를 남긴다', async () => {
    const ton = new TonAdapter({ fetch: tonFetch({ held: tonBalanceRow() }) });
    expect(await ton.readToken(TON_MASTER.toString(), TON_OWNER)).toEqual({
      // raw 형이 아니라 사용자 친화형으로 정규화한다 (목록과 같은 규칙).
      id: TON_MASTER_FRIENDLY,
      symbol: 'TJT',
      name: 'Test Jetton',
      decimals: 9,
      balance: 1_500_000_000n,
      source: 'tonapi.io',
    });
  });

  it('discoverTokens 와 완전히 같은 값을 준다', async () => {
    const ton = new TonAdapter({
      fetch: tonFetch({
        list: { balances: [tonBalanceRow()] },
        held: tonBalanceRow(),
      }),
    });
    const listed = await ton.discoverTokens(TON_OWNER);
    expect(listed).toHaveLength(1);
    expect(await ton.readToken(listed[0]!.id, TON_OWNER)).toEqual(listed[0]);
  });

  it('raw 형(0:…)으로 넣어도 목록과 같은 id 가 나온다', async () => {
    const ton = new TonAdapter({
      fetch: tonFetch({ list: { balances: [tonBalanceRow()] }, held: tonBalanceRow() }),
    });
    const [listed] = await ton.discoverTokens(TON_OWNER);
    const manual = await ton.readToken(TON_MASTER.toRawString(), TON_OWNER);
    expect(manual!.id).toBe(listed!.id);
  });

  it('jetton wallet 이 없으면 master 메타로 잔액 0 등록 (decimals 가 문자열이어도)', async () => {
    const ton = new TonAdapter({
      fetch: tonFetch({
        // held 없음 → 404
        master: {
          metadata: {
            address: TON_MASTER.toRawString(),
            name: 'Test Jetton',
            symbol: 'TJT',
            // tonapi 는 이 엔드포인트에서 decimals 를 문자열로 준다.
            decimals: '9',
          },
        },
      }),
    });
    expect(await ton.readToken(TON_MASTER.toString(), TON_OWNER)).toEqual({
      id: TON_MASTER_FRIENDLY,
      symbol: 'TJT',
      name: 'Test Jetton',
      decimals: 9,
      balance: 0n,
      source: 'tonapi.io',
    });
  });

  it('testnet 은 testnet 표기와 testnet 인덱서를 쓴다', async () => {
    const ton = new TonAdapter({
      network: 'testnet',
      fetch: tonFetch({ held: tonBalanceRow() }),
    });
    const out = await ton.readToken(TON_MASTER.toString(), TON_OWNER);
    expect(out!.id).toBe(
      TON_MASTER.toString({ bounceable: true, testOnly: true, urlSafe: true }),
    );
    expect(out!.source).toBe('testnet.tonapi.io');
  });

  it('decimals 를 못 얻으면 null — 추측하지 않는다', async () => {
    for (const bad of [undefined, null, 1.5, -1, 'nine']) {
      const ton = new TonAdapter({
        fetch: tonFetch({
          held: tonBalanceRow({
            jetton: { address: TON_MASTER.toRawString(), symbol: 'TJT', decimals: bad },
          }),
          master: {
            metadata: { address: TON_MASTER.toRawString(), symbol: 'TJT', decimals: bad },
          },
        }),
      });
      expect(await ton.readToken(TON_MASTER.toString(), TON_OWNER)).toBeNull();
    }
  });

  it('인덱서가 모르는 jetton 이면 null', async () => {
    const ton = new TonAdapter({ fetch: tonFetch({}) });
    expect(await ton.readToken(TON_MASTER.toString(), TON_OWNER)).toBeNull();
  });

  it('jetton master 주소가 아니면 던진다', async () => {
    const ton = new TonAdapter({ fetch: tonFetch({}) });
    for (const bad of ['', 'not-a-jetton', '0xdeadbeef']) {
      await expect(ton.readToken(bad, TON_OWNER)).rejects.toThrow(
        /unsupported token id/,
      );
    }
  });

  it('jettonApiUrl: null 이면 "물어볼 곳이 없다" 로 던진다', async () => {
    const ton = new TonAdapter({ jettonApiUrl: null, fetch: tonFetch({}) });
    await expect(ton.readToken(TON_MASTER.toString(), TON_OWNER)).rejects.toThrow(
      /jettonApiUrl is null/,
    );
  });
});

/* ================================================================== */
/* XRP                                                                 */
/* ================================================================== */

const XRP_ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const XRP_OWNER = 'rnrbiYDUYTJS4JVdSV5FtyCj4HFuRjfLKM';
const XRP_TTL_HEX = '54544C0000000000000000000000000000000000';

interface FakeXrpClient {
  request: (req: Record<string, unknown>) => Promise<unknown>;
  autofill: (tx: Payment) => Promise<Payment>;
}

function installXrpClient(
  adapter: XrpAdapter,
  fake: Partial<FakeXrpClient>,
): void {
  (adapter as unknown as { client: () => Promise<Partial<FakeXrpClient>> }).client =
    async () => fake;
}

function xrpLine(over: Record<string, unknown>): Record<string, unknown> {
  return {
    account: XRP_ISSUER,
    currency: 'USD',
    balance: '0',
    limit: '1000000',
    limit_peer: '0',
    quality_in: 0,
    quality_out: 0,
    ...over,
  };
}

describe('XrpAdapter.readToken', () => {
  it('수동 추가를 지원한다고 알린다', () => {
    expect(supportsManualToken(new XrpAdapter())).toBe(true);
  });

  it('trust line 을 찾아 읽는다 (15 자리 고정 규약)', async () => {
    const xrp = new XrpAdapter();
    installXrpClient(xrp, {
      request: async () => ({
        result: { lines: [xrpLine({ currency: 'USD', balance: '123.456' })] },
      }),
    });
    expect(await xrp.readToken(`USD.${XRP_ISSUER}`, XRP_OWNER)).toEqual({
      id: `USD.${XRP_ISSUER}`,
      symbol: 'USD',
      name: 'USD',
      decimals: XRP_ISSUED_DECIMALS,
      balance: 123_456_000_000_000_000n,
    });
  });

  it('discoverTokens 와 완전히 같은 값을 준다', async () => {
    const xrp = new XrpAdapter();
    installXrpClient(xrp, {
      request: async () => ({
        result: {
          lines: [
            xrpLine({ currency: 'USD', balance: '123.456' }),
            xrpLine({ currency: XRP_TTL_HEX, balance: '0.000000000000001' }),
          ],
        },
      }),
    });
    const listed = await xrp.discoverTokens(XRP_OWNER);
    expect(listed).toHaveLength(2);
    for (const token of listed) {
      expect(await xrp.readToken(token.id, XRP_OWNER)).toEqual(token);
    }
  });

  it('발행자로 좁혀 묻는다 (같은 account_lines 명령, 같은 파서)', async () => {
    const xrp = new XrpAdapter();
    let seenPeer: unknown;
    installXrpClient(xrp, {
      request: async (req) => {
        seenPeer = req['peer'];
        return { result: { lines: [xrpLine({ currency: 'USD', balance: '1' })] } };
      },
    });
    await xrp.readToken(`USD.${XRP_ISSUER}`, XRP_OWNER);
    expect(seenPeer).toBe(XRP_ISSUER);
  });

  it('trust line 이 없어도 잔액 0 으로 등록한다', async () => {
    // XRPL 은 decimals 를 체인에서 읽는 값이 아니라 우리 고정 규약(15)이다.
    // 그래서 trust line 이 없어도 자릿수가 틀릴 위험이 없고, 아직 안 받은 토큰을
    // 미리 등록하는 것은 정상적인 사용이다.
    const xrp = new XrpAdapter();
    installXrpClient(xrp, { request: async () => ({ result: { lines: [] } }) });
    expect(await xrp.readToken(`USD.${XRP_ISSUER}`, XRP_OWNER)).toEqual({
      id: `USD.${XRP_ISSUER}`,
      symbol: 'USD',
      name: 'USD',
      decimals: XRP_ISSUED_DECIMALS,
      balance: 0n,
    });
  });

  it('계정이 아직 온체인에 없어도(actNotFound) 잔액 0 으로 등록한다', async () => {
    const xrp = new XrpAdapter();
    installXrpClient(xrp, {
      request: async () => {
        throw Object.assign(new Error('Account not found.'), {
          data: { error: 'actNotFound' },
        });
      },
    });
    const out = await xrp.readToken(`USD.${XRP_ISSUER}`, XRP_OWNER);
    expect(out!.balance).toBe(0n);
  });

  it('40-hex 통화 코드는 id 에 원본을 유지하고 symbol 만 사람이 읽는 형태로', async () => {
    const xrp = new XrpAdapter();
    installXrpClient(xrp, { request: async () => ({ result: { lines: [] } }) });
    const out = await xrp.readToken(`${XRP_TTL_HEX}.${XRP_ISSUER}`, XRP_OWNER);
    // id 를 예쁘게 바꾸면 송금 때 원본으로 되돌릴 수 없다.
    expect(out!.id).toBe(`${XRP_TTL_HEX}.${XRP_ISSUER}`);
    expect(out!.symbol).toBe('TTL');
  });

  it('빚진(음수) trust line 은 잔액 0 으로 등록한다', async () => {
    // balance 는 bigint 이고 음수를 담을 수 없다. 목록은 그 줄을 아예 빼지만,
    // 수동 추가는 사용자가 명시적으로 요청한 것이므로 메타를 채워 돌려준다.
    const xrp = new XrpAdapter();
    installXrpClient(xrp, {
      request: async () => ({
        result: { lines: [xrpLine({ currency: 'USD', balance: '-5' })] },
      }),
    });
    const out = await xrp.readToken(`USD.${XRP_ISSUER}`, XRP_OWNER);
    expect(out!.balance).toBe(0n);
    expect(out!.decimals).toBe(XRP_ISSUED_DECIMALS);
  });

  it('CUR.issuer 형식이 아니면 던진다 (송금과 같은 판별식)', async () => {
    const xrp = new XrpAdapter();
    installXrpClient(xrp, { request: async () => ({ result: { lines: [] } }) });
    const bad = [
      '',
      'USD', // 발행자 없음
      'USD.not-an-address', // 발행자 형식 오류
      `USDX.${XRP_ISSUER}`, // 3글자도 40-hex 도 아님
      `XRP.${XRP_ISSUER}`, // native 를 IOU 로 위장
    ];
    for (const id of bad) {
      await expect(xrp.readToken(id, XRP_OWNER)).rejects.toThrow(
        /unsupported token id/,
      );
    }
  });

  it('네트워크 오류는 삼키지 않고 던진다 (사용자가 요청한 동작이다)', async () => {
    const xrp = new XrpAdapter();
    installXrpClient(xrp, {
      request: async () => {
        throw new Error('ws down');
      },
    });
    await expect(xrp.readToken(`USD.${XRP_ISSUER}`, XRP_OWNER)).rejects.toThrow(
      /ws down/,
    );
  });
});
