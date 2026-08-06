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
  // **스냅샷의 decimals 를 쓴다. 호출자가 넘긴 값은 무시한다.**
  //
  // 호출자의 decimals 는 대개 익스플로러 응답(scan.ttl1.top)에서 온다. 그걸
  // 믿으면 익스플로러가 장악됐을 때 진짜 토큰 주소에 틀린 decimals 를 실어
  // 표시 수량과 TTL 환산값을 임의 배율로 부풀릴 수 있다 — decimals 가 12 면
  // 10^6 배, 0 이면 10^18 배다. 잔액 자체는 온체인 balanceOf 라 못 건드리지만
  // **보여지는 숫자는 건드릴 수 있다.**
  //
  // 스냅샷은 앵커라 저장소에 커밋돼 있고 사람이 검토한 값이다. 같은 주소에
  // 대해 정답을 이미 들고 있으므로 그걸 쓴다.
  return baseUnitsToNumber(baseUnits, rate.decimals) / rate.perTtl;
}

/**
 * 이 주소에 대해 **믿을 수 있는 decimals**. 스냅샷에 있으면 그 값, 없으면
 * 호출자가 준 값(일반 ERC-20 은 체인에서 읽은 값이라 그대로 쓴다).
 *
 * 표시 경로에서도 익스플로러가 준 decimals 를 그대로 쓰면 안 되므로,
 * 수량을 화면에 찍기 전에 이걸 거친다.
 */
export function authoritativeDecimals(address: string, fallback: number): number {
  const r = byAddress.get(address.toLowerCase());
  return r ? r.decimals : fallback;
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
 *
 * **부동소수로 내려오는 유일한 지점이다.** rates/value.ts 와 셸 4 종이 이 함수를
 * 공유한다 — 사본을 만들면 오차 한계를 한 곳에서 따질 수 없게 된다.
 */
export function baseUnitsToNumber(v: bigint, decimals: number): number {
  if (decimals <= 0) return Number(v);
  const d = 10n ** BigInt(decimals);
  const whole = v / d;
  const frac = v % d;
  return Number(whole) + Number(frac) / Number(d);
}

/**
 * **스테이블코인** 잔액(base unit) → TTL.
 *
 * tokenAmountToTtl 을 쓰면 안 된다. 그쪽은 rate.decimals 를 강제로 쓰는데, 그건
 * 토큰 주소 == rate 주소(= t{ISO} 통화토큰)일 때만 옳다. 스테이블은 다른
 * 컨트랙트다 — USDT decimals 6, tUSD decimals 18. 그대로 쓰면 100 USDT 가
 * 1e8/1e18/246.648 ≈ 4.05e-13 TTL 로 찍힌다(정답 0.405436 TTL). 10^12 배 오차다.
 *
 * 그래서 수량은 **그 토큰 자신의 decimals** 로 풀고, rate 에서는 perTtl 만 쓴다.
 *
 * decimals 는 반드시 내장 목록의 값을 넘겨라. 익스플로러가 준 값을 넘기면
 * 익스플로러가 장악됐을 때 표시 금액이 임의 배율로 부풀려진다
 * (authoritativeDecimals 와 같은 이유).
 *
 * rate 가 null(=그 ISO 가 스냅샷에 없음)이면 null 을 돌려준다. 0 이 아니다 —
 * 0 은 "가치 없음" 으로 읽힌다.
 *
 * 부동소수로 내려오는 지점은 baseUnitsToNumber 한 곳뿐이다. bigint 잔액을
 * 정수부/소수부로 갈라 Number 로 만들고 그 다음에야 나눗셈을 한다 — 먼저
 * Number(bigint) 로 통째 변환하면 decimals 18 토큰에서 2^53 을 넘겨 잔액
 * 상위 자릿수가 소리 없이 뭉개진다.
 */
export function stableAmountToTtl(
  baseUnits: bigint,
  tokenDecimals: number,
  rate: TokenRate | null,
): number | null {
  if (!rate || !(rate.perTtl > 0)) return null;
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) return null;
  return baseUnitsToNumber(baseUnits, tokenDecimals) / rate.perTtl;
}

/** 스냅샷 원본 — 산식·출처·입력값을 화면에 노출할 때 쓴다. */
export function snapshot(): RateSnapshot {
  return RATE_SNAPSHOT;
}
