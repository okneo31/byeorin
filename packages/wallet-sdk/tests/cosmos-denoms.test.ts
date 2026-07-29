// cosmos-denoms.test.ts — Cosmos denom 자동 조회 + denom 송금.
//
// 전부 offline. 네트워크를 타는 지점은 두 곳뿐이라 그 둘만 갈아끼운다:
//   조회 → `adapter.getAllBalances` (StargateClient 1회 호출을 감싼 메서드)
//   송금 → `adapter.buildTx`        (계정 조회 + 인코딩)
// tokens.test.ts 가 `adapter.client.readContract` 를 갈아끼우는 것과 같은 방식이다.

import { describe, expect, it } from 'vitest';
import { CosmosAdapter } from '../src/chains/cosmos.js';
import { discoverPortableTokens, supportsTokens } from '../src/tokens/portable.js';
import type { CosmosUnsignedTx } from '../src/chains/cosmos.js';
import type { TxContext } from '../src/chains/chain.js';

type Coin = { denom: string; amount: bigint };

/** ZION Phase 1 어댑터 — multichain 의 ZION_CHAIN_SPEC 과 같은 값. */
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

/** `getAllBalances` 를 결정적으로 만든다. */
function patchBalances(
  adapter: CosmosAdapter,
  impl: (address: string) => Promise<Coin[]>,
): void {
  adapter.getAllBalances = impl;
}

/**
 * `buildTx` 를 가로채 메시지만 잡아둔다. 반환값은 서명 파이프라인이 쓰지만
 * 이 스위트는 "무엇을 보내려 했는가" 만 보므로 껍데기로 충분하다.
 */
function captureBuildTx(adapter: CosmosAdapter): {
  messages: Array<{ typeUrl: string; value: unknown }>;
  memos: Array<string | undefined>;
} {
  const messages: Array<{ typeUrl: string; value: unknown }> = [];
  const memos: Array<string | undefined> = [];
  adapter.buildTx = async (msgs, _ctx, opts) => {
    messages.push(...msgs.map((m) => ({ typeUrl: m.typeUrl, value: m.value })));
    memos.push(opts?.memo);
    return {} as CosmosUnsignedTx;
  };
  return { messages, memos };
}

const STUB_CTX = {
  sender: 'zion1sender',
  signer: { publicKey: async () => new Uint8Array(33) },
} as unknown as TxContext;

/** MsgSend 의 amount[0] 을 꺼낸다. */
function sentCoin(value: unknown): { denom: string; amount: string } {
  const v = value as { amount: Array<{ denom: string; amount: string }> };
  return v.amount[0]!;
}

/* ------------------------------------------------------------------ */
/* 조회                                                                */
/* ------------------------------------------------------------------ */

describe('CosmosAdapter.discoverTokens — ZION 4종', () => {
  it('TokenCapableAdapter 로 인식된다', () => {
    expect(supportsTokens(zionAdapter())).toBe(true);
  });

  it('4종을 ZionWallet.MD 명세와 같은 decimals 로 돌려준다', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [
      { denom: 'utrg', amount: 1_500_000n },
      { denom: 'ubtc', amount: 250_000_000n },
      { denom: 'uusdt', amount: 42_000_000n },
      { denom: 'ueth', amount: 7_000_000n },
    ]);

    const out = await adapter.discoverTokens('zion1abc');
    expect(out.map((t) => [t.id, t.symbol, t.decimals])).toEqual([
      ['utrg', 'kWR', 6],
      // ubtc 는 8 — `u` 접두를 6 으로 유추하면 1억배 틀린다.
      ['ubtc', 'BTC', 8],
      ['uusdt', 'USDT', 6],
      // ueth 는 6 — 표준 ETH 의 18 이 아니다 (ZionWallet.MD §"ueth decimals 6").
      ['ueth', 'ETH', 6],
    ]);
    expect(out.map((t) => t.balance)).toEqual([
      1_500_000n,
      250_000_000n,
      42_000_000n,
      7_000_000n,
    ]);
  });

  it('native denom(utrg)도 목록에 포함한다', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [{ denom: 'utrg', amount: 1n }]);
    const out = await adapter.discoverTokens('zion1abc');
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('utrg');
  });

  it('portable 계약(discoverPortableTokens)을 그대로 통과한다', async () => {
    // decimals/balance 가 계약 위반이면 여기서 조용히 걸러진다 — 4종 다
    // 살아남아야 값이 유효하다는 뜻.
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [
      { denom: 'utrg', amount: 1n },
      { denom: 'ubtc', amount: 2n },
      { denom: 'uusdt', amount: 3n },
      { denom: 'ueth', amount: 4n },
    ]);
    const out = await discoverPortableTokens(adapter, 'zion1abc');
    expect(out).toHaveLength(4);
  });

  it('id 를 그대로 intent.asset 에 넣으면 그 denom 이 나간다', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [{ denom: 'ubtc', amount: 500n }]);
    const [token] = await adapter.discoverTokens('zion1abc');
    const cap = captureBuildTx(adapter);

    await adapter.buildTransfer(
      { to: 'zion1dst', amount: 100n, asset: token!.id },
      STUB_CTX,
    );
    expect(sentCoin(cap.messages[0]!.value).denom).toBe('ubtc');
  });
});

