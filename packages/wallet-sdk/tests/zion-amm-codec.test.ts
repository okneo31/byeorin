import { describe, expect, it } from 'vitest';
import {
  encodeCoin,
  encodeMsgSwap,
  MsgSwap,
  ZION_AMM_MSG_SWAP_TYPE_URL,
  ZION_AMM_TYPES,
} from '../src/chains/zion-amm-codec.js';
import { CosmosAdapter } from '../src/chains/cosmos.js';

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const strHex = (s: string): string =>
  Array.from(new TextEncoder().encode(s), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');

/** Hex length-byte (single byte covering 0–127, which is all we exercise). */
const lenByte = (n: number): string => {
  if (n < 0 || n >= 0x80) throw new Error('test helper: length out of range');
  return n.toString(16).padStart(2, '0');
};

describe('ZION AMM proto wire format', () => {
  // ---- Coin (cosmos.base.v1beta1.Coin) ----
  it('encodeCoin → field 1 (denom) + field 2 (amount), both length-delimited strings', () => {
    // Coin { denom: "utrg", amount: "1000000" }
    // field 1 wire 2 → tag 0x0a, len, body
    // field 2 wire 2 → tag 0x12, len, body
    const denom = 'utrg';
    const amount = '1000000';
    const expected =
      '0a' +
      lenByte(denom.length) +
      strHex(denom) +
      '12' +
      lenByte(amount.length) +
      strHex(amount);
    const bytes = encodeCoin({ denom, amount });
    expect(toHex(bytes)).toBe(expected);
    // tag(1)+len(1)+4 + tag(1)+len(1)+7 = 15
    expect(bytes.length).toBe(15);
  });

  it('encodeCoin elides proto3 default empty strings', () => {
    expect(encodeCoin({ denom: '', amount: '' }).length).toBe(0);
  });

  // ---- MsgSwap ----
  it('encodeMsgSwap produces a deterministic, field-ordered wire encoding', () => {
    const swapper = 'zion1abc';
    const poolId = 1n;
    const inDenom = 'utrg';
    const inAmount = '1000000';
    const minOut = '950000';
    const outDenom = 'ubtc';

    const coinHex =
      '0a' +
      lenByte(inDenom.length) +
      strHex(inDenom) +
      '12' +
      lenByte(inAmount.length) +
      strHex(inAmount);
    const coinByteLen = coinHex.length / 2;

    const expected =
      // field 1 swapper (wire 2)
      '0a' + lenByte(swapper.length) + strHex(swapper) +
      // field 2 poolId (wire 0) varint(1) = 0x01
      '10' + '01' +
      // field 3 amountIn Coin (wire 2, embedded)
      '1a' + lenByte(coinByteLen) + coinHex +
      // field 4 minAmountOut (wire 2)
      '22' + lenByte(minOut.length) + strHex(minOut) +
      // field 5 denomOut (wire 2)
      '2a' + lenByte(outDenom.length) + strHex(outDenom);

    const bytes = encodeMsgSwap({
      swapper,
      poolId,
      amountIn: { denom: inDenom, amount: inAmount },
      minAmountOut: minOut,
      denomOut: outDenom,
    });
    expect(toHex(bytes)).toBe(expected);
    expect(bytes.length).toBe(expected.length / 2);
  });

  it('proto3 defaults are elided: zero poolId, empty strings, zero coin amount', () => {
    const empty = encodeMsgSwap({
      swapper: '',
      poolId: 0n,
      amountIn: { denom: '', amount: '' },
      minAmountOut: '',
      denomOut: '',
    });
    expect(empty.length).toBe(0);
  });

  it('handles multi-byte poolId varint (300 → 0xac 0x02)', () => {
    const bytes = encodeMsgSwap({
      swapper: '',
      poolId: 300n,
      amountIn: { denom: '', amount: '' },
      minAmountOut: '',
      denomOut: '',
    });
    expect(toHex(bytes)).toBe('10ac02');
  });

  it('handles a poolId past Number.MAX_SAFE_INTEGER without precision loss', () => {
    const big = (1n << 60n) + 7n;
    const bytes = encodeMsgSwap({
      swapper: '',
      poolId: big,
      amountIn: { denom: '', amount: '' },
      minAmountOut: '',
      denomOut: '',
    });
    expect(bytes[0]).toBe(0x10);
    // Invert the varint and confirm we recover the same bigint.
    let v = 0n;
    let shift = 0n;
    for (let i = 1; i < bytes.length; i++) {
      const b = bytes[i]!;
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    expect(v).toBe(big);
  });
});

describe('ZION AMM Registry integration', () => {
  it('MsgSwap.encode(value).finish() equals encodeMsgSwap(value)', () => {
    const v = {
      swapper: 'zion1xyz',
      poolId: 42n,
      amountIn: { denom: 'utrg', amount: '500' },
      minAmountOut: '475',
      denomOut: 'ubtc',
    };
    expect(MsgSwap.encode(v).finish()).toEqual(encodeMsgSwap(v));
  });

  it('MsgSwap.fromPartial fills proto3 defaults for missing fields', () => {
    expect(MsgSwap.fromPartial({})).toEqual({
      swapper: '',
      poolId: 0n,
      amountIn: { denom: '', amount: '0' },
      minAmountOut: '',
      denomOut: '',
    });
  });

  it('MsgSwap.decode throws — wallet is encode-only', () => {
    expect(() => MsgSwap.decode(new Uint8Array([0]))).toThrow(
      /not implemented/,
    );
  });

  it('CosmosAdapter registers MsgSwap when given ZION_AMM_TYPES', () => {
    const adapter = new CosmosAdapter({
      chainId: 'zion',
      bech32Prefix: 'zion',
      rpcUrl: 'http://localhost',
      denom: 'utrg',
      customMsgTypes: ZION_AMM_TYPES,
    });
    expect(adapter.registry.lookupType(ZION_AMM_MSG_SWAP_TYPE_URL)).toBe(MsgSwap);
  });

  it('Registry encodeTxBody wraps MsgSwap in an Any containing the typeUrl', () => {
    const adapter = new CosmosAdapter({
      chainId: 'zion',
      bech32Prefix: 'zion',
      rpcUrl: 'http://localhost',
      denom: 'utrg',
      customMsgTypes: ZION_AMM_TYPES,
    });
    const body = adapter.registry.encodeTxBody({
      messages: [
        {
          typeUrl: ZION_AMM_MSG_SWAP_TYPE_URL,
          value: {
            swapper: 'zion1abc',
            poolId: 1n,
            amountIn: { denom: 'utrg', amount: '1000' },
            minAmountOut: '950',
            denomOut: 'ubtc',
          },
        },
      ],
      memo: '',
    });
    expect(body.length).toBeGreaterThan(0);
    // Any.typeUrl is a length-delimited string at field 1 of Any.
    expect(new TextDecoder().decode(body)).toContain('/zion.amm.v1.MsgSwap');
  });
});
