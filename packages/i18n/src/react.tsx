// react.tsx — i18n React 바인딩.
//
// 책임:
//  - `<I18nProvider>` 가 카탈로그 + 초기 로케일을 부팅 시 1회 설정한다.
//  - `useT()` 가 로케일 변경에 반응해 `t` 를 다시 돌려준다.
//  - `<LocaleSwitch />` 단순 토글 UI.
//  - 로케일 영속화는 호출자(앱) 가 책임진다 — Provider 의 `storage` prop 으로 주입.
//    (web/desktop = localStorage, extension = chrome.storage.sync, mobile = in-memory)
//
// 의존성: react 만. CSS 는 호출자가 알아서. JSX 는 react-jsx 자동 런타임.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  configureI18n,
  getLocale,
  onLocaleChange,
  setLocale as _setLocale,
  t as _t,
  type Catalogs,
  type Locale,
  type Vars,
} from './i18n.js';
import { catalogs as defaultCatalogs } from './messages/index.js';

/**
 * 로케일 영속화 인터페이스.
 *
 * 동기 / 비동기 양쪽을 지원하기 위해 read 는 `Locale | null | Promise<...>` 를
 * 돌려줄 수 있다. Provider 는 결과를 await 한다.
 */
export interface LocaleStorage {
  read(): Locale | null | Promise<Locale | null>;
  write(locale: Locale): void | Promise<void>;
}

/**
 * localStorage 기반 영속화 — web / desktop.
 * key 기본값 `nd:locale`.
 */
export function createLocalStorageLocaleStorage(
  key: string = 'nd:locale',
): LocaleStorage {
  return {
    read(): Locale | null {
      try {
        const ls = (globalThis as { localStorage?: Storage }).localStorage;
        if (!ls) return null;
        const v = ls.getItem(key);
        return v === 'ko' || v === 'en' ? v : null;
      } catch {
        return null;
      }
    },
    write(locale: Locale): void {
      try {
        const ls = (globalThis as { localStorage?: Storage }).localStorage;
        if (!ls) return;
        ls.setItem(key, locale);
      } catch {
        // 사용자가 localStorage 를 비활성화한 환경 — 조용히 무시.
      }
    },
  };
}

interface ChromeStorageSyncLike {
  storage: {
    sync: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  };
}

/**
 * chrome.storage.sync 기반 영속화 — 확장(MV3). 디바이스간 동기화.
 */
export function createChromeSyncLocaleStorage(
  key: string = 'nd:locale',
): LocaleStorage {
  return {
    async read(): Promise<Locale | null> {
      try {
        const c = (globalThis as { chrome?: ChromeStorageSyncLike }).chrome;
        if (!c) return null;
        const out = await c.storage.sync.get(key);
        const v = out[key];
        return v === 'ko' || v === 'en' ? v : null;
      } catch {
        return null;
      }
    },
    async write(locale: Locale): Promise<void> {
      try {
        const c = (globalThis as { chrome?: ChromeStorageSyncLike }).chrome;
        if (!c) return;
        await c.storage.sync.set({ [key]: locale });
      } catch {
        // 확장 권한 부재 등 — 조용히 무시.
      }
    },
  };
}

/** 메모리 한정 영속화 — mobile v0.4 기본값 (AsyncStorage 도입은 TODO). */
export function createMemoryLocaleStorage(): LocaleStorage {
  let value: Locale | null = null;
  return {
    read(): Locale | null {
      return value;
    },
    write(locale: Locale): void {
      value = locale;
    },
  };
}

// ───────── Context + Provider ─────────

interface I18nContextValue {
  /** 현재 로케일. */
  locale: Locale;
  /** 로케일 변경. */
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  /** 자식 컴포넌트들. */
  children: ReactNode;
  /** 초기 로케일. 기본 'ko'. storage 에 저장된 값이 우선한다. */
  initialLocale?: Locale;
  /** 카탈로그. 기본값은 패키지에 번들된 ko/en. 호스트 앱이 확장할 수 있다. */
  catalogs?: Catalogs;
  /** 로케일 영속화 어댑터. 미지정 시 영속화 없음. */
  persistence?: LocaleStorage;
  /** 폴백 로케일 (키 누락 시). 기본 'ko'. */
  fallback?: Locale;
}

