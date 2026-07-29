// token-visibility.ts — 토큰 목록 화면의 "가리기 상태 · 검색 · 정렬" 순수 로직 + 영속화.
//
// **체인 무관이다.** 입력은 EVM 전용 `DiscoveredBalance` 가 아니라 wallet-sdk 의
// 체인 무관 토큰 잔액(`PortableTokenBalance`)이다. EVM 컨트랙트 주소든 Solana
// mint 든 Cosmos denom 이든 같은 형식으로 들어오므로 이 모듈에도, 화면에도
// 체인별 분기가 없다.
//
// TTL 체인에 통화 스테이블이 66 종 발행돼 있다. 목록 화면이 쓸 판단(무엇을
// 보여줄지, 어떤 순서로, 검색어에 걸리는지)을 전부 여기로 뺐다. UI 를 렌더하지
// 않고 vitest(node 환경)로 그대로 검증하기 위해서다 — 확장 vitest 에는 jsdom 이 없다.
//
// 저장 규칙: **가린 목록만 저장한다(deny-list).** allowlist 로 저장하면 새 통화
// 토큰이 발행됐을 때 목록에 영영 안 나타난다. 지갑이 자동 감지하는 값이므로
// "기본은 보임, 사용자가 끈 것만 기억" 이 맞다.
//
// 환율은 재구현하지 않는다 — wallet-sdk 의 `rateByAddress` / `tokenAmountToTtl`
// 을 그대로 쓴다. 다만 테스트에서 스냅샷 실제 주소에 묶이지 않도록 조회 함수를
// 주입 가능하게 열어 뒀다. 벼린 환율은 TTL 체인의 통화토큰 66 종에만 있으므로
// 그 밖의 토큰은 가치 자리를 **비운다** — 0 이나 추정치를 넣지 않는다.

import {
  rateByAddress,
  tokenAmountToTtl,
  authoritativeDecimals,
  unresolvedRates,
  type TokenRate,
} from '@byeorin/wallet-sdk/evm';

// ────────── 체인 무관 토큰 잔액 ──────────

/**
 * wallet-sdk `packages/wallet-sdk/src/tokens/portable.ts` 의 `PortableTokenBalance`
 * 와 **구조가 같은** 선언.
 *
 * 왜 import 하지 않는가: 그 타입이 아직 wallet-sdk 의 공개 barrel(`./core`,
 * `./evm`)에 노출돼 있지 않아 `@byeorin/wallet-sdk/*` 로 가져올 수 없다. 셸의
 * typecheck 는 wallet-sdk 를 다시 빌드하지 않고 기존 `dist/*.d.ts` 로 해석하므로
 * 지금 import 하면 타입 검사가 깨진다.
 *
 * TypeScript 는 구조적 타입이라 SDK 의 `PortableTokenBalance[]` 를 그대로 넘겨도
 * 문제없이 맞는다. barrel 에 노출되면 이 선언을 지우고 한 줄로 바꾸면 된다:
 *   `import type { PortableTokenBalance } from '@byeorin/wallet-sdk/core';`
 */
export interface PortableTokenBalance {
  /** 체인 안에서 이 토큰을 가리키는 식별자. TransferIntent.asset 에 그대로 쓴다. */
  id: string;
  symbol: string;
  name: string;
  /** base unit → 표시 단위 변환에 쓰는 자릿수. */
  decimals: number;
  /** base unit 잔액. */
  balance: bigint;
  /** 값의 출처가 체인 자체가 아니라 인덱서/외부 API 인 경우 그 이름. */
  source?: string;
}

// ────────── 저장 형태 ──────────

/** chrome.storage.local 키. 다른 확장 저장값과 같은 `nd:` 접두를 쓴다. */
export const HIDDEN_TOKENS_KEY = 'nd:hidden-tokens';

/**
 * 체인키 → 가린 토큰 식별자(소문자) 목록.
 *
 * 체인별로 나누는 이유: 같은 문자열이 다른 체인에서 다른 토큰이다. 한 체인에서
 * 가린 게 다른 체인의 토큰까지 지우면 안 된다.
 */
export type HiddenMap = Readonly<Record<string, readonly string[]>>;

/** 빈 상태 상수 — 호출부가 매번 `{}` 리터럴을 만들지 않게. */
export const EMPTY_HIDDEN: HiddenMap = Object.freeze({});

/**
 * 저장된 문자열 → HiddenMap.
 *
 * 깨진 값(수동 편집, 구버전 포맷)이 화면 전체를 막으면 안 되므로 예외를 던지지
 * 않고 빈 맵으로 떨어진다. 가리기 상태를 잃는 것은 복구 가능한 손실이고,
 * 토큰 목록을 못 여는 것은 아니다.
 */
