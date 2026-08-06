// stable.ts — 스테이블코인의 **액면 통화**를 주소로 찾는 곳. 그리고 그 액면을
// 벼린 환율로 TTL 에 옮기는 유일한 함수.
//
// 왜 스테이블코인은 TTL 로 재고 BTC 는 안 재는가.
//
// 스테이블코인의 달러값은 시세가 아니라 **액면**이다 — 발행자가 1 USDT ≡ 1 USD
// 로 발행한다고 선언한 단위다. 그 액면 통화(USD)를 벼린 환율(GDP÷인구÷365)로
// TTL 에 옮기는 동안 시장 시세를 한 번도 읽지 않는다.
//
// BTC·ETH·SOL·TRX 의 달러값은 Binance **시장 시세**다. 그것도 TTL 로 재지만
// (2026-08-04 결정) 경로가 다르다 — 액면이 아니라 시세이므로 이 파일이 아니라
// rates/market.ts + value.ts 의 basis:'market' 로 간다. 여기(액면 색인)에
// 상장자산 주소를 넣으면 시세가 액면으로 둔갑해 화면이 둘을 구분하지 못한다.
// wrapped(WBTC·WETH)도 이름이 스테이블처럼 보일 뿐 값의 출처가 시장이라 같다.
//
// 왜 별도 모듈인가 (스냅샷에 넣지 않는 이유):
//   1) rateByAddress 는 키를 toLowerCase 한다. TRON base58check 는 대소문자가
//      정보라 그 인덱스에 넣으면 주소가 깨진다(chains/trc20-known.ts:10-14 와
//      같은 사유).
//   2) 스냅샷 주소는 교환 화면 견적(ExchangePane 의 rateByAddress(perTtl))에
//      그대로 쓰인다. 스테이블을 스냅샷에 넣으면 아무도 지시하지 않은
//      "고정비 스왑 가능 자산" 이 교환 UI 에 생긴다.
//
// 액면의 진실은 이 파일이 아니라 **내장 목록 두 곳**(tokens/registry.ts 의
// TokenInfo.faceIso, chains/trc20-known.ts 의 KnownTrc20.faceIso)에 있다.
// 여기서는 그 두 목록을 읽어 색인만 만든다 — 주소 1 개당 진실 1 개를 지키기
// 위해서다. 여기에 주소를 직접 적지 마라.

import { TokenRegistry } from '../tokens/registry.js';
import type { Address } from '../types.js';
import { KNOWN_TRC20 } from '../chains/trc20-known.js';
import { rateByAddress, rateByIso, stableAmountToTtl, tokenAmountToTtl } from './index.js';
import type { TokenRate } from './types.js';

/** 액면 판정이 가능한 주소 체계. */
export type StableFamily = 'evm' | 'tron';

/** 주소로 확인된 스테이블코인 한 종. */
export interface StableDenom {
  /** 정본 주소 (EVM 은 체크섬 표기, TRON 은 base58check 그대로). */
  address: string;
  family: StableFamily;
  /** EVM 이면 chainId, TRON 이면 null. */
  chainId: number | null;
  /** 표시용 심볼. **판정에는 절대 쓰지 않는다.** */
  symbol: string;
  /** 액면 통화 ISO — 이 값만 rateByIso 로 TTL 에 옮긴다. */
  iso: string;
  /** 내장 목록이 아는 decimals. 없으면(TRON USDT) 체인 값이 필요하다. */
  decimals: number | null;
  /** 이 항목의 저장소 내 출처. */
  evidence: string;
}

// EVM 색인: `${chainId}:${소문자주소}`. **chainId 를 반드시 키에 넣는다** —
// EVM 주소는 체인 간 재사용이 흔해서(CREATE2·동일 배포자 nonce) 주소만으로
// 키잉하면 한 체인의 스테이블 주소가 다른 체인의 무관한 토큰에 액면을 준다.
const EVM_INDEX = new Map<string, StableDenom>();
// TRON 색인: base58 **정확 일치**. 정규화하면 송금 불가 문자열이 "아는 토큰"이
// 된다. EVM 정책(소문자화)과 한 Map 에 섞지 않는 이유가 이것이다.
const TRON_INDEX = new Map<string, StableDenom>();