describe('CosmosAdapter.discoverTokens — decimals 를 모르는 denom', () => {
  it('모르는 denom 은 버린다 (6 으로 추측하지 않는다)', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [
      { denom: 'utrg', amount: 1_000_000n },
      { denom: 'umystery', amount: 999n },
      { denom: 'factory/zion1xyz/foo', amount: 5n },
    ]);
    const out = await adapter.discoverTokens('zion1abc');
    expect(out.map((t) => t.id)).toEqual(['utrg']);
  });

  it('ibc/... denom 도 알려주지 않으면 버린다', async () => {
    const ibc =
      'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2';
    const adapter = zionAdapter();
    patchBalances(adapter, async () => [
      { denom: 'utrg', amount: 1n },
      { denom: ibc, amount: 77n },
    ]);
    expect((await adapter.discoverTokens('zion1abc')).map((t) => t.id)).toEqual([
      'utrg',
    ]);
  });

  it('denomMetadata 로 알려주면 ibc/... denom 도 나온다', async () => {
    const ibc =
      'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2';
    const adapter = zionAdapter({
      [ibc]: { symbol: 'ATOM', name: 'Cosmos Hub ATOM (IBC)', decimals: 6 },
    });
    patchBalances(adapter, async () => [{ denom: ibc, amount: 77n }]);
    const out = await adapter.discoverTokens('zion1abc');
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(ibc);
    expect(out[0]!.symbol).toBe('ATOM');
    expect(out[0]!.decimals).toBe(6);
    expect(out[0]!.source).toBe('cosmos:denomMetadata-option');
  });

  it('denomMetadata 가 내장 표를 이긴다 (코드 수정 없이 바로잡을 길)', async () => {
    const adapter = zionAdapter({
      ueth: { symbol: 'ETH', name: 'Ethereum', decimals: 18 },
    });
    patchBalances(adapter, async () => [{ denom: 'ueth', amount: 1n }]);
    const out = await adapter.discoverTokens('zion1abc');
    expect(out[0]!.decimals).toBe(18);
    expect(out[0]!.source).toBe('cosmos:denomMetadata-option');
  });

  it('decimals 가 정수가 아닌 denomMetadata 항목은 무시한다', async () => {
    const adapter = zionAdapter({
      ubogus: { symbol: 'BOGUS', decimals: 6.5 },
      ubad: { symbol: 'BAD', decimals: -1 },
    });
    patchBalances(adapter, async () => [
      { denom: 'ubogus', amount: 1n },
      { denom: 'ubad', amount: 1n },
    ]);
    expect(await adapter.discoverTokens('zion1abc')).toEqual([]);
  });

  it('내장 표가 없는 체인은 native denom 만 안다', async () => {
    const hub = new CosmosAdapter({
      chainId: 'cosmoshub-4',
      bech32Prefix: 'cosmos',
      rpcUrl: 'http://localhost',
      denom: 'uatom',
    });
    // ZION 표가 다른 체인으로 새지 않는다 — ubtc 의 8 은 ZION 값이지 보편값이 아니다.
    expect(hub.knownDenoms()).toEqual(['uatom']);
    patchBalances(hub, async () => [
      { denom: 'uatom', amount: 1_000_000n },
      { denom: 'ubtc', amount: 1n },
    ]);
    const out = await hub.discoverTokens('cosmos1abc');
    expect(out.map((t) => t.id)).toEqual(['uatom']);
    expect(out[0]!.decimals).toBe(6);
    expect(out[0]!.source).toBe('cosmos:adapter-config');
  });
});

