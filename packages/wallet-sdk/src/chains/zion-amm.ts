// zion-amm.ts — ZION AMM client.
//
// What it does (and only this):
//   1. lists / finds pools via the zion-api REST indexer
//   2. computes a constant-product swap quote (x*y=k) plus burn/fee deductions
//   3. produces a ready-to-encode MsgSwap message
//
// What it doesn't do:
//   - sign / broadcast — the caller passes the message into
//     CosmosAdapter.buildTx(...) for the standard signing pipeline.
//   - liquidity provision, create-pool, multi-hop routing.
//
// Phase-1 reality check: zion-api `/v1/amm/quote` returns 501. We must price
// the swap on the client. Math mirrors chain swap.go (Tier-2 burn 1/180, then
// fee_bps, then x*y=k). Our quote may be off by 1 base-unit due to rounding;
// the 0.5% slippage floor absorbs that and any in-flight reserve drift.
//
// See ZionWallet.MD §9 (custom message types) and §10 (HTTP API).

import {
  encodeMsgSwap,
  ZION_AMM_MSG_SWAP_TYPE_URL,
  ZION_AMM_TYPES,
  type MsgSwapValue,
} from './zion-amm-codec.js';

export const ZION_API_BASE = 'https://api.zion1.top';

/** Default-slippage in basis points (1 bp = 0.01%). 50 bps = 0.5%. */
export const ZION_AMM_DEFAULT_SLIPPAGE_BPS = 50;

/** Tier-2 burn denominator: 1/180 of input is burned (chain swap.go). */
const TIER2_BURN_DENOM = 180n;

/** ZION AMM pool, normalized from zion-api's `AMMPool` DTO. */
export interface ZionPool {
  id: bigint;
  denomA: string;
  denomB: string;
  reserveA: bigint;
  reserveB: bigint;
  feeBps: number;
}

/** Result of `ZionAmmClient.quote(...)`. */
export interface ZionSwapQuote {
  /** Best-guess client-side estimate of received amount (base-units). */
  amountOutEst: bigint;
  /** Slippage-protected floor passed on-chain as `min_amount_out`. */
  minAmountOut: bigint;
  /** Portion of input burned (Tier-2 = 1/180). */
  burnTotal: bigint;
  /** Pool fee withheld from post-burn input. */
  feeTotal: bigint;
  /** Amount actually applied to the x*y=k formula. */
  inEffective: bigint;
}

export interface ZionAmmClientOptions {
  /** Override API base, e.g. for testnets or local stubs. */
  apiBase?: string;
  /** Default slippage in basis points. Falls back to 50 (= 0.5%). */
  slippageBps?: number;
  /** Inject a custom fetcher (testing / Node polyfills). */
  fetch?: typeof fetch;
}

/** Raw shape of `AMMPool` returned by zion-api. */
interface RawAmmPool {
  id: number | string;
  denom_a: string;
  denom_b: string;
  reserve_a: string;
  reserve_b: string;
  fee_bps: number;
}

/** Envelope returned by `GET /v1/amm/pools`. */
interface PoolsEnvelope {
  source?: 'indexer' | 'chain';
  pools: RawAmmPool[];
  limit?: number;
  offset?: number;
}

/**
 * ZION AMM client. Stateless — safe to instantiate per-render in the UI.
 */
export class ZionAmmClient {
  readonly apiBase: string;
  readonly slippageBps: number;
  private readonly fetcher: typeof fetch;

  constructor(opts: ZionAmmClientOptions = {}) {
    this.apiBase = opts.apiBase ?? ZION_API_BASE;
    this.slippageBps = opts.slippageBps ?? ZION_AMM_DEFAULT_SLIPPAGE_BPS;
    this.fetcher = opts.fetch ?? fetch;
  }