{
  // 격리 인스턴스 — 여기엔 아무도 addCustomToken 하지 않는다. 공용
  // defaultTokenRegistry() 를 쓰면 사용자 커스텀 토큰이 액면 판정원에 섞인다.
  const builtin = new TokenRegistry();
  for (const chainId of builtin.listChainIds()) {
    for (const t of builtin.getKnownTokens(chainId)) {
      if (t.faceIso === undefined || t.custom === true) continue;
      EVM_INDEX.set(`${chainId}:${t.address.toLowerCase()}`, {
        address: t.address,
        family: 'evm',
        chainId,
        symbol: t.symbol,
        iso: t.faceIso,
        decimals: t.decimals,
        evidence: 'packages/wallet-sdk/src/tokens/registry.ts BUILTIN.faceIso',
      });
    }
  }
  for (const t of KNOWN_TRC20) {
    if (t.faceIso === undefined) continue;
    TRON_INDEX.set(t.address, {
      address: t.address,
      family: 'tron',
      chainId: null,
      symbol: t.symbol,
      iso: t.faceIso,
      decimals: t.decimals ?? null,
      evidence: `packages/wallet-sdk/src/chains/trc20-known.ts (${t.evidence})`,
    });
  }
}

/**
 * 주소로 액면 통화를 찾는다. 없으면 null — 그 토큰은 스테이블이 아니다.
 *
 * **시그니처에 symbol 이 없다. 그것이 경계의 본체다.** 심볼은 발행자가 정하는
 * 임의 문자열이라 아무나 "USDT" 로 배포할 수 있고, 키릴 Т 를 섞으면 정규화
 * 정책에 따라 통과 여부가 뒤집힌다. 심볼로는 판정이 물리적으로 불가능해야 한다.
 *
 * family/chainId 가 안 맞으면 주소가 같아도 null 이다.
 */
export function stableDenomOf(
  id: string,
  family: string,
  chainId: number | null,
): StableDenom | null {
  if (family === 'tron') return TRON_INDEX.get(id) ?? null;
  if (chainId === null) return null;
  return EVM_INDEX.get(`${chainId}:${id.toLowerCase()}`) ?? null;
}

/** 이 주소가 EVM 내장 목록의 스테이블인지 (chainId 스코프). */
export function stableDenomOfEvm(chainId: number, address: Address): StableDenom | null {
  return EVM_INDEX.get(`${chainId}:${address.toLowerCase()}`) ?? null;
}

/** 색인 전체 — 테스트와 진단용. 순서는 보장하지 않는다. */
export function listStableDenoms(): readonly StableDenom[] {
  return [...EVM_INDEX.values(), ...TRON_INDEX.values()];
}

/**
 * @deprecated `assetValueInTtl` 의 `face` 분기가 이것을 흡수했다. 셸에서 부르면
 * 신원 판정(stableDenomOf)과 환산이 다시 2 단으로 갈라진다. 저수준 조각으로만
 * 남긴다 — 남은 호출부 배선이 끝나면 지운다.
 *
 * 스테이블 잔액(base unit) → TTL.
 *
 * decimals 는 내장 목록 값이 이긴다. 내장에 없을 때만(TRON USDT) 호출자가 준
 * 체인/익스플로러 값을 쓴다 — 그것마저 없으면 null 이고, 값을 비우는 것이
 * 틀린 배율로 찍는 것보다 낫다.
 *
 * 액면 ISO 가 스냅샷에 없으면 null 이다. USD 로 되돌아가지 않는다 — 되돌아가면
 * 같은 USDT 가 어떤 날은 TTL, 어떤 날은 USD 로 보인다.
 */
export function stableToTtl(
  baseUnits: bigint,
  denom: StableDenom,
  fallbackDecimals?: number,
): number | null {
  const d = denom.decimals ?? fallbackDecimals;
  if (d === undefined) return null;
  return stableAmountToTtl(baseUnits, d, rateByIso(denom.iso));
}

