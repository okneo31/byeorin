// sui-coins.test.ts — Sui Coin 자동 조회 + coin type 송금 (오브젝트 병합 포함).
//
// 전부 offline. tokens.test.ts 가 `adapter.client.readContract` 를 갈아끼우듯
// 여기서는 `adapter.client` 의 JSON-RPC 메서드 3 개만 갈아끼운다:
//   suix_getAllBalances / suix_getCoinMetadata / suix_getCoins
//
// `buildTransfer` 는 마지막에 `tx.build({client})` 로 가스 시세·오브젝트 해석을
// 위해 풀노드를 탄다. 그래서 명령 구성만 담당하는 private `buildTransferCommands`
// 를 직접 불러 검사한다 — 검사 대상은 "무슨 명령을 만들었나" 이지 직렬화가 아니다.

import { describe, expect, it } from 'vitest';
import { SuiAdapter } from '../src/chains/sui.js';
import { discoverPortableTokens, supportsTokens } from '../src/tokens/portable.js';
import type { Transaction } from '@mysten/sui/transactions';
import type { TransferIntent } from '../src/types.js';

const OWNER =
  '0xc88ef07b9b8b2fc3b7daad9478f4e1337f01792e2eab9c3794494e610636026e';
const TO = '0x00000000000000000000000000000000000000000000000000000000000000bb';

const SUI = '0x2::sui::SUI';
const SUI_FULL =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const USDC =
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
interface CoinStructLike {
  balance: string;
  coinObjectId: string;
  coinType: string;
  digest: string;
  previousTransaction: string;
  version: string;
}

/** SuiAdapter 내부의 private client 를 테스트에서 갈아끼우기 위한 창구. */
interface ClientSlot {
  client: {
    getAllBalances: (i: { owner: string }) => Promise<CoinBalanceLike[]>;
    getCoinMetadata: (i: {
      coinType: string;
    }) => Promise<CoinMetadataLike | null>;
    getCoins: (i: {
      owner: string;
      coinType: string;
      cursor?: string | null;
    }) => Promise<{
      data: CoinStructLike[];
      hasNextPage: boolean;
      nextCursor?: string | null;
    }>;
  };
}

function slot(adapter: SuiAdapter): ClientSlot['client'] {
  return (adapter as unknown as ClientSlot).client;
}

/** 명령 구성만 실행 (풀노드 왕복 없음). */
function commandsFor(
  adapter: SuiAdapter,
  intent: TransferIntent,
): Promise<Transaction> {
  const fn = (
    adapter as unknown as {
      buildTransferCommands(i: TransferIntent, s: string): Promise<Transaction>;
    }
  ).buildTransferCommands;
  return fn.call(adapter, intent, OWNER);
}

function kinds(tx: Transaction): string[] {
  return tx.getData().commands.map((c) => c.$kind);
}

/** 32바이트 정규형 오브젝트 ID (tx 입력이 정규화하므로 미리 맞춰 둔다). */
function objId(n: number): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

function coin(id: number, balance: bigint, coinType = USDC): CoinStructLike {
  return {
    balance: balance.toString(),
    coinObjectId: objId(id),
    coinType,
    digest: '11111111111111111111111111111111',
    previousTransaction: '11111111111111111111111111111111',
    version: '1',
  };
}

/** getCoins 를 한 페이지짜리 고정 목록으로 만든다. 호출 횟수도 센다. */
function patchCoins(
  adapter: SuiAdapter,
  coins: CoinStructLike[],
): { calls: number } {
  const counter = { calls: 0 };
  slot(adapter).getCoins = async () => {
    counter.calls += 1;
    return { data: coins, hasNextPage: false, nextCursor: null };
  };
  return counter;
}

function meta(
  symbol: string,
  decimals: number,
  name = symbol,
): CoinMetadataLike {
  return { symbol, decimals, name, description: '' };
}

/* ------------------------------------------------------------------ */
/* 조회                                                                */
/* ------------------------------------------------------------------ */