describe('CosmosAdapter.discoverTokens — 실패', () => {
  it('조회가 던지면 빈 배열 (지갑이 안 열리면 안 된다)', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => {
      throw new Error('rpc down');
    });
    expect(await adapter.discoverTokens('zion1abc')).toEqual([]);
  });

  it('보유가 없으면 빈 배열', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => []);
    expect(await adapter.discoverTokens('zion1abc')).toEqual([]);
  });

  it('discoverPortableTokens 도 실패를 삼킨다', async () => {
    const adapter = zionAdapter();
    patchBalances(adapter, async () => {
      throw new Error('rpc down');
    });
    expect(await discoverPortableTokens(adapter, 'zion1abc')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 송금 — asset 분기                                                    */
/* ------------------------------------------------------------------ */

describe('CosmosAdapter.buildTransfer — asset 분기', () => {
  it('asset 없으면 native denom (기존 경로 회귀 방지)', async () => {
    const adapter = zionAdapter();
    const cap = captureBuildTx(adapter);
    await adapter.buildTransfer({ to: 'zion1dst', amount: 1_000_000n }, STUB_CTX);

    expect(cap.messages).toHaveLength(1);
    expect(cap.messages[0]!.typeUrl).toBe('/cosmos.bank.v1beta1.MsgSend');
    expect(cap.messages[0]!.value).toEqual({
      fromAddress: 'zion1sender',
      toAddress: 'zion1dst',
      amount: [{ denom: 'utrg', amount: '1000000' }],
    });
    expect(cap.memos[0]).toBeUndefined();
  });

  it('asset 이 빈 문자열/공백이어도 native (되돌림이 안전한 유일한 경우)', async () => {
    const adapter = zionAdapter();
    const cap = captureBuildTx(adapter);
    await adapter.buildTransfer(
      { to: 'zion1dst', amount: 1n, asset: '   ' },
      STUB_CTX,
    );
    expect(sentCoin(cap.messages[0]!.value).denom).toBe('utrg');
  });

  it('asset 이 denom 이면 그 denom 으로 나간다 (ZION 4종)', async () => {
    for (const denom of ['utrg', 'ubtc', 'uusdt', 'ueth']) {
      const adapter = zionAdapter();
      const cap = captureBuildTx(adapter);
      await adapter.buildTransfer(
        { to: 'zion1dst', amount: 123n, asset: denom },
        STUB_CTX,
      );
      expect(sentCoin(cap.messages[0]!.value)).toEqual({
        denom,
        amount: '123',
      });
    }
  });

  it('내장 표에 없는 denom 도 보낼 수 있다 (조회 ≠ 송금 제약)', async () => {
    const ibc =
      'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2';
    const adapter = zionAdapter();
    const cap = captureBuildTx(adapter);
    await adapter.buildTransfer(
      { to: 'zion1dst', amount: 5n, asset: ibc },
      STUB_CTX,
    );
    expect(sentCoin(cap.messages[0]!.value).denom).toBe(ibc);
  });

  it('memo 는 asset 유무와 무관하게 그대로 실린다', async () => {
    const adapter = zionAdapter();
    const cap = captureBuildTx(adapter);
    await adapter.buildTransfer(
      { to: 'zion1dst', amount: 1n, asset: 'ubtc', memo: 'hello' },
      STUB_CTX,
    );
    expect(cap.memos[0]).toBe('hello');
  });

  it('denom 문법이 아닌 asset 은 native 로 되돌리지 않고 던진다', async () => {
    const adapter = zionAdapter();
    captureBuildTx(adapter);
    for (const bad of ['0xdeadbeef', '1utrg', 'ab', 'has space']) {
      await expect(
        adapter.buildTransfer(
          { to: 'zion1dst', amount: 1n, asset: bad },
          STUB_CTX,
        ),
      ).rejects.toThrow(/intent\.asset must be a denom/);
    }
  });

  it("EVM 용 마커('erc20')가 흘러들어와도 native 로 나가지 않는다", async () => {
    // 'erc20' 은 Cosmos denom 문법을 통과하므로 던지진 않지만, 중요한 건
    // **utrg 로 둔갑하지 않는 것** 이다. 존재하지 않는 denom 이라 broadcast 에서
    // 실패한다 — 사용자가 의도하지 않은 자산이 나가는 것보다 낫다.
    const adapter = zionAdapter();
    const cap = captureBuildTx(adapter);
    await adapter.buildTransfer(
      { to: 'zion1dst', amount: 1n, asset: 'erc20' },
      STUB_CTX,
    );
    expect(sentCoin(cap.messages[0]!.value).denom).not.toBe('utrg');
  });
});
