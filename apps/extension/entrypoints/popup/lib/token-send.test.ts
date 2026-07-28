// token-send.test.ts — 자산 선택 · 금액 파싱 · intent 구성 검증.
//
// UI 없이 순수 함수만 본다. 핵심 회귀 방어점:
//   1. native 경로가 예전 SendPane 과 동일한 intent 를 만든다.
//   2. 토큰 decimals 와 native decimals 가 절대 섞이지 않는다.
//   3. 잔액 초과는 전송 전에 걸린다.

import { describe, expect, it } from 'vitest';
import type { ChainAdapter } from '@byeorin/wallet-sdk/core';
import type { DiscoveredBalance } from '@byeorin/wallet-sdk/evm';
import {
  buildTransferIntent,
  formatAssetAmount,
  parseAssetAmount,
  resolveAsset,
} from './token-send.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

const tokens: DiscoveredBalance[] = [
  {
    token: { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    balance: 1_500_000n, // 1.5 USDC
  },
];

// Erc20 는 adapter 의 viem client 만 꺼내 쓰는데 transfer() 는 calldata 인코딩만
// 하므로 RPC 를 건드리지 않는다 — 빈 객체로 충분하다.
const fakeAdapter = {} as unknown as ChainAdapter;

describe('resolveAsset', () => {
  it("'native' 는 체인 native 심볼/decimals 를 쓴다", () => {
    const a = resolveAsset('native', 'TTL', 18, 42n, tokens);
    expect(a).toEqual({
      kind: 'native',
      symbol: 'TTL',
      decimals: 18,
      address: null,
      balance: 42n,
    });
  });

  it('컨트랙트 주소는 해당 토큰의 심볼/decimals/잔액을 쓴다', () => {
    const a = resolveAsset(USDC, 'TTL', 18, 42n, tokens);
    expect(a.kind).toBe('erc20');
    expect(a.symbol).toBe('USDC');
    expect(a.decimals).toBe(6);
    expect(a.balance).toBe(1_500_000n);
  });

  it('주소 대소문자가 달라도 매칭된다', () => {
    expect(resolveAsset(USDC.toLowerCase(), 'TTL', 18, null, tokens).kind).toBe('erc20');
  });

  it('목록에 없는 키는 native 로 되돌린다', () => {
    const a = resolveAsset('0xdead', 'TTL', 18, null, tokens);
    expect(a.kind).toBe('native');
    expect(a.symbol).toBe('TTL');
  });

  it('토큰 목록이 null 이면 (비-EVM) 항상 native', () => {
    expect(resolveAsset(USDC, 'ATOM', 6, null, null).kind).toBe('native');
  });
});

describe('parseAssetAmount', () => {
  const native = resolveAsset('native', 'TTL', 18, null, null);
  const usdc = resolveAsset(USDC, 'TTL', 18, null, tokens);

  it('native 는 18 decimals 로 파싱한다', () => {
    expect(parseAssetAmount('1.5', native)).toEqual({ ok: true, value: 1_500_000_000_000_000_000n });
  });

  it('토큰은 토큰 decimals 로 파싱한다 (native 18 과 섞이지 않음)', () => {
    expect(parseAssetAmount('1.5', usdc)).toEqual({ ok: true, value: 1_500_000n });
  });

  it('형식 오류 / 0 / 음수 / 빈 문자열은 거절', () => {
    for (const bad of ['', ' ', 'abc', '0', '-1', '1.2.3', '1e18']) {
      expect(parseAssetAmount(bad, native).ok).toBe(false);
    }
  });

  it('토큰 decimals 를 넘는 소수 자릿수는 거절 (반올림 사고 방지)', () => {
    const r = parseAssetAmount('1.1234567', usdc);
    expect(r).toEqual({ ok: false, reason: 'decimals' });
  });

  it('토큰 decimals 와 같은 자릿수는 통과', () => {
    expect(parseAssetAmount('1.123456', usdc)).toEqual({ ok: true, value: 1_123_456n });
  });

  it('잔액을 알면 초과 입력을 거절한다', () => {
    const withBal = resolveAsset(USDC, 'TTL', 18, null, tokens); // 1.5 USDC 보유
    expect(parseAssetAmount('2', withBal)).toEqual({ ok: false, reason: 'insufficient' });
    expect(parseAssetAmount('1.5', withBal).ok).toBe(true);
  });

  it('잔액을 모르면 (null) 초과 검사를 건너뛴다', () => {
    const noBal = resolveAsset('native', 'TTL', 18, null, null);
    expect(parseAssetAmount('999999', noBal).ok).toBe(true);
  });

  it('native 잔액 초과도 막는다', () => {
    const nativeBal = resolveAsset('native', 'TTL', 18, 1_000_000_000_000_000_000n, null);
    expect(parseAssetAmount('2', nativeBal)).toEqual({ ok: false, reason: 'insufficient' });
    expect(parseAssetAmount('1', nativeBal).ok).toBe(true);
  });
});

describe('buildTransferIntent', () => {
  it('native 는 기존과 동일한 { to, amount } — calldata 없음', () => {
    const native = resolveAsset('native', 'TTL', 18, null, null);
    const intent = buildTransferIntent(native, RECIPIENT, 1_000n, fakeAdapter);
    expect(intent).toEqual({ to: RECIPIENT, amount: 1_000n });
    expect(intent.data).toBeUndefined();
  });

  it('ERC-20 은 컨트랙트로 향하는 transfer calldata (value 0)', () => {
    const usdc = resolveAsset(USDC, 'TTL', 18, null, tokens);
    const intent = buildTransferIntent(usdc, RECIPIENT, 1_500_000n, fakeAdapter);
    expect(intent.to).toBe(USDC);
    expect(intent.amount).toBe(0n);
    expect(intent.asset).toBe('erc20');
    // transfer(address,uint256) selector + 수령인 + 금액
    expect(intent.data?.slice(0, 10)).toBe('0xa9059cbb');
    expect(intent.data?.toLowerCase()).toContain(RECIPIENT.slice(2).toLowerCase());
    expect(intent.data?.endsWith('16e360')).toBe(true); // 1_500_000 = 0x16e360
  });
});

describe('formatAssetAmount', () => {
  it('decimals 를 적용하고 천 단위 쉼표를 넣는다', () => {
    expect(formatAssetAmount(1_500_000n, 6)).toBe('1.5000');
    expect(formatAssetAmount(1_234_567_000_000n, 6)).toBe('1,234,567.0000');
    expect(formatAssetAmount(null, 18)).toBe('0.0000');
  });
});
