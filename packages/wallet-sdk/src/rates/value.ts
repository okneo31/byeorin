// value.ts — "이 잔액은 몇 TTL 인가" 에 답하는 **단 하나의** 함수.
//
// TTL 이 기준이다. 모든 자산을 TTL 로 잰다. 상장자산도 예외가 아니다.
//
// 두 앵커는 여전히 만나지 않는다. TTL 의 값은 rate-snapshot(GDP÷인구÷365)에서만
// 오고 어디서도 시장에서 오지 않는다. 시장 시세는 **재어지는 쪽**에 붙는다 —
// BTC 가 몇 TTL 인지는 BTC 의 성질이지 TTL 의 성질이 아니다. 이 방향이 뒤집혀
// TTL 자신의 값을 시세로 정하기 시작하면 옛 페그(TTL = 10/365 BTC)로 되돌아간다.
// docs/CONTEXT.md §5 가 금지한 것은 뒤집힌 그 방향이다.
//
// 환산 조각이 흩어져 있던 것을 여기로 접었다:
//   rates/index.ts tokenAmountToTtl(t{ISO}) · stableAmountToTtl(액면)
//   rates/stable.ts tokenValueOf(신원+환산, 단 시세는 셸에 떠넘김)
//   셸 App.tsx tokenToUsd × 2 벌  → rates/market.ts
// 셸은 이제 이 함수 하나만 부른다. 셸에서 다시 짜지 마라.

import { rateByAddress, rateByIso, baseUnitsToNumber } from './index.js';
import { tokenIdentityOf, type TokenIdentity } from './stable.js';
import { symbolUnitUsd, type PriceTable, type UnitUsd } from './market.js';
import type { TokenRate } from './types.js';

/** 이 값이 어디서 왔는가. 화면은 근거 없이 숫자만 그리면 안 된다. */
export type ValueBasis =
  /** TTL 자신 — 환산이 아니다. 잔액이 곧 TTL 이다. */
  | 'self'
  /** t{ISO} 통화토큰 — 벼린 환율(rate-snapshot) 주소 조회. */
  | 'byeorin-rate'
  /** 스테이블 — 발행자가 선언한 액면 통화를 벼린 환율로 옮김. */
  | 'face'
  /** 상장자산 — 시장 USD 시세를 벼린 USD 환율로 옮김. **출렁인다.** */
  | 'market';

/** 값을 내지 못한 사유. 뭉뚱그리면 지갑이 거짓말을 한다. */
export type ValueReason =
  /** 주소로 신원이 확인되지 않았다. 모르는 것에 값을 붙이지 않는다. */
  | 'unverified'
  /** 신원은 확인됐으나 시세 표에 없거나 표 자체가 없다(fetch 실패). */
  | 'unlisted'
  /** 액면 통화는 알지만 그 ISO 가 스냅샷에 없다. USD 로 되돌아가지 않는다. */
  | 'no-face-rate'
  /** decimals 가 신뢰 범위를 벗어났다. 틀린 배율로 찍느니 비운다. */
  | 'bad-decimals';

/** 시세 기반 값의 근거 — 화면이 "63,412 USD × 0.00405436" 를 그릴 수 있게. */
export interface MarketBasis {
  /** 1 단위 = 몇 USD. */
  readonly unitUsd: number;
  /** 그 USD 를 어느 페어로 얻었는지. */
  readonly via: UnitUsd['via'];
  /** 1 USD = 몇 TTL (= 1 / tUSD.perTtl). 벼린 환율에서만 온다. */
  readonly usdPerTtl: number;
}

/** 화면 한 줄이 값을 그리는 데 필요한 사실 전부. */
export interface AssetValue {
  /** TTL 값. 낼 수 없으면 null — **0 이 아니다.** 0 은 "가치 없음" 으로 읽힌다. */
  readonly ttl: number | null;
  readonly basis: ValueBasis;
  readonly reason?: ValueReason;
  /**
   * 이 값이 시장 시세를 타는가.
   *
   * 화면은 이걸로 고정 액면(스테이블·t{ISO})과 시세 기반(상장자산)을 구분해
   * 표기해야 한다. 구분이 없으면 출렁이는 TTL 값이 "TTL 이 BTC 를 따라간다"로
   * 읽히고, 그건 방금 지운 페그와 화면상 구별이 안 된다.
   */
  readonly volatile: boolean;
  /** 수량 표기와 환산이 **같이** 써야 할 자릿수. 갈라지면 한 줄이 자기모순이 된다. */
  readonly decimals: number;
  readonly identity: TokenIdentity;
  /** 근거 패널용 벼린 환율. basis 가 byeorin-rate·face·market 일 때 채워진다. */
  readonly faceRate: TokenRate | null;
  readonly market?: MarketBasis;
}

