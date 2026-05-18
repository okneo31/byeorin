// i18n.ts — 벼린 경량 i18n 코어.
//
// 책임:
//  - 현재 로케일 보유 (`ko` | `en`), 기본은 `ko`.
//  - `t(key, vars?)` 으로 카탈로그 조회 + 변수 인터폴레이션 + 단순 plural.
//  - 로케일 변경 리스너 (React 바깥 컨텍스트, 예: SDK 어댑터/서비스 워커 용).
//
// 의존성: 없음. (i18next 50KB+ 회피. 우리 케이스는 카탈로그가 2개뿐이고
// ICU 풀스펙이 필요 없으므로 작은 reducer 면 충분.)
//
// ICU-lite 문법 지원:
//   1) `{var}`          — 변수 치환.
//   2) `{var, plural, one {...} other {...}}` — 정수 plural. `#` 은 변수 값으로 치환.
//
// 본 구현은 plural rule 을 영어/한국어 양쪽에서 `n === 1 ? 'one' : 'other'` 로
// 단순화한다. 한국어는 사실상 plural 구분이 없으므로 `other` 만 채우면 되고,
// 영어는 `one`/`other` 둘 다 채우면 된다. (PluralRules API 까지 가져오지 않는다.)

export type Locale = 'ko' | 'en';

/** 카탈로그 한 묶음. 키는 dot-notation 으로 묶지만 평탄한 string→string 맵. */
export type Catalog = Readonly<Record<string, string>>;

/** 보유 카탈로그. 두 로케일 다 같은 키 집합을 가지는 것이 원칙. */
export type Catalogs = Readonly<Record<Locale, Catalog>>;

/** 인터폴레이션에 쓸 변수 맵. 숫자/문자 둘 다 허용. */
export type Vars = Readonly<Record<string, string | number>>;

interface State {
  locale: Locale;
  catalogs: Catalogs;
  fallback: Locale;
  listeners: Set<(loc: Locale) => void>;
}

// 모듈 단위 싱글톤. React Provider 와 동일한 store 를 공유하므로, useT() 와
// 비-React `t()` 호출이 동일한 결과를 낸다.
const state: State = {
  locale: 'ko',
  catalogs: { ko: {}, en: {} },
  fallback: 'ko',
  listeners: new Set(),
};

/**
 * i18n 시스템을 카탈로그와 함께 초기화한다.
 *
 * 앱 부팅 시 한 번 호출. 카탈로그가 비어 있으면 `t()` 는 key 문자열을 그대로 돌려준다.
 *
 * @param opts.catalogs   ko/en 카탈로그 매핑
 * @param opts.initialLocale 초기 로케일 (기본 'ko')
 * @param opts.fallback   누락 시 폴백 로케일 (기본 'ko')
 */
export function configureI18n(opts: {
  catalogs: Catalogs;
  initialLocale?: Locale;
  fallback?: Locale;
}): void {
  state.catalogs = opts.catalogs;
  state.fallback = opts.fallback ?? 'ko';
  if (opts.initialLocale && opts.initialLocale !== state.locale) {
    state.locale = opts.initialLocale;
    emit();
  }
}

/** 현재 로케일. */
export function getLocale(): Locale {
  return state.locale;
}

/** 로케일을 변경한다. 변경된 경우에만 리스너에게 알린다. */
export function setLocale(locale: Locale): void {
  if (locale === state.locale) return;
  state.locale = locale;
  emit();
}

/**
 * 로케일 변경 리스너 등록. unsubscribe 함수를 반환한다.
 *
 * 호출 시점에 리스너가 즉시 한 번 실행되지는 않는다 — React 외부에서 "현재 값을
 * 한 번 읽고 그 다음부터는 변경만 받겠다" 가 일반적인 패턴이므로.
 */
export function onLocaleChange(fn: (loc: Locale) => void): () => void {
  state.listeners.add(fn);
  return () => {
    state.listeners.delete(fn);
  };
}

function emit(): void {
  for (const fn of state.listeners) {
    try {
      fn(state.locale);
    } catch {
      // 리스너 한 개가 던져도 다른 리스너에 영향 없게 swallow.
    }
  }
}

/**
 * 카탈로그에서 메시지를 조회하고 변수/plural 을 적용한 최종 문자열을 돌려준다.
 *
 * 폴백 체인:
 *   1) 현재 로케일에서 키 검색.
 *   2) 없으면 fallback 로케일에서 검색.
 *   3) 그것도 없으면 key 문자열 자체를 돌려준다 (개발자에게 "키 미정의" 가시화).
 *
 * @example
 *   t('home.create_button')                       // "지갑 생성"
 *   t('balance.summary', { amount: '10', symbol: 'TTL' })
 *   t('tokens.count', { count: 3 })               // "3개의 토큰"
 */