describe('SuiAdapter.discoverTokens', () => {
  it('TokenCapableAdapter 로 인식된다', () => {
    expect(supportsTokens(new SuiAdapter())).toBe(true);
  });

  it('getAllBalances 한 번 + coin type 별 metadata 로 목록을 만든다', async () => {
    const adapter = new SuiAdapter();
    let allBalancesCalls = 0;
    slot(adapter).getAllBalances = async ({ owner }) => {
      allBalancesCalls += 1;
      expect(owner).toBe(OWNER);
      return [
        {
          coinType: SUI_FULL,
          coinObjectCount: 3,
          totalBalance: '1234567890',
          lockedBalance: {},
        },
        {
          coinType: USDC,
          coinObjectCount: 2,
          totalBalance: '5000000',
          lockedBalance: {},
        },
      ];
    };
    slot(adapter).getCoinMetadata = async ({ coinType }) =>
      coinType === SUI_FULL ? meta('SUI', 9, 'Sui') : meta('USDC', 6, 'USD Coin');

    const out = await adapter.discoverTokens(OWNER);
    // 목록 조회는 딱 한 번 — 코인마다 잔액을 다시 묻지 않는다.
    expect(allBalancesCalls).toBe(1);
    expect(out).toEqual([
      {
        id: SUI_FULL,
        symbol: 'SUI',
        name: 'Sui',
        decimals: 9,
        balance: 1234567890n,
        source: 'sui:getCoinMetadata',
      },
      {
        id: USDC,
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        balance: 5000000n,
        source: 'sui:getCoinMetadata',
      },
    ]);
  });

  it('portable 계약(discoverPortableTokens)을 그대로 통과한다', async () => {
    const adapter = new SuiAdapter();
    slot(adapter).getAllBalances = async () => [
      { coinType: USDC, coinObjectCount: 1, totalBalance: '1', lockedBalance: {} },
    ];
    slot(adapter).getCoinMetadata = async () => meta('USDC', 6);
    expect(await discoverPortableTokens(adapter, OWNER)).toHaveLength(1);
  });

  it('id 를 그대로 intent.asset 에 넣으면 그 코인이 나간다', async () => {
    const adapter = new SuiAdapter();
    slot(adapter).getAllBalances = async () => [
      { coinType: USDC, coinObjectCount: 1, totalBalance: '900', lockedBalance: {} },
    ];
    slot(adapter).getCoinMetadata = async () => meta('USDC', 6);
    const [token] = await adapter.discoverTokens(OWNER);

    let askedFor: string | null = null;
    slot(adapter).getCoins = async ({ coinType }) => {
      askedFor = coinType;
      return { data: [coin(1, 900n)], hasNextPage: false, nextCursor: null };
    };
    await commandsFor(adapter, { to: TO, amount: 100n, asset: token!.id });
    expect(askedFor).toBe(USDC);
  });
});

describe('SuiAdapter.discoverTokens — metadata 를 못 얻을 때', () => {
  it('metadata 가 null 인 코인은 버린다 (decimals 추측 금지)', async () => {
    const adapter = new SuiAdapter();
    slot(adapter).getAllBalances = async () => [
      { coinType: SUI_FULL, coinObjectCount: 1, totalBalance: '10', lockedBalance: {} },
      { coinType: USDC, coinObjectCount: 1, totalBalance: '20', lockedBalance: {} },
    ];
    slot(adapter).getCoinMetadata = async ({ coinType }) =>
      coinType === SUI_FULL ? meta('SUI', 9) : null;

    const out = await adapter.discoverTokens(OWNER);
    expect(out.map((t) => t.id)).toEqual([SUI_FULL]);
  });

  it('metadata 조회가 던진 코인만 빠지고 나머지는 살아남는다', async () => {
    const adapter = new SuiAdapter();
    slot(adapter).getAllBalances = async () => [
      { coinType: SUI_FULL, coinObjectCount: 1, totalBalance: '10', lockedBalance: {} },
      { coinType: USDC, coinObjectCount: 1, totalBalance: '20', lockedBalance: {} },
    ];
    slot(adapter).getCoinMetadata = async ({ coinType }) => {
      if (coinType === USDC) throw new Error('no metadata object');
      return meta('SUI', 9);
    };
    const out = await adapter.discoverTokens(OWNER);
    expect(out.map((t) => t.id)).toEqual([SUI_FULL]);
  });

  it('decimals 가 정수가 아니면 버린다', async () => {
    const adapter = new SuiAdapter();
    slot(adapter).getAllBalances = async () => [
      { coinType: USDC, coinObjectCount: 1, totalBalance: '20', lockedBalance: {} },
    ];
    slot(adapter).getCoinMetadata = async () => meta('USDC', 6.5);
    expect(await adapter.discoverTokens(OWNER)).toEqual([]);
  });

  it('totalBalance 가 숫자가 아니면 버린다', async () => {
    const adapter = new SuiAdapter();
    slot(adapter).getAllBalances = async () => [
      { coinType: USDC, coinObjectCount: 1, totalBalance: 'oops', lockedBalance: {} },
    ];
    slot(adapter).getCoinMetadata = async () => meta('USDC', 6);
    expect(await adapter.discoverTokens(OWNER)).toEqual([]);
  });
});