/** 무엇을 재는가. 판별 유니온이라 TTL 이 다른 분기로 샐 수 없다. */
export type AssetRef =
  /** TTL 그 자신. 심볼도 시세도 필요 없다 — 받지 않는다. */
  | { readonly kind: 'ttl'; readonly balance: bigint; readonly decimals?: number }
  /** 체인 native 상장자산 — BTC·ETH·SOL·TRX·TON·APT·SUI·XRP … */
  | {
      readonly kind: 'coin';
      readonly symbol: string;
      readonly balance: bigint;
      readonly decimals: number;
    }
  /** 컨트랙트 토큰. id·family·chainId 로 신원을 확인한 뒤에만 값이 붙는다. */
  | {
      readonly kind: 'token';
      readonly id: string;
      readonly family: string;
      readonly chainId: number | null;
      readonly symbol: string;
      readonly balance: bigint;
      readonly decimals: number;
    };

/**
 * 환산에 필요한 바깥 사실.
 *
 * **prices 는 옵셔널이 아니다.** 옵셔널로 두면 셸이 배선을 빠뜨려도 타입이
 * 통과하고 화면만 빈다 — v0.5.22 에서 실제로 그렇게 났다. 시세 표가 없으면
 * `null` 을 **명시적으로** 넘겨라. 그러면 상장자산은 reason:'unlisted' 가 된다.
 */
export interface ValueContext {
  readonly prices: PriceTable | null;
}

/** TTL native 의 자릿수. */
const TTL_DECIMALS = 18;

/** decimals 신뢰 범위 — stableAmountToTtl 과 같은 가드. */
function badDecimals(d: number): boolean {
  return !Number.isInteger(d) || d < 0 || d > 36;
}

/** 값 미상 결과를 한 곳에서 만든다 — 사유를 빠뜨린 null 이 생기지 않도록. */
function empty(
  basis: ValueBasis,
  reason: ValueReason,
  decimals: number,
  identity: TokenIdentity,
  faceRate: TokenRate | null = null,
): AssetValue {
  return { ttl: null, basis, reason, volatile: basis === 'market', decimals, identity, faceRate };
}

const NO_IDENTITY: TokenIdentity = Object.freeze({ kind: null });
/** TTL·native 는 컨트랙트 신원 판정 대상이 아니다. 체인 그 자체다. */
const NATIVE_IDENTITY: TokenIdentity = Object.freeze({
  kind: 'evm-builtin',
  evidence: 'chain native asset',
} as const);

/**
 * 자산 종류를 가리지 않고 TTL 값을 낸다. **셸은 이 함수만 부른다.**
 *
 * 부동소수로 내려오는 지점은 baseUnitsToNumber 한 곳뿐이다. 그 뒤로 곱셈·나눗셈이
 * 최대 2 번 붙어 상대오차 상한은 직접 페어 4.5u(≈5.0e-16), BTC 우회 6.5u
 * (≈7.2e-16) 다 (u = 2^-53). 1e9 TTL 에서 절대오차 7.2e-7 TTL — 표기 소수 2 자리
 * 대비 1.4e5 배 여유다.
 */
export function assetValueInTtl(asset: AssetRef, ctx: ValueContext): AssetValue {
  // ── TTL 자신. **여기서 즉시 반환한다.**
  //
  // 이 분기 아래로 ctx.prices 가 등장하지 않는다. AssetRef 의 'ttl' 갈래에는
  // symbol 필드조차 없어서 market.ts 로 넘길 것이 물리적으로 없다. TTL 에 시세가
  // 곱해지는 경로는 타입 수준에서 존재하지 않는다.
  // 화면은 이 숫자 옆에 환산값이 아니라 TTL 자신의 정의(노동자 N 일 품삯)를 적는다.
  if (asset.kind === 'ttl') {
    const d = asset.decimals ?? TTL_DECIMALS;
    if (badDecimals(d)) return empty('self', 'bad-decimals', TTL_DECIMALS, NATIVE_IDENTITY);
    return {
      ttl: baseUnitsToNumber(asset.balance, d),
      basis: 'self',
      volatile: false,
      decimals: d,
      identity: NATIVE_IDENTITY,
      faceRate: null,
    };
  }

  // ── 체인 native 상장자산. 신원은 체인 자체라 확인 절차가 없다.
  if (asset.kind === 'coin') {
    if (badDecimals(asset.decimals)) {
      return empty('market', 'bad-decimals', asset.decimals, NATIVE_IDENTITY);
    }
    return marketValue(asset.symbol, asset.balance, asset.decimals, NATIVE_IDENTITY, ctx);
  }

  // ── 컨트랙트 토큰. 주소로 신원을 먼저 확인한다. 심볼은 판정에 쓰지 않는다.
  const identity = tokenIdentityOf(asset.id, asset.family, asset.chainId);
  // 내장 목록 decimals 가 이긴다 — 익스플로러가 장악되면 표시 배율이 10^n 배로
  // 조작되기 때문이다(tokenAmountToTtl 주석과 같은 사유).
  const decimals = identity.decimals ?? asset.decimals;
  if (badDecimals(decimals)) return empty('market', 'bad-decimals', decimals, identity);

  // 신원 미확인 — 시세를 **묻지 않는다.** 물으면 심볼 문자열이 다시 판정원이
  // 되고, 가짜 USDT 가 값을 얻는다(v0.5.20 에서 막은 구멍).
  if (identity.kind === null) return empty('market', 'unverified', decimals, NO_IDENTITY);

  // t{ISO} 통화토큰 — TTL 눈금을 이미 가졌다. 시세를 물을 이유가 없다.
  if (identity.kind === 'byeorin-rate') {
    const rate = rateByAddress(asset.id);
    // tokenAmountToTtl 은 스냅샷 decimals 를 강제로 쓴다. 주소가 스냅샷 항목과
    // 같으므로 그것이 정답이다.
    if (rate === null || !(rate.perTtl > 0)) {
      return empty('byeorin-rate', 'no-face-rate', decimals, identity);
    }
    return {
      ttl: baseUnitsToNumber(asset.balance, rate.decimals) / rate.perTtl,
      basis: 'byeorin-rate',
      volatile: false,
      decimals: rate.decimals,
      identity,
      faceRate: rate,
    };
  }

  // 스테이블 — 액면 통화를 벼린 환율로 옮긴다. 시장 시세를 한 번도 읽지 않는다.
  if (identity.faceIso !== undefined) {
    const rate = rateByIso(identity.faceIso);
    if (rate === null || !(rate.perTtl > 0)) {
      // 그 ISO 가 스냅샷에 없다. USD 로 되돌아가지 않는다 — 되돌아가면 같은
      // USDT 가 어떤 날은 TTL, 어떤 날은 USD 로 보인다. 'unlisted'(시세 없음)로
      // 뭉개지도 않는다. 시세 문제가 아니라 환율표에 그 통화가 없는 것이다.
      return empty('face', 'no-face-rate', decimals, identity);
    }
    return {
      ttl: baseUnitsToNumber(asset.balance, decimals) / rate.perTtl,
      basis: 'face',
      volatile: false,
      decimals,
      identity,
      faceRate: rate,
    };
  }

  // 액면 없는 내장 토큰(WETH 등). 값의 출처가 시장이다.
  return marketValue(asset.symbol, asset.balance, decimals, identity, ctx);
}

