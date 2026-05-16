import { useEffect, useState } from 'react';
import { Button, Logo } from '@nodong/design-system';
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
  label: string;
  icon: string;
}

const NAV: readonly NavItem[] = [
  { key: 'wallet', label: '지갑', icon: '●' },
  { key: 'send', label: '송수신', icon: '↗' },
  { key: 'activity', label: '활동', icon: '≡' },
  { key: 'portfolio', label: '포트폴리오', icon: '◆' },
  { key: 'hardware', label: '하드웨어 월릿', icon: '◈' },
  { key: 'dapp', label: 'dApp 연결', icon: '⇄' },
  { key: 'settings', label: '설정', icon: '⚙' },
];

export function App() {
  const [view, setView] = useState<View>('wallet');
  // H1: desktop(Tauri webview) 환경은 자동 복원을 허용하지 않는다.
  const [unlocked, setUnlocked] = useState<boolean>(false);

  useEffect(() => {
    document.title = '노동자의 지갑';
    void walletStore.tryAutoRestore().then((restored) => {
      if (restored) setUnlocked(true);
    });
  }, []);

  const onLock = () => {
    void walletStore.lock();
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
