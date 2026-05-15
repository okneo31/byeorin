import { useEffect, useState } from 'react';

export function Settings() {
  const [locale, setLocale] = useState<'ko' | 'en'>('ko');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [appVersion, setAppVersion] = useState<string>('0.1.0');

  useEffect(() => {
    // Attempt to read Tauri-provided version if available; tolerate non-Tauri (browser) dev.
    type WithTauri = { __TAURI__?: unknown };
    const w = window as unknown as WithTauri;
    if (w.__TAURI__) {
      void import('@tauri-apps/api/app')
        .then((m) => m.getVersion())
        .then((v) => setAppVersion(v))
        .catch(() => {
          /* dev fallback */
        });
    }
  }, []);

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">설정</h1>
        <p className="nd-lead">언어, 테마, 하드웨어 월릿 연결 등을 관리합니다.</p>
      </header>

      <section className="nd-card">
        <div className="nd-label">언어</div>
        <div className="nd-row">
          <button
            type="button"
            className={'nd-btn ' + (locale === 'ko' ? 'nd-btn--primary' : 'nd-btn--ghost')}
            onClick={() => setLocale('ko')}
          >
            한국어
          </button>
          <button
            type="button"
            className={'nd-btn ' + (locale === 'en' ? 'nd-btn--primary' : 'nd-btn--ghost')}
            onClick={() => setLocale('en')}
          >
            English
          </button>
        </div>
        <p className="nd-muted" style={{ marginTop: 8 }}>
          UI 언어 전환은 다음 릴리스에서 적용됩니다.
        </p>
      </section>

      <section className="nd-card">
        <div className="nd-label">테마</div>
        <div className="nd-row">
          <button
            type="button"
            className={'nd-btn ' + (theme === 'light' ? 'nd-btn--primary' : 'nd-btn--ghost')}
            onClick={() => setTheme('light')}
          >
            라이트
          </button>
          <button
            type="button"
            className={'nd-btn ' + (theme === 'dark' ? 'nd-btn--primary' : 'nd-btn--ghost')}
            onClick={() => setTheme('dark')}
          >
            다크
          </button>
        </div>
        <p className="nd-muted" style={{ marginTop: 8 }}>
          다크 테마는 v0.2에서 활성화됩니다.
        </p>
      </section>

      <section className="nd-card">
        <div className="nd-label">하드웨어 월릿</div>
        <button
          type="button"
          className="nd-btn nd-btn--ghost"
          disabled
          title="HW 예정"
          aria-label="하드웨어 월릿 연결 (예정)"
        >
          하드웨어 월릿 연결 (HW 예정)
        </button>
        <p className="nd-muted" style={{ marginTop: 8 }}>
          Ledger / Trezor USB 연결을 곧 지원합니다.
        </p>
      </section>

      <section className="nd-card">
        <div className="nd-label">정보</div>
        <p className="nd-muted">
          노동자의 지갑 데스크톱 · v{appVersion}
          <br />
          TTL Chain ID 7777 · https://rpc.ttl1.top
        </p>
      </section>
    </div>
  );
}