/** 이 액면 통화의 벼린 환율(= t{ISO} 의 TokenRate). 근거 패널 표시용. */
export function stableFaceRate(denom: StableDenom): TokenRate | null {
  return rateByIso(denom.iso);
}

// ────────────────────────────────────────────────────────────────────────────
// 토큰 신원 — "이 토큰에 값을 매겨도 되는가" 판정.
//
// 왜 여기에 붙였는가: 액면(위쪽)만으로는 화면 한 줄을 그릴 수 없다. 화면은
// 세 가지를 알아야 하는데 위쪽은 하나만 안다 — ① 액면·환산, ② 신원의 종류
// (벼린 환율 토큰인지, 액면 없는 내장 토큰인지, 아무것도 아닌지), ③ 시장
// 시세를 물어도 되는가. ②③ 이 없어서 셸이 자기 판정 함수를 짰고, 그 안에
// 환산까지 같이 넣어 두 셸의 산식이 갈라졌다(v0.5.21). 판정은 여기 한 곳에서만
// 한다.
//
// 여기에도 컨트랙트 주소를 적지 마라. 주소의 진실은 tokens/registry.ts 와
// chains/trc20-known.ts 두 곳뿐이고, 이 층은 그것을 조회만 한다.

/** 값을 매길 수 있는 신원 근거. null 은 "모른다" 이고, 모르면 값을 비운다. */
export type TokenIdentityKind = 'byeorin-rate' | 'evm-builtin' | 'trc20-known' | null;

/**
 * 신원 판정 결과.
 *
 * faceIso·decimals 가 kind 와 같은 객체에서만 나오는 것이 요점이다 — 신원이
 * 확인되지 않은 토큰에 액면을 붙일 경로가 구조적으로 없다.
 */
export interface TokenIdentity {
  readonly kind: TokenIdentityKind;
  /** 액면 통화 ISO. 스테이블일 때만 채워진다. 상장자산에는 영원히 없다. */
  readonly faceIso?: string;
  /** 내장 목록이 아는 decimals. 체인·익스플로러 값보다 이것이 우선한다. */
  readonly decimals?: number;
  /** 이 판정의 저장소 내 출처. 근거 패널이 그대로 보여줄 수 있다. */
  readonly evidence?: string;
}

/** 화면 한 줄이 값을 그리는 데 필요한 사실 전부. */
export interface TokenValue {
  readonly identity: TokenIdentity;
  /**
   * 이 행이 써야 할 자릿수 **하나**. 수량 표기와 TTL 환산이 같은 값을 쓰게
   * 하려고 한 번만 정한다 — 갈라지면 "100 USDT ≈ 0.0000004 TTL" 처럼 한 줄
   * 안에서 두 숫자가 서로를 부정한다.
   */
  readonly decimals: number;
  /** 액면 또는 벼린 환율로 옮긴 TTL. 낼 수 없으면 null(0 이 아니다). */
  readonly ttl: number | null;
  /** 근거 패널용 액면 환율. 액면이 없으면 null. */
  readonly faceRate: TokenRate | null;
  /**
   * 시장 시세(Binance)를 물어도 되는가.
   *
   * false 인 경우 셋: ① 신원 미확인 — 모르는 것에 값을 붙이지 않는다.
   * ② 벼린 환율 토큰 — TTL 눈금이 이미 있다. ③ 액면이 붙은 스테이블 — 그 ISO
   * 가 스냅샷에 없어 TTL 을 못 내도 USD 로 되돌아가지 않는다. 되돌아가면 같은
   * USDT 가 어떤 날은 TTL, 어떤 날은 USD 로 보인다.
   */
  readonly askMarketPrice: boolean;
}

export const UNKNOWN_TOKEN: TokenIdentity = Object.freeze({ kind: null });

/**
 * 내장 목록만 담은 격리 레지스트리 — 액면 색인과 같은 이유로 공용 인스턴스를
 * 쓰지 않는다. 공용을 보면 인덱서 탐색분·사용자 수동추가분이 섞여 "누가
 * 그렇게 말했다" 가 신원 근거로 승격된다.
 */
