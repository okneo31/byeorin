import { describe, expect, it } from 'vitest';
import {
  ZionAmmClient,
  ZION_AMM_DEFAULT_SLIPPAGE_BPS,
  ZION_AMM_MSG_SWAP_TYPE_URL,
  type ZionPool,
} from '../src/chains/zion-amm.js';

const utrgUbtcPool: ZionPool = {
  id: 1n,
  denomA: 'utrg',
  denomB: 'ubtc',
  reserveA: 10_000_000n, // 10 kWR
  reserveB: 1_000_000n,  //  0.01 BTC
  feeBps: 30,            // 0.30%
};

describe('ZionAmmClient.quote — math', () => {
  const client = new ZionAmmClient();

  it('applies Tier-2 burn (1/180) then fee_bps then x*y=k', () => {
    // amountIn = 180_000 utrg → burn = 180_000 / 180 = 1_000
    //   inAfterBurn = 179_000
    //   fee = 179_000 * 30 / 10000 = 537
    //   inEffective = 179_000 - 537 = 178_463
    //   amountOut = 1_000_000 * 178_463 / (10_000_000 + 178_463)
    //            ≈ 17_532  (floor)
    //   minOut (0.5%) = 17_532 * 9950 / 10000 = 17_444
    const q = client.quote(utrgUbtcPool, 180_000n, 'ubtc');
    expect(q.burnTotal).toBe(1_000n);
    expect(q.feeTotal).toBe(537n);
    expect(q.inEffective).toBe(178_463n);
    // Recompute the floor-divided x*y=k expected value
    const expectedOut = (1_000_000n * 178_463n) / (10_000_000n + 178_463n);
    expect(q.amountOutEst).toBe(expectedOut);
    expect(q.minAmountOut).toBe((expectedOut * 9950n) / 10000n);
  });

  it('quote direction is symmetric — ubtc → utrg uses the other reserves', () => {
    const q = client.quote(utrgUbtcPool, 100_000n, 'utrg');
    // burn = 100_000 / 180 = 555  →  inAfterBurn = 99_445
    // fee  = 99_445 * 30 / 10000 = 298
    // inEffective = 99_445 - 298 = 99_147
    // amountOut = 10_000_000 * 99_147 / (1_000_000 + 99_147) = ?
    const expectedOut = (10_000_000n * 99_147n) / (1_000_000n + 99_147n);
    expect(q.burnTotal).toBe(555n);
    expect(q.feeTotal).toBe(298n);
    expect(q.amountOutEst).toBe(expectedOut);
  });

  it('rejects amountIn <= 0', () => {
    expect(() => client.quote(utrgUbtcPool, 0n, 'ubtc')).toThrow(
      /must be positive/,
    );
    expect(() => client.quote(utrgUbtcPool, -1n, 'ubtc')).toThrow(
      /must be positive/,
    );
  });

  it('rejects denomOut not on the pool', () => {
    expect(() => client.quote(utrgUbtcPool, 1000n, 'uusdt')).toThrow(
      /not a side of pool/,
    );
  });

  it('rejects empty-reserve pools', () => {
    const empty: ZionPool = { ...utrgUbtcPool, reserveA: 0n };
    expect(() => client.quote(empty, 1000n, 'ubtc')).toThrow(/empty reserves/);
  });

  it('slippage override changes only minAmountOut', () => {
    const base = client.quote(utrgUbtcPool, 180_000n, 'ubtc');
    const tight = client.quote(utrgUbtcPool, 180_000n, 'ubtc', 10); // 0.10%
    expect(tight.amountOutEst).toBe(base.amountOutEst);
    expect(tight.minAmountOut).toBe(
      (base.amountOutEst * (10000n - 10n)) / 10000n,
    );
    expect(tight.minAmountOut).toBeGreaterThan(base.minAmountOut);
  });

  it('rejects out-of-range slippageBps', () => {
    expect(() =>
      client.quote(utrgUbtcPool, 1000n, 'ubtc', -1),
    ).toThrow(/slippageBps/);
    expect(() =>
      client.quote(utrgUbtcPool, 1000n, 'ubtc', 10001),
    ).toThrow(/slippageBps/);
  });

  it('zero-slippage gives minAmountOut == amountOutEst', () => {
    const q = client.quote(utrgUbtcPool, 180_000n, 'ubtc', 0);
    expect(q.minAmountOut).toBe(q.amountOutEst);
  });
});

