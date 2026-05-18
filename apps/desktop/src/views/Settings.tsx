import { useEffect, useState } from 'react';
import { Button, Card } from '@byeorin/design-system';
import { useLocale, useT } from '@byeorin/i18n/react';

export function Settings() {
  const t = useT();
  const { locale, setLocale } = useLocale();
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
        <h1 className="nd-h1">{t('settings.title')}</h1>
        <p className="nd-lead">{t('settings.lead')}</p>
      </header>

      <Card as="section">
        <div className="nd-label">{t('settings.language.title')}</div>
        <div className="nd-row">
          <Button
            variant={locale === 'ko' ? 'primary' : 'ghost'}
            onClick={() => setLocale('ko')}
          >
            {t('common.korean')}
          </Button>
          <Button
            variant={locale === 'en' ? 'primary' : 'ghost'}
            onClick={() => setLocale('en')}
          >
            {t('common.english')}
          </Button>
        </div>
        <p className="nd-muted" style={{ marginTop: 8 }}>
          {t('settings.language.help')}
        </p>
      </Card>

      <div style={{ height: 16 }} />

      <Card as="section">
        <div className="nd-label">{t('settings.theme.title')}</div>
        <div className="nd-row">
          <Button
            variant={theme === 'light' ? 'primary' : 'ghost'}
            onClick={() => setTheme('light')}
          >
            {t('settings.theme.light')}
          </Button>
          <Button
            variant={theme === 'dark' ? 'primary' : 'ghost'}
            onClick={() => setTheme('dark')}
          >
            {t('settings.theme.dark')}
          </Button>
        </div>
        <p className="nd-muted" style={{ marginTop: 8 }}>
          {t('settings.theme.v02_note')}
        </p>
      </Card>

      <div style={{ height: 16 }} />

      <Card as="section">
        <div className="nd-label">{t('settings.hw.title')}</div>
        <Button
          variant="ghost"
          disabled
          title={t('settings.hw.coming_soon_title')}
          aria-label={t('settings.hw.aria_label')}
        >
          {t('settings.hw.coming_soon')}
        </Button>
        <p className="nd-muted" style={{ marginTop: 8 }}>
          {t('settings.hw.note')}
        </p>
      </Card>

      <div style={{ height: 16 }} />

      <Card as="section">
        <div className="nd-label">{t('settings.info.title')}</div>
        <p className="nd-muted">
          {t('settings.info.app_line', { version: appVersion })}
          <br />
          {t('settings.info.chain_line')}
        </p>
      </Card>
    </div>
  );
}