describe('SuiAdapter.discoverTokens — 실패', () => {
  it('getAllBalances 가 던지면 빈 배열', async () => {
    const adapter = new SuiAdapter();
    slot(adapter).getAllBalances = async () => {
      throw new Error('rpc down');
    };
    expect(await adapter.discoverTokens(OWNER)).toEqual([]);
  });

  it('보유가 없으면 빈 배열', async () => {
    const adapter = new SuiAdapter();
    slot(adapter).getAllBalances = async () => [];
    expect(await adapter.discoverTokens(OWNER)).toEqual([]);
  });

  it('discoverPortableTokens 도 실패를 삼킨다', async () => {
    const adapter = new SuiAdapter();
    slot(adapter).getAllBalances = async () => {
      throw new Error('rpc down');
    };
    expect(await discoverPortableTokens(adapter, OWNER)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 송금 — native 회귀                                                   */
/* ------------------------------------------------------------------ */

describe('SuiAdapter.buildTransfer — native(SUI) 회귀 방지', () => {
  it('asset 없으면 가스 코인에서 split → transfer (예전 그대로)', async () => {
    const adapter = new SuiAdapter();
    const coins = patchCoins(adapter, []);
    const tx = await commandsFor(adapter, { to: TO, amount: 1000n });

    expect(kinds(tx)).toEqual(['SplitCoins', 'TransferObjects']);
    const split = tx.getData().commands[0]!;
    // 가스 코인에서 직접 쪼갠다 — 오브젝트 입력이 아니다.
    expect(split.SplitCoins!.coin.$kind).toBe('GasCoin');
    // 코인 오브젝트를 조회조차 하지 않는다 (RPC 왕복 0).
    expect(coins.calls).toBe(0);
  });

  it("asset 이 '0x2::sui::SUI' 여도 같은 가스 코인 경로", async () => {
    const adapter = new SuiAdapter();
    const coins = patchCoins(adapter, []);
    for (const asset of [SUI, SUI_FULL, '  ', '']) {
      const tx = await commandsFor(adapter, { to: TO, amount: 1000n, asset });
      expect(kinds(tx)).toEqual(['SplitCoins', 'TransferObjects']);
      expect(tx.getData().commands[0]!.SplitCoins!.coin.$kind).toBe('GasCoin');
    }
    expect(coins.calls).toBe(0);
  });

  it('coin type 문법이 아닌 asset 은 native 로 되돌리지 않고 던진다', async () => {
    const adapter = new SuiAdapter();
    patchCoins(adapter, []);
    for (const bad of ['erc20', 'ubtc', '0xdeadbeef']) {
      await expect(
        commandsFor(adapter, { to: TO, amount: 1n, asset: bad }),
      ).rejects.toThrow(/intent\.asset must be a coin type/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 송금 — coin type 분기 + 오브젝트 병합/분할                            */
/* ------------------------------------------------------------------ */

describe('SuiAdapter.buildTransfer — coin type 분기', () => {
  it('오브젝트 하나로 충분하면 병합 없이 split → transfer', async () => {
    const adapter = new SuiAdapter();
    patchCoins(adapter, [coin(1, 1000n)]);
    const tx = await commandsFor(adapter, { to: TO, amount: 400n, asset: USDC });

    expect(kinds(tx)).toEqual(['SplitCoins', 'TransferObjects']);
    // 가스 코인이 아니라 그 코인 오브젝트에서 쪼갠다.
    expect(tx.getData().commands[0]!.SplitCoins!.coin.$kind).toBe('Input');
    expect(tx.getData().inputs[0]).toMatchObject({
      $kind: 'UnresolvedObject',
      UnresolvedObject: { objectId: objId(1) },
    });
  });

  it('잔액은 충분한데 오브젝트가 쪼개져 있으면 merge 후 split', async () => {
    // 250 을 보내야 하는데 100 짜리 4 개. 코인 하나만 집으면 실패하는 상황.
    const adapter = new SuiAdapter();
    patchCoins(adapter, [
      coin(1, 100n),
      coin(2, 100n),
      coin(3, 100n),
      coin(4, 100n),
    ]);
    const tx = await commandsFor(adapter, { to: TO, amount: 250n, asset: USDC });

    expect(kinds(tx)).toEqual(['MergeCoins', 'SplitCoins', 'TransferObjects']);
    const merge = tx.getData().commands[0]!.MergeCoins!;
    // 250 을 채우는 데 3 개면 충분 — 남는 1 개는 건드리지 않는다.
    expect(merge.sources).toHaveLength(2);
  });

  it('큰 오브젝트부터 집어 병합 개수를 줄인다', async () => {
    const adapter = new SuiAdapter();
    // 작은 것이 앞에 오도록 일부러 뒤섞어 준다.
    patchCoins(adapter, [
      coin(1, 1n),
      coin(2, 1n),
      coin(3, 500n),
      coin(4, 1n),
    ]);
    const tx = await commandsFor(adapter, { to: TO, amount: 400n, asset: USDC });
    // 500 짜리 하나로 끝 — merge 자체가 없다.
    expect(kinds(tx)).toEqual(['SplitCoins', 'TransferObjects']);
    expect(tx.getData().inputs[0]).toMatchObject({
      UnresolvedObject: { objectId: objId(3) },
    });
  });

  it('금액이 딱 떨어지면 split 없이 합친 코인을 그대로 보낸다', async () => {
    const adapter = new SuiAdapter();
    patchCoins(adapter, [coin(1, 100n), coin(2, 200n)]);
    const tx = await commandsFor(adapter, { to: TO, amount: 300n, asset: USDC });
    // 잔액 0 짜리 코인 찌꺼기를 만들지 않는다.
    expect(kinds(tx)).toEqual(['MergeCoins', 'TransferObjects']);
  });

  it('오브젝트 하나가 금액과 정확히 같으면 명령은 transfer 하나', async () => {
    const adapter = new SuiAdapter();
    patchCoins(adapter, [coin(1, 300n)]);
    const tx = await commandsFor(adapter, { to: TO, amount: 300n, asset: USDC });
    expect(kinds(tx)).toEqual(['TransferObjects']);
  });

  it('getCoins 페이지를 커서 따라 전부 모은다', async () => {
    const adapter = new SuiAdapter();
    const pages: Record<string, CoinStructLike[]> = {
      start: [coin(1, 100n)],
      p2: [coin(2, 100n)],
      p3: [coin(3, 100n)],
    };
    slot(adapter).getCoins = async ({ cursor }) => {
      if (cursor === undefined || cursor === null) {
        return { data: pages['start']!, hasNextPage: true, nextCursor: 'p2' };
      }
      if (cursor === 'p2') {
        return { data: pages['p2']!, hasNextPage: true, nextCursor: 'p3' };
      }
      return { data: pages['p3']!, hasNextPage: false, nextCursor: null };
    };
    // 300 은 세 페이지를 다 봐야만 채워진다.
    const tx = await commandsFor(adapter, { to: TO, amount: 300n, asset: USDC });
    expect(kinds(tx)).toEqual(['MergeCoins', 'TransferObjects']);
    expect(tx.getData().commands[0]!.MergeCoins!.sources).toHaveLength(2);
  });

  it('오브젝트가 하나도 없으면 명확히 던진다', async () => {
    const adapter = new SuiAdapter();
    patchCoins(adapter, []);
    await expect(
      commandsFor(adapter, { to: TO, amount: 1n, asset: USDC }),
    ).rejects.toThrow(/no .*::usdc::USDC coin objects owned by/);
  });

  it('전부 합쳐도 모자라면 have/need 를 밝혀 던진다', async () => {
    const adapter = new SuiAdapter();
    patchCoins(adapter, [coin(1, 100n), coin(2, 50n)]);
    await expect(
      commandsFor(adapter, { to: TO, amount: 300n, asset: USDC }),
    ).rejects.toThrow(/insufficient .*have 150, need 300/);
  });

  it('상한(256개)을 넘게 조각나면 "부족" 이 아니라 "조각남" 으로 알린다', async () => {
    const adapter = new SuiAdapter();
    // 1 짜리 300 개 = 총 300. 금액도 300 이라 잔액은 충분하지만 256 개까지만
    // 합칠 수 있어 못 채운다. 사용자가 원인을 알아야 조치할 수 있다.
    patchCoins(
      adapter,
      Array.from({ length: 300 }, (_, i) => coin(i + 1, 1n)),
    );
    await expect(
      commandsFor(adapter, { to: TO, amount: 300n, asset: USDC }),
    ).rejects.toThrow(/split across too many coin objects/);
  });

  it('상한 안이면 많은 조각도 처리한다', async () => {
    const adapter = new SuiAdapter();
    patchCoins(
      adapter,
      Array.from({ length: 300 }, (_, i) => coin(i + 1, 1n)),
    );
    const tx = await commandsFor(adapter, { to: TO, amount: 200n, asset: USDC });
    expect(kinds(tx)).toEqual(['MergeCoins', 'TransferObjects']);
    expect(tx.getData().commands[0]!.MergeCoins!.sources).toHaveLength(199);
  });

  it('금액이 0 이하면 던진다', async () => {
    const adapter = new SuiAdapter();
    patchCoins(adapter, [coin(1, 100n)]);
    await expect(
      commandsFor(adapter, { to: TO, amount: 0n, asset: USDC }),
    ).rejects.toThrow(/amount must be positive/);
  });
});