/**
 * 시장 USD 시세 → TTL.
 *
 * 산식: 수량 × (1 단위 USD) ÷ tUSD.perTtl.
 * 예) BTC 1 개 × (그날 USD 시세) ÷ tUSD.perTtl = TTL. **두 수 모두 코드에 없다** —
 * 시세는 셸이 넘긴 표에서, perTtl 은 스냅샷에서 런타임에 온다. 여기에 숫자를
 * 적어 두면 스냅샷을 다시 만드는 순간 그 숫자가 두 번째 앵커가 된다.
 *
 * 나누는 수 perTtl 은 벼린 환율(GDP÷인구÷365)에서 온다. 이 나눗셈은 USD 를 TTL
 * 로 **옮기는** 것이지 TTL 을 시세로 **정하는** 것이 아니다 — perTtl 은 시세가
 * 무엇이든 바뀌지 않는다. 이 함수가 AssetRef 를 받지 않는 것이 요점이다:
 * 'ttl' 갈래가 여기로 들어올 문법이 없다.
 */
function marketValue(
  symbol: string,
  balance: bigint,
  decimals: number,
  identity: TokenIdentity,
  ctx: ValueContext,
): AssetValue {
  const usdRate = rateByIso('USD');
  if (usdRate === null || !(usdRate.perTtl > 0)) {
    // 스냅샷에 USD 가 없으면 상장자산 전체가 잴 수 없다. 있을 수 없는 상태지만
    // 지어낸 상수로 메우지 않는다 — 메우는 순간 그 상수가 새 페그가 된다.
    return empty('market', 'no-face-rate', decimals, identity);
  }
  const unit = symbolUnitUsd(symbol, ctx.prices);
  if (unit === null) return empty('market', 'unlisted', decimals, identity, usdRate);

  const amount = baseUnitsToNumber(balance, decimals);
  return {
    ttl: (amount * unit.usd) / usdRate.perTtl,
    basis: 'market',
    volatile: true,
    decimals,
    identity,
    faceRate: usdRate,
    market: { unitUsd: unit.usd, via: unit.via, usdPerTtl: 1 / usdRate.perTtl },
  };
}

/** 포트폴리오 합계 결과. */
export interface TtlSum {
  readonly ttl: number;
  /** 값을 내지 못해 합계에서 빠진 자산 수. */
  readonly missing: number;
  /** 합계에 시세 기반 항목이 섞였는가. */
  readonly volatile: boolean;
}

/**
 * TTL 합계. 모든 자산이 같은 자로 재어지므로 이제 성립한다.
 *
 * 값 미상 자산은 더하지 않고 missing 으로 센다. 화면은 반드시 그 수를 드러내야
 * 한다 — `?? 0` 으로 때우면 빠진 것을 숨긴 합계가 되고, 그건 거짓이다.
 */
export function sumTtl(values: readonly AssetValue[]): TtlSum {
  let ttl = 0;
  let missing = 0;
  let volatile = false;
  for (const v of values) {
    if (v.ttl === null) {
      missing += 1;
      continue;
    }
    ttl += v.ttl;
    if (v.volatile) volatile = true;
  }
  return { ttl, missing, volatile };
}