const IDENTITY_BUILTIN = new TokenRegistry();

/**
 * 주소로 신원을 판정한다. 네트워크를 타지 않는다 — 전부 앱 안 상수 조회.
 *
 * **심볼이 시그니처에 없다.** 위쪽 stableDenomOf 와 같은 이유다.
 */
export function tokenIdentityOf(
  id: string,
  family: string,
  chainId: number | null,
): TokenIdentity {
  // 벼린 환율 토큰(t{ISO}) 이 먼저다. TTL 눈금을 이미 가진 자산이라 액면이나
  // 시장 시세를 다시 물을 이유가 없다.
  if (rateByAddress(id) !== null) {
    return { kind: 'byeorin-rate', evidence: 'packages/wallet-sdk/src/rates/snapshot.ts' };
  }
  const denom = stableDenomOf(id, family, chainId);
  if (denom !== null) {
    return {
      kind: denom.family === 'tron' ? 'trc20-known' : 'evm-builtin',
      faceIso: denom.iso,
      // decimals 가 null 이면 비운다 — 저장소에 근거가 없으면 지어내지 않고
      // 호출자가 체인에서 읽어 준 값을 쓴다.
      decimals: denom.decimals ?? undefined,
      evidence: denom.evidence,
    };
  }
  // 액면 없는 내장 토큰(WETH 등). 신원은 확인됐지만 값의 출처가 시장이라
  // 액면 경로가 아니라 시세 경로(value.ts basis:'market')로 간다.
  if (family !== 'tron' && chainId !== null && /^0x[0-9a-fA-F]{40}$/.test(id)) {
    const info = IDENTITY_BUILTIN.getToken(chainId, id as Address);
    if (info !== undefined && info.custom !== true) {
      return {
        kind: 'evm-builtin',
        decimals: info.decimals,
        evidence: 'packages/wallet-sdk/src/tokens/registry.ts BUILTIN',
      };
    }
  }
  return UNKNOWN_TOKEN;
}

/**
 * @deprecated `assetValueInTtl`(rates/value.ts) 이 이 함수를 완전히 포함한다.
 * 차이는 시세 게이트다 — 여기서는 `askMarketPrice: true` 로 셸에 떠넘겼고,
 * 셸이 그 뒤를 각자 짜서 v0.5.21 에 4 벌로 갈라졌다. value.ts 는 시세표를
 * 인자로 받아 끝까지 계산하므로 셸에 중간 상태가 남지 않는다.
 * **새 호출부를 만들지 마라.** 남은 호출부 배선이 끝나면 이 함수는 지운다.
 *
 * 신원 판정 + 환산 + 시세 게이트를 한 번에 낸다.
 *
 * `decimals` 인자는 체인·인덱서가 준 자릿수다. 내장 목록이 아는 값이 있으면
 * 그것이 이긴다 — 출처가 장악되면 표시 배율이 10^n 배로 조작되기 때문이다.
 */
export function tokenValueOf(input: {
  id: string;
  family: string;
  chainId: number | null;
  balance: bigint;
  decimals: number;
}): TokenValue {
  const identity = tokenIdentityOf(input.id, input.family, input.chainId);
  const decimals = identity.decimals ?? input.decimals;
  if (identity.faceIso !== undefined) {
    const rate = rateByIso(identity.faceIso);
    return {
      identity,
      decimals,
      ttl: stableAmountToTtl(input.balance, decimals, rate),
      faceRate: rate,
      askMarketPrice: false,
    };
  }
  if (identity.kind === 'byeorin-rate') {
    return {
      identity,
      decimals,
      ttl: tokenAmountToTtl(input.balance, decimals, rateByAddress(input.id)),
      faceRate: null,
      askMarketPrice: false,
    };
  }
  // 신원 미확인이면 시세도 묻지 않는다. 물으면 심볼 문자열이 다시 판정원이
  // 되고, 가짜 USDT 가 값을 얻는다.
  return { identity, decimals, ttl: null, faceRate: null, askMarketPrice: identity.kind !== null };
}