/**
 * <I18nProvider> — 카탈로그 등록 + 영속화 + Context 노출.
 *
 * 한 트리에 한 번만 마운트하는 것을 권장. 재마운트되면 카탈로그가 다시 설정된다.
 */
export function I18nProvider({
  children,
  initialLocale = 'ko',
  catalogs = defaultCatalogs,
  persistence,
  fallback = 'ko',
}: I18nProviderProps): JSX.Element {
  // 1) 부팅 시 카탈로그 + 초기 로케일 등록.
  //    persistence 에 저장된 값이 있으면 그쪽이 우선. async 일 수 있으므로 useEffect 로.
  useEffect(() => {
    configureI18n({ catalogs, initialLocale, fallback });
    if (!persistence) return;
    const r = persistence.read();
    const apply = (loc: Locale | null): void => {
      if (loc && loc !== getLocale()) _setLocale(loc);
    };
    if (r && typeof (r as Promise<Locale | null>).then === 'function') {
      void (r as Promise<Locale | null>).then(apply);
    } else {
      apply(r as Locale | null);
    }
    // catalogs/initialLocale 변경 시 재실행되지 않게 의도적으로 deps 한정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) 외부 store 의 현재 로케일을 useSyncExternalStore 로 구독해 re-render.
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);

  const setLocale = useCallback(
    (loc: Locale) => {
      _setLocale(loc);
      if (persistence) {
        void Promise.resolve(persistence.write(loc));
      }
    },
    [persistence],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function subscribe(fn: () => void): () => void {
  return onLocaleChange(() => fn());
}

/**
 * 현재 로케일과 setLocale 을 함께 돌려준다. Provider 외부에서 쓰면 throw.
 */
export function useLocale(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useLocale: must be used inside <I18nProvider>');
  }
  return ctx;
}

/**
 * 가장 자주 쓰이는 hook — `t` 함수만 돌려준다.
 *
 * 로케일이 바뀌면 새 `t` 가 반환되므로 자식 컴포넌트들이 자동으로 다시 렌더된다.
 * Provider 바깥에서도 동작은 한다(전역 store 를 그대로 쓰는 fallback) — 다만
 * 로케일 변경 시 자동 re-render 가 일어나지 않는다.
 */
export function useT(): (key: string, vars?: Vars) => string {
  // Provider 가 있으면 그쪽 locale 에 따라 t 가 새로 생성된다.
  const ctx = useContext(I18nContext);
  // ctx?.locale 변경 시 새 클로저가 만들어진다.
  return useMemo(
    () => (key: string, vars?: Vars) => _t(key, vars),
    [ctx?.locale],
  );
}

// ───────── 로케일 스위치 UI ─────────

export interface LocaleSwitchProps {
  /** 컨테이너에 추가할 클래스명. */
  className?: string;
  /** 인라인 스타일. */
  style?: React.CSSProperties;
  /** 라벨 표시 여부. 기본 true. */
  showLabel?: boolean;
}

/**
 * <LocaleSwitch /> — 간단한 ko/en 토글 (select 기반).
 *
 * CSS 는 호스트 앱이 알아서. 디자인 시스템과의 결합도를 낮추기 위해 native
 * `<select>` 를 사용한다. 필요시 design-system 의 컴포넌트로 감싸도 무방.
 */
export function LocaleSwitch({
  className,
  style,
  showLabel = true,
}: LocaleSwitchProps): JSX.Element {
  const { locale, setLocale } = useLocale();
  const t = useT();
  return (
    <label
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        ...style,
      }}
    >
      {showLabel && <span aria-hidden="true">🌐</span>}
      <span className="visually-hidden" style={visuallyHidden}>
        {t('common.language')}
      </span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        style={{
          background: 'transparent',
          color: 'inherit',
          border: '1px solid currentColor',
          borderRadius: 6,
          padding: '2px 6px',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        <option value="ko">{t('common.korean')}</option>
        <option value="en">{t('common.english')}</option>
      </select>
    </label>
  );
}

const visuallyHidden: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};
