// zion-amm-codec.ts — ZION AMM (x/amm) proto message encoders.
//
// Why hand-roll: cosmjs-types isn't a direct dep of this package under pnpm,
// and ZION's proto bindings aren't published to npm. The wire format is
// trivial — every field on `MsgSwap` is either a `string`, a `uint64`, or
// `Coin` (two strings). We only need *encode* (wallet → chain); decoding is
// the indexer's job.
//
// Proto reference (D:\Zion\chain\proto\zion\amm\v1\tx.proto, mirrored in
// `chain/x/amm/types/tx.pb.go`):
//
//   message MsgSwap {
//     string swapper        = 1;
//     uint64 pool_id        = 2;
//     Coin   amount_in      = 3;     // cosmos.base.v1beta1.Coin
//     string min_amount_out = 4;
//     string denom_out      = 5;
//   }
//   message Coin { string denom = 1; string amount = 2; }
//
// Plug into a CosmosAdapter via `customMsgTypes: ZION_AMM_TYPES`. The adapter
// then accepts `{ typeUrl: '/zion.amm.v1.MsgSwap', value: {...} }` in
// `buildTx([...])`, identical in shape to how cosmjs handles defaultRegistryTypes.

import type { GeneratedType } from '@cosmjs/proto-signing';
import { concat, varint } from './cosmos.js';

const TEXT_ENC = new TextEncoder();

/** A Cosmos SDK `cosmos.base.v1beta1.Coin`. `amount` is a string because
 *  it represents `math.Int` (arbitrary precision) on-chain. */
export interface ZionCoin {
  denom: string;
  amount: string;
}

export interface MsgSwapValue {
  /** Bech32 `zion1...` of the swap caller. */
  swapper: string;
  /** Target pool id (uint64). */
  poolId: bigint;
  /** Input coin (denom + amount as base-units string). */
  amountIn: ZionCoin;
  /** Slippage floor: tx fails if output < this (string of base-units). */
  minAmountOut: string;
  /** Desired output denom (must be the pool's other side). */
  denomOut: string;
}

export const ZION_AMM_MSG_SWAP_TYPE_URL = '/zion.amm.v1.MsgSwap';

/* ------------------------------------------------------------------ */
/* primitive proto encoders                                            */
/* ------------------------------------------------------------------ */

/** Encode a non-negative bigint as a protobuf varint. */
function varintBig(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('zion-amm: varint must be non-negative');
  const out: number[] = [];
  let v = n;
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v & 0x7fn));
  return new Uint8Array(out);
}

/** `field<<3 | wire_type`. wire 0 = varint, wire 2 = length-delimited. */
function tag(field: number, wireType: 0 | 2): Uint8Array {
  return varint((field << 3) | wireType);
}

/** Encode `string` field. Empty string → zero bytes (proto3 default elision). */
function encodeString(field: number, s: string): Uint8Array {
  if (s === '') return new Uint8Array();
  const bytes = TEXT_ENC.encode(s);
  return concat([tag(field, 2), varint(bytes.length), bytes]);
}

/** Encode `uint64` field. Zero → zero bytes (proto3 default elision). */
function encodeUint64(field: number, v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array();
  return concat([tag(field, 0), varintBig(v)]);
}

/** Embed an already-encoded sub-message as a length-delimited field. */
function encodeEmbedded(field: number, body: Uint8Array): Uint8Array {
  if (body.length === 0) return new Uint8Array();
  return concat([tag(field, 2), varint(body.length), body]);
}

/* ------------------------------------------------------------------ */
/* message encoders                                                    */
/* ------------------------------------------------------------------ */

/** `cosmos.base.v1beta1.Coin` body bytes (no outer tag). */
export function encodeCoin(c: ZionCoin): Uint8Array {
  return concat([encodeString(1, c.denom), encodeString(2, c.amount)]);
}

/** `/zion.amm.v1.MsgSwap` body bytes. */
export function encodeMsgSwap(v: MsgSwapValue): Uint8Array {
  return concat([
    encodeString(1, v.swapper),
    encodeUint64(2, v.poolId),
    encodeEmbedded(3, encodeCoin(v.amountIn)),
    encodeString(4, v.minAmountOut),
    encodeString(5, v.denomOut),
  ]);
}

/* ------------------------------------------------------------------ */
/* Registry-compatible GeneratedType                                    */
/* ------------------------------------------------------------------ */

/**
 * cosmjs `Registry` expects each registered type to look like a cosmjs-types
 * generated class: `{ encode(value).finish(), decode(bytes), fromPartial(p) }`.
 * Decode throws — wallets are encode-only and the indexer handles reads.
 *
 * The structural-type cast at export time satisfies the `GeneratedType`
 * contract that `CosmosAdapter` accepts without us having to import the type
 * here (cosmjs `GeneratedType` is not a direct dep).
 */
export const MsgSwap = {
  encode(value: MsgSwapValue) {
    const bytes = encodeMsgSwap(value);
    return { finish: () => bytes };
  },
  decode(_bytes: Uint8Array): MsgSwapValue {
    throw new Error('MsgSwap.decode is intentionally not implemented (wallet is encode-only)');
  },
  fromPartial(p: Partial<MsgSwapValue>): MsgSwapValue {
    return {
      swapper: p.swapper ?? '',
      poolId: p.poolId ?? 0n,
      amountIn: p.amountIn ?? { denom: '', amount: '0' },
      minAmountOut: p.minAmountOut ?? '',
      denomOut: p.denomOut ?? '',
    };
  },
};

/**
 * The full set of ZION AMM message types — pass to
 * `new CosmosAdapter({ ..., customMsgTypes: ZION_AMM_TYPES })`.
 * Phase 1 wallet scope is `MsgSwap` only; add-liquidity / create-pool / etc.
 * are registered in future slices and append here.
 *
 * The cast widens our `{ encode, decode, fromPartial }` shape to cosmjs's
 * `GeneratedType` union. cosmjs's `Registry.encode(...)` calls
 * `Type.encode(value).finish()` — our `encode` returns exactly that minimal
 * `{ finish() }` shape, which is the runtime contract. The static type
 * (`TsProtoGeneratedType`) demands the full `Writer` surface for the
 * fluent path we don't use, hence the `unknown` step.
 */
export const ZION_AMM_TYPES: ReadonlyArray<readonly [string, GeneratedType]> = [
  [ZION_AMM_MSG_SWAP_TYPE_URL, MsgSwap as unknown as GeneratedType],
];
