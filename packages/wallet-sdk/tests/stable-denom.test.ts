// stable-denom.test.ts — 스테이블코인 액면(주소 → 통화 ISO)과 TTL 환산.
//
// 여기서 고정하는 것은 경계다: **상장자산은 이 경로로 값이 나오지 않는다.**
// 셸(android/extension)에는 테스트 러너가 없으므로 경계는 순수 함수인 이 층에서만
// 고정할 수 있다. 그래서 환산이 셸이 아니라 wallet-sdk 에 있다.

import { describe, expect, it } from 'vitest';
import {
  listStableDenoms,
  stableDenomOf,
  stableDenomOfEvm,
  stableToTtl,
} from '../src/rates/stable.js';
import { RATE_SNAPSHOT, rateByIso, stableAmountToTtl } from '../src/rates/index.js';
import { BUILTIN_CHAIN_IDS, TokenRegistry } from '../src/tokens/registry.js';
import type { Address } from '../src/types.js';

/** rate-snapshot 의 tUSD perTtl. 앵커라 하드코딩한다 — 바뀌면 알려야 한다. */
const USD_PER_TTL = 246.64798986458746;
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

/** 시장 시세로 값이 매겨지는 자산들. 액면을 가지면 안 된다. */
const MARKET_SYMBOLS = new Set([
  'WETH',
  'WETH.e',
  'WBTC',
  'WBTC.e',
  'WAVAX',
  'WBNB',
  'WMATIC',
]);

describe('stableDenomOf — 주소로만 판정한다', () => {
  it('이더리움 USDT 는 USD 액면', () => {
    const d = stableDenomOf(USDT_ETH, 'evm', BUILTIN_CHAIN_IDS.ethereum);
    expect(d?.iso).toBe('USD');
    expect(d?.decimals).toBe(6);
  });

  it('같은 주소라도 chainId 가 다르면 null — 체인 간 주소 재사용 차단', () => {
    expect(stableDenomOf(USDT_ETH, 'evm', BUILTIN_CHAIN_IDS.avalanche)).toBeNull();
  });

  it('chainId 없이 EVM 조회는 null', () => {
    expect(stableDenomOf(USDT_ETH, 'evm', null)).toBeNull();
  });

  it('EVM 은 체크섬 대소문자를 가리지 않는다', () => {
    expect(stableDenomOf(USDT_ETH.toLowerCase(), 'evm', 1)?.iso).toBe('USD');
  });

  it('TRON USDT 는 정확 일치일 때만 — 소문자화한 주소는 null', () => {
    expect(stableDenomOf(USDT_TRON, 'tron', null)?.iso).toBe('USD');
    expect(stableDenomOf(USDT_TRON.toLowerCase(), 'tron', null)).toBeNull();
  });

  it('TRON 주소를 EVM family 로 물으면 null', () => {
    expect(stableDenomOf(USDT_TRON, 'evm', 1)).toBeNull();
  });

  it('임의 주소는 심볼이 USDT 든 아니든 null — 가짜 USDT 는 액면을 못 얻는다', () => {
    // 심볼은 시그니처에 아예 없다. 이 단언이 깨지는 유일한 길은 시그니처가
    // 바뀌어 심볼 판정이 되살아나는 것이다.
    expect(stableDenomOf(`0x${'9'.repeat(40)}`, 'evm', 1)).toBeNull();
    expect(stableDenomOf('USDТ', 'tron', null)).toBeNull();
  });

  it('커스텀 토큰은 액면을 자칭할 수 없다', () => {
    const reg = new TokenRegistry();
    const addr = `0x${'9'.repeat(40)}` as Address;
    reg.addCustomToken(1, {
      address: addr,
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      faceIso: 'USD',
    });
    expect(reg.getToken(1, addr)?.faceIso).toBeUndefined();
  });
});

