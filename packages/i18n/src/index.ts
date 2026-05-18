// index.ts — i18n 패키지 엔트리.
//
// 비-React 컨텍스트(서비스 워커, SDK 어댑터, CLI 도구 등) 는 본 모듈에서 직접
// `configureI18n` / `t` / `setLocale` 을 가져다 쓴다. React 앱은
// `@byeorin/i18n/react` 의 Provider/Hook 을 함께 쓴다.

export {
  configureI18n,
  getLocale,
  setLocale,
  onLocaleChange,
  t,
  type Locale,
  type Catalog,
  type Catalogs,
  type Vars,
  _resetI18n,
} from './i18n.js';

export { ko, en, catalogs } from './messages/index.js';

/**
 * shell-core 의 error.code 를 i18n 키로 변환하기 위한 작은 헬퍼.
 *
 * 예: `errorMessageKey('wallet.locked')` → `'errors.wallet.locked'`
 */
export function errorMessageKey(code: string): string {
  return `errors.${code}`;
}