describe('ZionAmmClient.listPools — REST parsing', () => {
  it('maps zion-api AMMPool DTO → ZionPool, parses bigints from strings', async () => {
    const fakeFetch = async (_url: string): Promise<Response> =>
      new Response(
        JSON.stringify({
          source: 'indexer',
          pools: [
            {
              id: 1,
              denom_a: 'utrg',
              denom_b: 'ubtc',
              reserve_a: '10000000',
              reserve_b: '1000000',
              fee_bps: 30,
            },
            {
              id: '42',
              denom_a: 'utrg',
              denom_b: 'uusdt',
              reserve_a: '99999999999999999',
              reserve_b: '88888888888888888',
              fee_bps: 50,
            },
          ],
        }),
        { status: 200 },
      );
    const client = new ZionAmmClient({ fetch: fakeFetch as typeof fetch });
    const pools = await client.listPools();
    expect(pools).toHaveLength(2);
    expect(pools[0]).toEqual({
      id: 1n,
      denomA: 'utrg',
      denomB: 'ubtc',
      reserveA: 10_000_000n,
      reserveB: 1_000_000n,
      feeBps: 30,
    });
    expect(pools[1]!.id).toBe(42n);
    // Past Number.MAX_SAFE_INTEGER — must survive intact as bigint.
    expect(pools[1]!.reserveA).toBe(99_999_999_999_999_999n);
  });

  it('throws with status info when API returns non-2xx', async () => {
    const fakeFetch = async () =>
      new Response('upstream down', {
        status: 503,
        statusText: 'Service Unavailable',
      });
    const client = new ZionAmmClient({ fetch: fakeFetch as typeof fetch });
    await expect(client.listPools()).rejects.toThrow(/503/);
  });
});

describe('ZionAmmClient.findPool — order-agnostic + deepest preferred', () => {
  it('matches either denom order', async () => {
    const pools = [
      {
        id: 1,
        denom_a: 'utrg',
        denom_b: 'ubtc',
        reserve_a: '10',
        reserve_b: '10',
        fee_bps: 30,
      },
    ];
    const fakeFetch = async () =>
      new Response(JSON.stringify({ pools }), { status: 200 });
    const client = new ZionAmmClient({ fetch: fakeFetch as typeof fetch });
    const fwd = await client.findPool('utrg', 'ubtc');
    const rev = await client.findPool('ubtc', 'utrg');
    expect(fwd?.id).toBe(1n);
    expect(rev?.id).toBe(1n);
  });

  it('prefers the deepest pool when multiple match', async () => {
    const pools = [
      { id: 1, denom_a: 'utrg', denom_b: 'ubtc', reserve_a: '10', reserve_b: '10', fee_bps: 30 },
      { id: 2, denom_a: 'ubtc', denom_b: 'utrg', reserve_a: '1000000', reserve_b: '1000000', fee_bps: 30 },
      { id: 3, denom_a: 'utrg', denom_b: 'ubtc', reserve_a: '100', reserve_b: '100', fee_bps: 30 },
    ];
    const fakeFetch = async () =>
      new Response(JSON.stringify({ pools }), { status: 200 });
    const client = new ZionAmmClient({ fetch: fakeFetch as typeof fetch });
    const best = await client.findPool('utrg', 'ubtc');
    expect(best?.id).toBe(2n);
  });

  it('returns undefined when same denom passed twice', async () => {
    const client = new ZionAmmClient({
      fetch: (async () =>
        new Response(JSON.stringify({ pools: [] }), { status: 200 })) as typeof fetch,
    });
    expect(await client.findPool('utrg', 'utrg')).toBeUndefined();
  });
});

describe('ZionAmmClient.buildSwapMessage', () => {
  const client = new ZionAmmClient();

  it('produces a MsgSwap message with correct typeUrl and denom plumbing', () => {
    const msg = client.buildSwapMessage({
      swapper: 'zion1abc',
      pool: utrgUbtcPool,
      amountIn: 180_000n,
      denomOut: 'ubtc',
    });
    expect(msg.typeUrl).toBe(ZION_AMM_MSG_SWAP_TYPE_URL);
    expect(msg.value.swapper).toBe('zion1abc');
    expect(msg.value.poolId).toBe(1n);
    expect(msg.value.amountIn).toEqual({ denom: 'utrg', amount: '180000' });
    expect(msg.value.denomOut).toBe('ubtc');
    // Default slippage = 50 bps applied
    const expectedOut = (1_000_000n * 178_463n) / (10_000_000n + 178_463n);
    const expectedMin = (expectedOut * 9950n) / 10000n;
    expect(msg.value.minAmountOut).toBe(expectedMin.toString());
  });

  it('accepts a pre-computed quote to lock the slippage floor', () => {
    const q = client.quote(utrgUbtcPool, 180_000n, 'ubtc');
    const msg = client.buildSwapMessage({
      swapper: 'zion1abc',
      pool: utrgUbtcPool,
      amountIn: 180_000n,
      denomOut: 'ubtc',
      quote: q,
    });
    expect(msg.value.minAmountOut).toBe(q.minAmountOut.toString());
  });
});

describe('ZionAmmClient — constants', () => {
  it('default slippage is 50 bps (0.5%)', () => {
    expect(ZION_AMM_DEFAULT_SLIPPAGE_BPS).toBe(50);
    expect(new ZionAmmClient().slippageBps).toBe(50);
  });
});
