import { useEffect, useMemo, useState } from 'react';
import { Button, Logo } from '@byeorin/design-system';
import { LocaleSwitch, useT } from '@byeorin/i18n/react';
import { Wallet } from './views/Wallet.js';
import { Send } from './views/Send.js';
import { Portfolio } from './views/Portfolio.js';
import { Activity } from './views/Activity.js';
import { Settings } from './views/Settings.js';
import { Hardware } from './views/Hardware.js';
import { DApp } from './views/DApp.js';
import { walletStore } from './wallet-store.js';

export type View =
  | 'wallet'
  | 'send'
  | 'activity'
  | 'portfolio'
  | 'hardware'
  | 'dapp'
  | 'settings';

interface NavItem {
  key: View;
  labelKey: string;
  icon: string;
}

const NAV: readonly NavItem[] = [
  { key: 'wallet', labelKey: 'nav.wallet', icon: '●' },
  { key: 'send', labelKey: 'nav.send', icon: '↗' },
  { key: 'activity', labelKey: 'nav.activity', icon: '≡' },
  { key: 'portfolio', labelKey: 'nav.portfolio', icon: '◆' },
  { key: 'hardware', labelKey: 'nav.hardware', icon: '◈' },
  { key: 'dapp', labelKey: 'nav.dapp', icon: '⇄' },
  { key: 'settings', labelKey: 'nav.settings', icon: '⚙' },
];

export function App() {
  const t = useT();
  const [view, setView] = useState<View>('wallet');
  // H1: desktop(Tauri webview) 환경은 자동 복원을 허용하지 않는다.
  const [unlocked, setUnlocked] = useState<boolean>(false);

  useEffect(() => {
    document.title = t('app.title');
    void walletStore.tryAutoRestore().then((restored) => {
      if (restored) setUnlocked(true);
    });
  }, [t]);

  const onLock = () => {
    void walletStore.lock();
    setUnlocked(false);
    setView('wallet');
  };

  const onUnlock = () => {
    setUnlocked(true);
  };

  // 사이드바 비수탁 안내는 줄바꿈을 포함한다 — 카탈로그 값을 줄별로 렌더.
  const sidebarLines = useMemo(() => t('sidebar.non_custodial').split('\n'), [t]);

  return (
    <div className="nd-shell">
      <aside className="nd-sidebar">
        <div className="nd-sidebar__brand">
          <Logo size={36} variant="mark" />
          <div>
            <div className="nd-sidebar__title">{t('brand.name')}</div>
            <div className="nd-sidebar__subtitle">{t('sidebar.subtitle')}</div>
          </div>
        </div>
        <nav className="nd-nav">
          {NAV.map((item) => {
            // hardware 뷰는 소프트 월릿 잠금 해제 여부와 무관하게 항상 사용 가능.
            // (HW 단독으로도 디바이스 연결/주소 표시 흐름에 진입할 수 있어야 한다.)
            const disabled =
              !unlocked &&
              item.key !== 'wallet' &&
              item.key !== 'settings' &&
              item.key !== 'hardware';
            return (
              <button
                key={item.key}
                type="button"
                className={
                  'nd-nav__item' + (view === item.key ? ' nd-nav__item--active' : '')
                }
                onClick={() => setView(item.key)}
                disabled={disabled}
                title={disabled ? t('nav.unlock_first') : undefined}
              >
                <span className="nd-nav__icon" aria-hidden>
                  {item.icon}
                </span>
                <span>{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>
        <div className="nd-sidebar__footer">
          <div style={{ marginBottom: 10 }}>
            <LocaleSwitch />
          </div>
          {unlocked ? (
            <Button variant="secondary" className="nd-button--block" onClick={onLock}>
              {t('common.lock')}
            </Button>
          ) : (
            <p className="nd-muted nd-sidebar__note">
              {sidebarLines.map((line, i) => (
                <span key={i}>
                  {line}
                  {i < sidebarLines.length - 1 ? <br /> : null}
                </span>
              ))}
            </p>
          )}
        </div>
      </aside>
      <main className="nd-main">
        {view === 'wallet' && <Wallet onReady={onUnlock} onLock={onLock} unlocked={unlocked} />}
        {view === 'send' && <Send unlocked={unlocked} onGoWallet={() => setView('wallet')} />}
        {view === 'activity' && (
          <Activity unlocked={unlocked} onGoWallet={() => setView('wallet')} />
        )}
        {view === 'portfolio' && <Portfolio unlocked={unlocked} />}
        {view === 'hardware' && <Hardware />}
        {view === 'dapp' && <DApp unlocked={unlocked} onGoWallet={() => setView('wallet')} />}
        {view === 'settings' && <Settings />}
      </main>
    </div>
  );
}