export function parseHidden(raw: string | null): HiddenMap {
  if (!raw) return EMPTY_HIDDEN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_HIDDEN;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return EMPTY_HIDDEN;
  }
  const out: Record<string, string[]> = {};
  for (const [chainKey, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const addrs = value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.toLowerCase());
    if (addrs.length > 0) out[chainKey] = dedupe(addrs);
  }
  return out;
}

/** HiddenMap → 저장 문자열. 빈 체인 항목은 남기지 않는다. */
export function serializeHidden(map: HiddenMap): string {
  const out: Record<string, readonly string[]> = {};
  for (const [chainKey, addrs] of Object.entries(map)) {
    if (addrs.length > 0) out[chainKey] = addrs;
  }
  return JSON.stringify(out);
}

/**
 * 해당 체인에서 이 토큰이 가려져 있는가.
 *
 * 대소문자를 무시한다 — EVM 체크섬 주소를 흡수하기 위해서다. Solana mint 처럼
 * 대소문자가 의미를 갖는 식별자도 저장·비교가 **양쪽 다** 소문자로 정규화되므로
 * 판정은 일관된다(표시는 원본 문자열을 그대로 쓴다).
 */
export function isHidden(map: HiddenMap, chainKey: string, id: string): boolean {
  const list = map[chainKey];
  if (!list) return false;
  return list.includes(id.toLowerCase());
}

/**
 * 가리기 상태를 바꾼 **새** 맵을 돌려준다 (원본 불변).
 *
 * 같은 값을 다시 넣어도 목록이 커지지 않는다(idempotent). 되돌리기(hidden=false)
 * 는 항목을 제거하므로, 가린 토큰은 언제든 원상복구된다.
 */
export function withHidden(
  map: HiddenMap,
  chainKey: string,
  id: string,
  hidden: boolean,
): HiddenMap {
  const key = id.toLowerCase();
  const current = map[chainKey] ?? [];
  const has = current.includes(key);
  if (hidden === has) return map; // 변화 없음 — 참조까지 유지해 불필요한 렌더 방지
  const next = hidden ? [...current, key] : current.filter((a) => a !== key);
  const out: Record<string, readonly string[]> = { ...map };
  if (next.length > 0) out[chainKey] = next;
  else delete out[chainKey];
  return out;
}

/** 해당 체인에서 가린 토큰 식별자 목록. */
export function hiddenAddresses(map: HiddenMap, chainKey: string): readonly string[] {
  return map[chainKey] ?? [];
}

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)];
}

// ────────── 영속화 ──────────

/**
 * chrome.storage.local 백엔드의 최소 표면.
 *
 * shell-core 의 `ChromeLocalBackend` 가 이 형태를 그대로 만족한다 — 그래서
 * 저장 계층을 새로 만들지 않고 그것을 주입해 쓴다. 인터페이스로 받는 이유는
 * 테스트에서 메모리 구현으로 갈아끼우기 위해서다(shell-core 의 `PersistentBackend`
 * 와 구조적으로 동일).
 */
