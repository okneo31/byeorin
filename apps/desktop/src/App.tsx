import { useEffect, useState } from 'react';
import { Button, Logo } from '@nodong/design-system';
import { Wallet } from './views/Wallet.js';
import { Send } from './views/Send.js';
import { Portfolio } from './views/Portfolio.js';
import { Settings } from './views/Settings.js';
import { clear, hasSession } from './wallet-store.js';

export type View = 'wallet' | 'send' | 'portfolio' | 'settings';

interface NavItem {
  key: View;
  label: string;
  icon: string;
}

const NAV: readonly NavItem[] = [
  { key: 'wallet', label: '지갑', icon: '●' },
  { key: 'send', label: '송수신', icon: '↗' },
  { key: 'portfolio', label: '포트폴리오', icon: '◆' },
  { key: 'settings', label: '설정', icon: '⚙' },
];

export function App() {
  const [view, setView] = useState<View>('wallet');
  const [unlocked, setUnlocked] = useState<boolean>(() => hasSession());

  useEffect(() => {
    document.title = '노동자의 지갑';
  }, []);

  const onLock = () => {
    clear();
    setUnlocked(false);
    setView('wallet');
  };

  const onUnlock = () => {
    setUnlocked(true);
  };

  return (
    <div className="nd-shell">
      <aside className="nd-sidebar">
        <div className="nd-sidebar__brand">
          <Logo size={36} variant="mark" />
          <div>
            <div className="nd-sidebar__title">노동자의 지갑</div>
            <div className="nd-sidebar__subtitle">TTL Ecosystem · v0.1</div>
          </div>
        </div>
        <nav className="nd-nav">
          {NAV.map((item) => {
            const disabled = !unlocked && item.key !== 'wallet' && item.key !== 'settings';
            return (
              <button
                key={item.key}
                type="button"
                className={
                  'nd-nav__item' + (view === item.key ? ' nd-nav__item--active' : '')
                }
                onClick={() => setView(item.key)}
                disabled={disabled}
                title={disabled ? '먼저 지갑을 열어주세요' : undefined}
              >
                <span className="nd-nav__icon" aria-hidden>
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="nd-sidebar__footer">
          {unlocked ? (
            <Button variant="secondary" className="nd-button--block" onClick={onLock}>
              잠금
            </Button>
          ) : (
            <p className="nd-muted nd-sidebar__note">
              비수탁(non-custodial)
              <br />
              복구 문구는 세션에만 저장됩니다.
            </p>
          )}
        </div>
      </aside>
      <main className="nd-main">
        {view === 'wallet' && <Wallet onReady={onUnlock} onLock={onLock} unlocked={unlocked} />}
        {view === 'send' && <Send unlocked={unlocked} onGoWallet={() => setView('wallet')} />}
        {view === 'portfolio' && <Portfolio unlocked={unlocked} />}
        {view === 'settings' && <Settings />}
      </main>
    </div>
  );
}
