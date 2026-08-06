// token-identity.test.ts — 신원 판정(kind) + 환산 + 시세 게이트.
//
// 셸에는 테스트 러너가 없다. 셸이 이 판정을 자기 손으로 짜면 경계가 고정되지
// 않는다는 것이 v0.5.21 에서 드러났다(두 셸의 decimals·분기 조건이 갈라졌다).
// 그래서 판정이 SDK 에 있고, 경계는 여기서만 고정된다.

import { describe, expect, it } from 'vitest';
import { tokenIdentityOf, tokenValueOf, UNKNOWN_TOKEN } from '../src/rates/stable.js';
import { RATE_SNAPSHOT } from '../src/rates/index.js';
import { BUILTIN_CHAIN_IDS } from '../src/tokens/registry.js';

/** rate-snapshot 의 tUSD perTtl. 앵커라 하드코딩한다 — 바뀌면 알려야 한다. */
const USD_PER_TTL = 246.64798986458746;
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
/** 아무도 배포하지 않은 주소 — 신원 미확인의 표본. */
const FAKE = '0x00000000000000000000000000000000deadbeef';

describe('tokenIdentityOf — 주소로만 판정한다', () => {
  it('가짜 USDT(주소 미등록)는 신원 미확인', () => {
    const id = tokenIdentityOf(FAKE, 'evm', BUILTIN_CHAIN_IDS.ethereum);
    expect(id.kind).toBeNull();
    expect(id.faceIso).toBeUndefined();
    expect(id).toEqual(UNKNOWN_TOKEN);
  });

  it('이더리움 USDT 는 내장 스테이블 — 액면 USD, decimals 6', () => {
    const id = tokenIdentityOf(USDT_ETH, 'evm', BUILTIN_CHAIN_IDS.ethereum);
    expect(id.kind).toBe('evm-builtin');
    expect(id.faceIso).toBe('USD');
    expect(id.decimals).toBe(6);
  });

  it('같은 주소라도 chainId 가 다르면 미확인 — 주소는 체인 간 재사용된다', () => {
    expect(tokenIdentityOf(USDT_ETH, 'evm', BUILTIN_CHAIN_IDS.avalanche).kind).toBeNull();
  });

  it('TRON USDT 는 trc20-known. decimals 는 저장소에 근거가 없어 비어 있다', () => {
    const id = tokenIdentityOf(USDT_TRON, 'tron', null);
    expect(id.kind).toBe('trc20-known');
    expect(id.faceIso).toBe('USD');
    expect(id.decimals).toBeUndefined();
  });

  it('벼린 환율 토큰은 byeorin-rate — 액면을 갖지 않는다', () => {
    const anchor = RATE_SNAPSHOT.rates[0];
    const id = tokenIdentityOf(anchor.address, 'evm', 7777);
    expect(id.kind).toBe('byeorin-rate');
    expect(id.faceIso).toBeUndefined();
  });

  it('WETH 는 신원은 확인되지만 액면이 없다 — 값의 출처가 시장이다', () => {
    const id = tokenIdentityOf(WETH_ETH, 'evm', BUILTIN_CHAIN_IDS.ethereum);
    expect(id.kind).toBe('evm-builtin');
    expect(id.faceIso).toBeUndefined();
  });
});

describe('tokenValueOf — 값과 시세 게이트', () => {
  it('TRON USDT 100 개 = 100 / USD_PER_TTL TTL', () => {
    const v = tokenValueOf({
      id: USDT_TRON,
      family: 'tron',
      chainId: null,
      balance: 100_000_000n,
      decimals: 6, // 체인에서 읽은 값 — SDK 가 모르므로 호출자가 준다
    });
    expect(v.decimals).toBe(6);
    expect(v.ttl).toBeCloseTo(100 / USD_PER_TTL, 12);
    expect(v.faceRate?.iso).toBe('USD');
    expect(v.askMarketPrice).toBe(false);
  });

  it('내장 decimals 가 체인값과 다르면 내장값이 이긴다 (표시 배율 조작 차단)', () => {
    const v = tokenValueOf({
      id: USDT_ETH,
      family: 'evm',
      chainId: BUILTIN_CHAIN_IDS.ethereum,
      balance: 100_000_000n,
      decimals: 18, // 인덱서가 거짓말한 값
    });
    expect(v.decimals).toBe(6);
    expect(v.ttl).toBeCloseTo(100 / USD_PER_TTL, 12);
  });

  it('신원 미확인 토큰은 값도 없고 시세도 묻지 않는다', () => {
    const v = tokenValueOf({
      id: FAKE,
      family: 'evm',
      chainId: BUILTIN_CHAIN_IDS.ethereum,
      balance: 100_000_000_000_000_000_000n,
      decimals: 18,
    });
    expect(v.ttl).toBeNull();
    expect(v.faceRate).toBeNull();
    expect(v.askMarketPrice).toBe(false);
  });

  it('WETH 는 TTL 환산 금지, USD 보조줄로 간다', () => {
    const v = tokenValueOf({
      id: WETH_ETH,
      family: 'evm',
      chainId: BUILTIN_CHAIN_IDS.ethereum,
      balance: 10n ** 18n,
      decimals: 18,
    });
    expect(v.ttl).toBeNull();
    expect(v.faceRate).toBeNull();
    expect(v.askMarketPrice).toBe(true);
  });

  it('벼린 환율 토큰은 TTL 이 나오고 시세는 묻지 않는다', () => {
    const anchor = RATE_SNAPSHOT.rates[0];
    const v = tokenValueOf({
      id: anchor.address,
      family: 'evm',
      chainId: 7777,
      balance: 10n ** 18n,
      decimals: 18,
    });
    expect(v.ttl).not.toBeNull();
    expect(v.askMarketPrice).toBe(false);
  });
});
