import { useEffect, useState } from 'react';
import { Logo } from '@nodong/design-system';
import { Home } from './screens/Home.js';
import { Account } from './screens/Account.js';
import { Send } from './screens/Send.js';
import { Activity } from './screens/Activity.js';
import { walletStore } from './wallet-store.js';

export type Screen = 'home' | 'account' | 'send' | 'activity';

export function App() {
  // H1: web 환경은 자동 복원을 허용하지 않는다(WebSessionStore.autoRestoreAllowed=false).
  // 부팅 시점에는 항상 잠금 상태에서 시작한다.
  const [screen, setScreen] = useState<Screen>('home');

  useEffect(() => {
    document.title = '노동자의 지갑';
    // 자동 복원이 허용되는 환경(extension 등)에서만 효과가 있는 호출.
    // web 에서는 사실상 no-op 이지만 인터페이스 일관성을 위해 둔다.
    void walletStore.tryAutoRestore().then((restored) => {
      if (restored) setScreen('account');
    });
  }, []);

  const onLock = () => {
    void walletStore.lock();
    setScreen('home');
  };

  return (
    <div className="nd-app">
      <header className="nd-header">
        <div className="nd-header__brand">
          <Logo size={32} variant="mark-with-text" />
        </div>
        {screen !== 'home' && (
          <button type="button" className="nd-header__action" onClick={onLock}>
            잠금
          </button>
        )}
      </header>
      <main className="nd-main">
        {screen === 'home' && <Home onReady={() => setScreen('account')} />}
        {screen === 'account' && (
          <Account
            onSend={() => setScreen('send')}
            onLock={onLock}
            onActivity={() => setScreen('activity')}
          />
        )}
        {screen === 'send' && <Send onBack={() => setScreen('account')} />}
        {screen === 'activity' && <Activity onBack={() => setScreen('account')} />}
        <p className="nd-footer-note">
          비수탁(non-custodial) 지갑 · 복구 문구는 브라우저 세션에만 저장됩니다.
          <br />
          탭을 닫으면 잠금이 해제 상태로 돌아갑니다.
        </p>
      </main>
    </div>
  );
}