describe('경계 — 상장자산은 이 경로로 값이 나오지 않는다', () => {
  it('내장 목록 전체를 훑어 wrapped·상장자산에 faceIso 가 없다', () => {
    const reg = new TokenRegistry();
    let checked = 0;
    for (const chainId of reg.listChainIds()) {
      for (const t of reg.getKnownTokens(chainId)) {
        if (!MARKET_SYMBOLS.has(t.symbol)) continue;
        checked++;
        expect(t.faceIso).toBeUndefined();
        expect(stableDenomOfEvm(chainId, t.address)).toBeNull();
      }
    }
    // 테이블 주도 — 나중에 wrapped 가 추가돼도 자동으로 덮인다.
    expect(checked).toBeGreaterThan(5);
  });

  it('액면 색인과 환율 스냅샷 주소는 서로 겹치지 않는다', () => {
    const snap = new Set(RATE_SNAPSHOT.rates.map((r) => r.address.toLowerCase()));
    for (const d of listStableDenoms()) {
      expect(snap.has(d.address.toLowerCase())).toBe(false);
    }
  });

  it('색인의 액면은 전부 스냅샷에 있는 ISO 다', () => {
    for (const d of listStableDenoms()) {
      expect(rateByIso(d.iso)).not.toBeNull();
    }
  });
});

describe('stableAmountToTtl / stableToTtl (액면 → TTL)', () => {
  it('USDT 100 개(decimals 6) → 0.405436 TTL', () => {
    const ttl = stableAmountToTtl(100_000_000n, 6, rateByIso('USD'))!;
    expect(ttl).toBeCloseTo(100 / USD_PER_TTL, 12);
  });

  it('rate 의 decimals(18)를 쓰지 않는다 — 쓰면 10^12 배 어긋난다', () => {
    expect(rateByIso('USD')!.decimals).toBe(18);
    expect(stableAmountToTtl(100_000_000n, 6, rateByIso('USD'))!).toBeGreaterThan(0.4);
  });

  it('스냅샷에 없는 ISO 는 null — 0 이 아니다', () => {
    expect(stableAmountToTtl(1n, 6, rateByIso('XXX'))).toBeNull();
  });

  it('말이 안 되는 decimals 는 null', () => {
    expect(stableAmountToTtl(1n, -1, rateByIso('USD'))).toBeNull();
    expect(stableAmountToTtl(1n, 1.5, rateByIso('USD'))).toBeNull();
    expect(stableAmountToTtl(1n, 99, rateByIso('USD'))).toBeNull();
  });

  it('decimals 는 레지스트리 값이 호출자 주장을 이긴다', () => {
    const d = stableDenomOf(USDT_ETH, 'evm', 1)!;
    // 호출자가 18 을 주장해도 내장값 6 이 쓰인다.
    expect(stableToTtl(100_000_000n, d, 18)).toBeCloseTo(100 / USD_PER_TTL, 12);
  });

  it('BSC USDT 는 decimals 18 — 같은 심볼이라도 체인별 값이 쓰인다', () => {
    const d = stableDenomOf(
      '0x55d398326f99059fF775485246999027B3197955',
      'evm',
      BUILTIN_CHAIN_IDS.bsc,
    )!;
    expect(d.decimals).toBe(18);
    expect(stableToTtl(100_000_000_000_000_000_000n, d)).toBeCloseTo(100 / USD_PER_TTL, 12);
  });

  it('내장 decimals 가 없는 TRON USDT 는 폴백이 없으면 값을 비운다', () => {
    const d = stableDenomOf(USDT_TRON, 'tron', null)!;
    expect(d.decimals).toBeNull();
    expect(stableToTtl(100_000_000n, d)).toBeNull();
    expect(stableToTtl(100_000_000n, d, 6)).toBeCloseTo(100 / USD_PER_TTL, 12);
  });

  it('큰 잔액에서 상위 자릿수가 뭉개지지 않는다', () => {
    // 1_000_000 USDT (decimals 18) — Number(bigint) 로 통째 변환하면 2^53 초과.
    const d = stableDenomOf(
      '0x55d398326f99059fF775485246999027B3197955',
      'evm',
      BUILTIN_CHAIN_IDS.bsc,
    )!;
    expect(stableToTtl(1_000_000n * 10n ** 18n, d)).toBeCloseTo(1_000_000 / USD_PER_TTL, 6);
  });
});