export function t(key: string, vars?: Vars): string {
  const cur = state.catalogs[state.locale];
  const fb = state.catalogs[state.fallback];
  const raw = cur[key] ?? fb[key] ?? key;
  return format(raw, vars);
}

// ───────── ICU-lite 포매터 ─────────
//
// 두 가지 케이스만 처리:
//   A) `{name}`                       — 단순 변수 치환
//   B) `{name, plural, one {...} other {...}}` — 단순 plural
//
// 중첩(B 안에 A) 도 지원한다. 예:
//   "{n, plural, one {1개의 토큰} other {{n}개의 토큰}}"
//
// 파서는 nest depth 를 brace counter 로 추적해 외측 `{...}` 블록을 정확히 잡아낸다.
// 풀 ICU 가 필요하면 formatjs 로 교체. 우리 카탈로그는 단순 plural 만 쓰므로 충분.

function format(template: string, vars: Vars | undefined): string {
  if (vars === undefined && !template.includes('{')) return template;
  return parseAndFormat(template, vars ?? {});
}

function parseAndFormat(template: string, vars: Vars): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '{') {
      out += ch;
      i++;
      continue;
    }
    // brace block. 짝 맞는 `}` 까지 잘라낸다.
    const end = findMatchingBrace(template, i);
    if (end === -1) {
      // 짝이 안 맞으면 리터럴로 보고 그냥 흘려보낸다.
      out += ch;
      i++;
      continue;
    }
    const inner = template.slice(i + 1, end);
    out += renderBlock(inner, vars);
    i = end + 1;
  }
  return out;
}

function findMatchingBrace(s: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function renderBlock(inner: string, vars: Vars): string {
  // 첫 번째 콤마 인덱스 (단, 콤마는 brace depth 0 일 때만 분리자로 본다.)
  const firstComma = topLevelComma(inner);
  if (firstComma === -1) {
    // 단순 `{name}` 케이스.
    const name = inner.trim();
    return formatVar(vars[name]);
  }
  const name = inner.slice(0, firstComma).trim();
  const rest = inner.slice(firstComma + 1).trim();
  // rest 의 첫 키워드(`plural`) 만 지원. 그 외는 단순 변수로 fallback.
  const secondComma = topLevelComma(rest);
  const kind = (secondComma === -1 ? rest : rest.slice(0, secondComma)).trim();
  if (kind !== 'plural') {
    return formatVar(vars[name]);
  }
  const branches = secondComma === -1 ? '' : rest.slice(secondComma + 1).trim();
  return renderPlural(name, branches, vars);
}

function topLevelComma(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',' && depth === 0) return i;
  }
  return -1;
}

/**
 * `{name, plural, one {...} other {...}}` 의 branches 영역을 파싱한다.
 *
 * 입력: `"one {1개의 토큰} other {{n}개의 토큰}"`
 * 출력: 변수값 n 에 따라 알맞은 분기 결과.
 *
 * 한국어는 plural 구분이 없으므로 `other` 만 채우면 되고, plural rule 도 영어 기준
 * `n === 1 ? 'one' : 'other'` 로 통일한다. (CLDR 의 few/many/zero 는 미지원.)
 */
function renderPlural(name: string, branches: string, vars: Vars): string {
  const value = Number(vars[name] ?? 0);
  const branchMap = parseBranches(branches);
  const key = value === 1 ? 'one' : 'other';
  const template = branchMap[key] ?? branchMap.other ?? '';
  // plural 분기 안에서 `#` 은 변수값으로 치환된다. 그리고 다시 `{var}` 인터폴레이션을 적용.
  const withHash = template.replace(/#/g, String(value));
  return parseAndFormat(withHash, vars);
}

function parseBranches(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    // 공백 스킵
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    // 키워드 (예: 'one', 'other', '=0' 도 인식 — 우선 단순 키워드만)
    const keyStart = i;
    while (i < s.length && !/\s|\{/.test(s[i]!)) i++;
    const keyword = s.slice(keyStart, i).trim();
    // 공백 스킵
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] !== '{') break;
    const end = findMatchingBrace(s, i);
    if (end === -1) break;
    out[keyword] = s.slice(i + 1, end);
    i = end + 1;
  }
  return out;
}

function formatVar(v: string | number | undefined): string {
  if (v === undefined) return '';
  return typeof v === 'number' ? String(v) : v;
}

/**
 * 테스트/디버그 용: 내부 상태를 초기 상태로 되돌린다.
 *
 * 프로덕션 코드에서는 호출하지 않는다 — Provider 가 mount 될 때 configureI18n 이
 * 새 카탈로그를 덮어쓰면 충분.
 */
export function _resetI18n(): void {
  state.locale = 'ko';
  state.catalogs = { ko: {}, en: {} };
  state.fallback = 'ko';
  state.listeners.clear();
}