export interface HiddenTokensBackend {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 읽기 — 실패(권한 없음/비확장 런타임)해도 빈 맵. 목록 화면을 막지 않는다. */
export async function loadHidden(backend: HiddenTokensBackend): Promise<HiddenMap> {
  try {
    return parseHidden(await backend.read(HIDDEN_TOKENS_KEY));
  } catch {
    return EMPTY_HIDDEN;
  }
}

/** 쓰기 — 실패해도 throw 하지 않고 false. 화면은 메모리 상태로 계속 동작한다. */
export async function saveHidden(
  backend: HiddenTokensBackend,
  map: HiddenMap,
): Promise<boolean> {
  try {
    await backend.write(HIDDEN_TOKENS_KEY, serializeHidden(map));
    return true;
  } catch {
    return false;
  }
}

// ────────── 행(row) 구성 ──────────

/** 스냅샷이 아는 통화 정보. 환율이 없어도 국가/ISO 는 알 수 있는 경우가 있다. */
export interface TokenMeta {
  /** 벼린 환율. null 이면 가치 자리를 비운다 — 0 이나 추정치를 넣지 않는다. */
  readonly rate: TokenRate | null;
  /** 통화 ISO (USD, JPY…). 모르면 null. */
  readonly iso: string | null;
  /** 국가명(영문, World Bank 표기). 모르면 null. */
  readonly country: string | null;
  /** 환율을 내지 못한 사유. 환율이 있으면 null. */
  readonly unresolvedReason: string | null;
}

/** 목록 한 줄이 표시에 필요한 사실 전부. */
export interface TokenRow {
  /**
   * 체인 안에서 이 토큰을 가리키는 식별자, 원본 표기 그대로.
   * EVM 은 체크섬 주소, Solana 는 base58 mint, Cosmos 는 denom …
   */
  readonly id: string;
  /** 소문자 id — 비교·저장·React key 용. */
  readonly key: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly balance: bigint;
  readonly hidden: boolean;
  readonly meta: TokenMeta;
  /** 잔액의 TTL 환산. 환율이 없으면 null. */
  readonly ttl: number | null;
  /**
   * 이 잔액을 누가 말해줬는가. 체인에서 직접 읽었으면 null, 인덱서/외부 API 가
   * 준 값이면 그 이름. 신뢰도가 다르므로 화면이 근거 패널에 그대로 노출한다.
   */
  readonly source: string | null;
}

/** 토큰 식별자/심볼 → 통화 메타. 기본 구현은 벼린 스냅샷 조회. */
export type MetaResolver = (id: string, symbol: string) => TokenMeta;

const NO_META: TokenMeta = {
  rate: null,
  iso: null,
  country: null,
  unresolvedReason: null,
};

/** EVM 컨트랙트 주소 형식. 벼린 환율 스냅샷의 색인 키가 이 형식이다. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * 기본 메타 조회.
 *
 * 0) 식별자가 EVM 주소 형식이 아니면 곧바로 포기한다. 벼린 환율 스냅샷은 TTL
 *    체인의 ERC-20 주소로만 색인돼 있어 Solana mint·Cosmos denom 은 있을 수
 *    없고, 아래 2) 의 심볼 조회가 다른 체인의 동명 토큰을 엉뚱한 나라 통화로
 *    둔갑시키는 것도 여기서 막힌다.
 * 1) 주소로 환율을 찾는다 — 심볼로 찾지 않는 이유는 심볼이 겹칠 수 있어서다
 *    (tUSD 가 TrueUSD 와 충돌한 전례).
 * 2) 없으면 `unresolved` 목록을 심볼로 뒤진다. 여기엔 주소가 없다. 대만 tTWD 가
 *    실제로 이 경로를 탄다 — 환율은 못 내지만 국가/사유는 보여줄 수 있다.
 */
export function defaultMetaResolver(id: string, symbol: string): TokenMeta {
  if (!EVM_ADDRESS_RE.test(id)) return NO_META;
  const rate = rateByAddress(id);
  if (rate) {
    return {
      rate,
      iso: rate.iso,
      // 통화동맹(EUR·XOF)은 한 나라의 통화가 아니다. 토큰 목록이 물려준
      // country 는 대표국 하나뿐이라(XOF → "Cote d'Ivoire") 그대로 쓰면
      // 8 개국 합산 인구 옆에 한 나라 이름이 붙어 화면이 거짓을 말한다.
      country: rate.iso3Members
        ? `${rate.iso} 통화권 · ${rate.iso3Members.length}개국`
        : rate.country,
      unresolvedReason: null,
    };
  }
  const u = unresolvedRates().find((r) => r.symbol === symbol);
  if (u) {
    return { rate: null, iso: u.iso, country: u.country, unresolvedReason: u.reason };
  }
  return NO_META;
}

/**
 * PortableTokenBalance[] → TokenRow[].
 *
 * 정렬·필터는 여기서 하지 않는다(별도 함수). 이 단계는 "사실 붙이기" 만 한다.
 * 어느 체인에서 왔는지 묻지 않는다 — 입력 형식이 하나이므로 분기가 없다.
 */
export function buildTokenRows(
  tokens: readonly PortableTokenBalance[],
  hidden: HiddenMap,
  chainKey: string,
  resolveMeta: MetaResolver = defaultMetaResolver,
): TokenRow[] {
  return tokens.map((tok) => {
    const meta = resolveMeta(tok.id, tok.symbol);
    return {
      id: tok.id,
      key: tok.id.toLowerCase(),
      symbol: tok.symbol,
      name: tok.name,
      // 익스플로러/인덱서가 준 decimals 를 그대로 표시에 쓰지 않는다. 스냅샷에
      // 있는 토큰은 스냅샷 값이 이긴다 — 안 그러면 출처가 장악됐을 때 보여지는
      // 수량이 임의 배율로 부푼다. 스냅샷에 없으면(대부분의 비-TTL 토큰) 받은
      // 값을 그대로 쓴다.
      decimals: authoritativeDecimals(tok.id, tok.decimals),
      balance: tok.balance,
      hidden: isHidden(hidden, chainKey, tok.id),
      meta,
      ttl: tokenAmountToTtl(tok.balance, tok.decimals, meta.rate),
      source: tok.source ?? null,
    };
  });
}

// ────────── 검색 ──────────

/**
 * 검색어 매칭 — 심볼 · 통화 ISO · 국가명 · 토큰 풀네임 · 식별자 조각.
 *
 * 66 종 중에서 사용자가 아는 단서는 대개 "tKRW" 아니면 "Korea" 다. 둘 다 걸리게
 * 한다. 공백으로 나눈 여러 단어는 **모두** 만족해야 한다(AND) — 좁혀 들어가는
 * 검색이 자연스럽다.
 *
 * `source` 는 검색 대상에 넣지 않는다. 인덱서 이름("ttlscan")으로 목록이 통째로
 * 걸리면 검색이 좁혀지지 않고 넓어진다 — 사용자가 찾는 단서가 아니다.
 */
export function matchesQuery(row: TokenRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row.symbol,
    row.name,
    row.meta.iso ?? '',
    row.meta.country ?? '',
    // 표시는 통화권이지만 검색은 원래 국가명과 회원국 코드로도 걸려야 한다.
    row.meta.rate?.country ?? '',
    row.meta.rate?.iso3 ?? '',
    ...(row.meta.rate?.iso3Members ?? []),
    row.key,
  ]
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

// ────────── 정렬 ──────────

/**
 * 보유(잔액>0) 우선 → 그 다음 심볼 오름차순.
 *
 * 66 줄 중 잔액 있는 몇 줄을 찾으려 스크롤하게 만들지 않기 위한 규칙이다.
 * 잔액 크기순으로 더 정렬하지 않는 이유: 통화마다 단위 크기가 달라(1 tKRW 와
 * 1 tUSD) 숫자 비교가 의미를 갖지 않는다. TTL 환산값 정렬도 환율 없는 토큰이
 * 끼면 순서가 흔들려 쓰지 않는다.
 */
export function sortTokenRows(rows: readonly TokenRow[]): TokenRow[] {
  return [...rows].sort((a, b) => {
    const aHeld = a.balance > 0n ? 0 : 1;
    const bHeld = b.balance > 0n ? 0 : 1;
    if (aHeld !== bHeld) return aHeld - bHeld;
    return a.symbol.localeCompare(b.symbol, 'en');
  });
}

// ────────── 화면이 쓰는 최종 조합 ──────────

export interface TokenViewOptions {
  readonly query: string;
  /** true 면 가린 항목 목록을, false 면 보이는 목록을 본다. */
  readonly showHidden: boolean;
}

export interface TokenView {
  /** 현재 탭(보임/가림)에서 검색어까지 통과한 줄. 정렬 완료. */
  readonly rows: readonly TokenRow[];
  /** 가린 항목 총수 — 검색어와 무관. "가린 항목 N" 배지에 쓴다. */
  readonly hiddenCount: number;
  /** 보이는 항목 총수 — 검색어와 무관. "검색 결과 없음" 과 "토큰 없음" 구분용. */
  readonly visibleCount: number;
}

/**
 * 행 목록 → 화면이 그대로 그릴 뷰.
 *
 * 가린 항목을 "삭제" 하지 않고 다른 탭으로 옮기기만 한다 — 되돌릴 수 없는 UI 를
 * 만들지 않기 위해서다.
 */
export function selectTokenView(
  rows: readonly TokenRow[],
  opts: TokenViewOptions,
): TokenView {
  const hiddenRows = rows.filter((r) => r.hidden);
  const visibleRows = rows.filter((r) => !r.hidden);
  const pool = opts.showHidden ? hiddenRows : visibleRows;
  return {
    rows: sortTokenRows(pool.filter((r) => matchesQuery(r, opts.query))),
    hiddenCount: hiddenRows.length,
    visibleCount: visibleRows.length,
  };
}

// ────────── 표시 포맷 ──────────

/**
 * TTL 환산값 → 표시 문자열. null 은 호출부가 처리한다(빈 자리).
 *
 * 값 폭이 크다 — 1 TTL 미만도, 수만 TTL 도 나온다. 유효숫자를 잃지 않도록
 * 1 미만은 소수 4 자리, 그 이상은 소수 2 자리 + 천 단위 쉼표로 끊는다.
 */
export function formatTtl(ttl: number): string {
  if (!Number.isFinite(ttl)) return '—';
  if (ttl === 0) return '0';
  if (Math.abs(ttl) < 0.0001) return '<0.0001';
  const digits = Math.abs(ttl) < 1 ? 4 : 2;
  return ttl.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 근거 패널의 큰 수(GDP·인구) 표기 — 지수 표기 없이 쉼표로 끊는다. */
export function formatBigNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

/** 환율(perTtl) 표기 — 통화마다 자릿수 차가 커서 유효숫자 6 자리로 맞춘다. */
export function formatPerTtl(perTtl: number): string {
  if (!Number.isFinite(perTtl) || perTtl <= 0) return '—';
  const digits = perTtl >= 1000 ? 2 : perTtl >= 1 ? 4 : 6;
  return perTtl.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
