// rates — 벼린 환율. TTL 이 기준이고 각국 통화토큰이 여기에 매달린다.
//
// 원칙: 1 TTL = 노동자 1일 품삯. 국적과 무관하다.
//   그 나라에서 하루 품삯이 그 통화로 얼마인가 = 그 통화의 TTL 환율.
//   시장환율을 보지 않는다. 시장은 "베트남의 하루가 미국의 하루보다 19배 싸다"
//   고 말하지만 이 체계는 그걸 거부한다. 하루는 하루다.
//
// 스냅샷은 앵커다 — 2025 명목GDP/인구로 한 번 만들고 외부 데이터를 다시 보지
// 않는다. BTC 페깅을 해제한 것과 같은 방식이다.
//
// 주의: t{ISO} 토큰은 실제 그 나라 통화가 **아니다.** tUSD 는 실제 달러와
// 1:1 이 아니고, TTL 노동 기준으로 값이 정해진다. 실제 통화와 섞어 생각하면
// 안 된다.

import { RATE_SNAPSHOT } from './snapshot.js';
import type { RateSnapshot, TokenRate, UnresolvedRate } from './types.js';

export type { RateSnapshot, TokenRate, UnresolvedRate, RateInputs } from './types.js';
export { RATE_SNAPSHOT } from './snapshot.js';

const byAddress = new Map<string, TokenRate>();
const byIso = new Map<string, TokenRate>();
for (const r of RATE_SNAPSHOT.rates) {
  byAddress.set(r.address.toLowerCase(), r);
  byIso.set(r.iso.toUpperCase(), r);
}

/**
 * 컨트랙트 주소로 환율을 찾는다. 심볼이 아니라 주소로 맞추는 이유는 심볼이
 * 겹칠 수 있기 때문이다 — 실제로 tUSD 가 TrueUSD(TUSD) 와 충돌한 적이 있다.
 */
export function rateByAddress(address: string): TokenRate | null {
  return byAddress.get(address.toLowerCase()) ?? null;
}

/** 통화 ISO(USD, JPY…)로 환율을 찾는다. */
export function rateByIso(iso: string): TokenRate | null {
  return byIso.get(iso.toUpperCase()) ?? null;
}

/** 환율을 내지 못한 토큰 목록. 지갑은 이들을 "가치 미표시"로 처리한다. */
export function unresolvedRates(): readonly UnresolvedRate[] {
  return RATE_SNAPSHOT.unresolved;
}

/**
 * 토큰 잔액(base unit) → TTL.
 *
 * 1 TTL = perTtl 단위의 토큰이므로, 토큰 수량을 perTtl 로 나누면 TTL 이 된다.
 * 환율을 모르는 토큰은 null — 0 을 돌려주면 "가치 없음" 으로 오해된다.
 */
export function tokenAmountToTtl(
  baseUnits: bigint,
  decimals: number,
  rate: TokenRate | null,
): number | null {
  if (!rate || !(rate.perTtl > 0)) return null;
  return baseUnitsToNumber(baseUnits, decimals) / rate.perTtl;
}

/** TTL → 토큰 수량(사람이 읽는 단위). */
export function ttlToTokenAmount(ttl: number, rate: TokenRate | null): number | null {
  if (!rate || !(rate.perTtl > 0)) return null;
  return ttl * rate.perTtl;
}

/**
 * 두 통화토큰 사이의 교환비 — 1 단위의 from 이 몇 단위의 to 인가.
 *
 * TTL 을 거쳐 계산되므로 TTL 의 절대 눈금은 약분되어 사라진다. 즉 이 값은
 * TTL 이 외부에서 얼마로 평가되든 영향받지 않는다.
 */
export function crossRate(from: TokenRate | null, to: TokenRate | null): number | null {
  if (!from || !to || !(from.perTtl > 0) || !(to.perTtl > 0)) return null;
  return to.perTtl / from.perTtl;
}

/**
 * base unit(bigint) → 사람이 읽는 수. decimals 가 큰 토큰에서 Number 정밀도가
 * 깨지지 않도록 정수부와 소수부를 나눠 만든다.
 */
function baseUnitsToNumber(v: bigint, decimals: number): number {
  if (decimals <= 0) return Number(v);
  const d = 10n ** BigInt(decimals);
  const whole = v / d;
  const frac = v % d;
  return Number(whole) + Number(frac) / Number(d);
}

/** 스냅샷 원본 — 산식·출처·입력값을 화면에 노출할 때 쓴다. */
export function snapshot(): RateSnapshot {
  return RATE_SNAPSHOT;
}