  /** GET /v1/amm/pools — paginated pool list. */
  async listPools(limit = 50): Promise<ZionPool[]> {
    const url = `${this.apiBase}/v1/amm/pools?limit=${limit}`;
    const res = await this.fetcher(url);
    if (!res.ok) {
      throw new Error(`zion-amm: listPools failed ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as PoolsEnvelope;
    return data.pools.map(parsePool);
  }

  /**
   * Find a pool that contains both denoms (order-agnostic). Returns the
   * first matching pool — Phase-1 has no canonical multi-pool routing, so
   * if multiple pools exist for the same pair, the caller should pick by
   * reserves (largest is the convention here).
   */
  async findPool(denomA: string, denomB: string): Promise<ZionPool | undefined> {
    if (denomA === denomB) return undefined;
    const pools = await this.listPools();
    const matches = pools.filter(
      (p) =>
        (p.denomA === denomA && p.denomB === denomB) ||
        (p.denomA === denomB && p.denomB === denomA),
    );
    if (matches.length === 0) return undefined;
    // Prefer the deepest pool — better price for the same trade.
    return matches.reduce((best, p) =>
      p.reserveA + p.reserveB > best.reserveA + best.reserveB ? p : best,
    );
  }

  /**
   * Constant-product swap quote with chain-accurate deductions.
   *
   * Order (matches D:\Zion\chain\x\amm\keeper\swap.go):
   *   1. burn = amountIn / 180                       (Tier-2 burn, floor)
   *   2. inAfterBurn = amountIn - burn
   *   3. fee = inAfterBurn * fee_bps / 10000         (floor)
   *   4. inEffective = inAfterBurn - fee
   *   5. amountOut = reserveOut * inEffective / (reserveIn + inEffective)  (floor)
   *   6. minAmountOut = amountOut * (10000 - slippageBps) / 10000           (floor)
   *
   * If amountIn ≤ 0 or denomOut isn't a side of the pool, throws.
   */
  quote(
    pool: ZionPool,
    amountIn: bigint,
    denomOut: string,
    slippageBpsOverride?: number,
  ): ZionSwapQuote {
    if (amountIn <= 0n) {
      throw new Error('zion-amm: amountIn must be positive');
    }
    const denomIn =
      denomOut === pool.denomA
        ? pool.denomB
        : denomOut === pool.denomB
          ? pool.denomA
          : undefined;
    if (denomIn === undefined) {
      throw new Error(
        `zion-amm: denomOut '${denomOut}' is not a side of pool ${pool.id}`,
      );
    }
    const reserveIn = denomIn === pool.denomA ? pool.reserveA : pool.reserveB;
    const reserveOut = denomIn === pool.denomA ? pool.reserveB : pool.reserveA;
    if (reserveIn <= 0n || reserveOut <= 0n) {
      throw new Error(`zion-amm: pool ${pool.id} has empty reserves`);
    }

    const burnTotal = amountIn / TIER2_BURN_DENOM;
    const inAfterBurn = amountIn - burnTotal;
    const feeTotal = (inAfterBurn * BigInt(pool.feeBps)) / 10000n;
    const inEffective = inAfterBurn - feeTotal;
    const amountOutEst =
      (reserveOut * inEffective) / (reserveIn + inEffective);

    const slip = BigInt(slippageBpsOverride ?? this.slippageBps);
    if (slip < 0n || slip > 10000n) {
      throw new Error('zion-amm: slippageBps must be within [0, 10000]');
    }
    const minAmountOut = (amountOutEst * (10000n - slip)) / 10000n;

    return { amountOutEst, minAmountOut, burnTotal, feeTotal, inEffective };
  }

  /**
   * Build a `/zion.amm.v1.MsgSwap` message suitable for
   * `CosmosAdapter.buildTx([msg], ctx)`. The adapter must have been
   * constructed with `customMsgTypes: ZION_AMM_TYPES`.
   */
  buildSwapMessage(args: {
    swapper: string;
    pool: ZionPool;
    amountIn: bigint;
    denomOut: string;
    /** Caller may pass a pre-computed quote to lock the floor exactly. */
    quote?: ZionSwapQuote;
    slippageBpsOverride?: number;
  }): { typeUrl: string; value: MsgSwapValue } {
    const q =
      args.quote ??
      this.quote(args.pool, args.amountIn, args.denomOut, args.slippageBpsOverride);
    const denomIn =
      args.denomOut === args.pool.denomA ? args.pool.denomB : args.pool.denomA;
    return {
      typeUrl: ZION_AMM_MSG_SWAP_TYPE_URL,
      value: {
        swapper: args.swapper,
        poolId: args.pool.id,
        amountIn: { denom: denomIn, amount: args.amountIn.toString() },
        minAmountOut: q.minAmountOut.toString(),
        denomOut: args.denomOut,
      },
    };
  }
}

function parsePool(p: RawAmmPool): ZionPool {
  return {
    id: BigInt(p.id),
    denomA: p.denom_a,
    denomB: p.denom_b,
    reserveA: BigInt(p.reserve_a),
    reserveB: BigInt(p.reserve_b),
    feeBps: p.fee_bps,
  };
}

// Re-export to give callers one import for the whole AMM surface.
export { ZION_AMM_MSG_SWAP_TYPE_URL, ZION_AMM_TYPES, encodeMsgSwap };
export type { MsgSwapValue };
