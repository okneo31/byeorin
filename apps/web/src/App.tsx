import { useEffect, useState } from 'react';
import { Home } from './screens/Home.js';
import { Account } from './screens/Account.js';
import { Send } from './screens/Send.js';
import { clear, hasSession } from './wallet-store.js';

export type Screen = 'home' | 'account' | 'send';

export function App() {
  const [screen, setScreen] = useState<Screen>(() => (hasSession() ? 'account' : 'home'));

  useEffect(() => {
    // keep title fresh
    document.title = '노동자의 지갑';
  }, []);

  const onLock = () => {
    clear();
    setScreen('home');
  };

  return (
    <div className="nd-app">
      <header className="nd-header">
        <div className="nd-header__brand">노동자의 지갑</div>
        {screen !== 'home' && (
          <button type="button" className="nd-header__action" onClick={onLock}>
            잠금
          </button>
        )}
      </header>
      <main className="nd-main">
        {screen === 'home' && <Home onReady={() => setScreen('account')} />}
        {screen === 'account' && (
          <Account onSend={() => setScreen('send')} onLock={onLock} />
        )}
        {screen === 'send' && <Send onBack={() => setScreen('account')} />}
        <p className="nd-footer-note">
          비수탁(non-custodial) 지갑 · 복구 문구는 브라우저 세션에만 저장됩니다.
          <br />
          탭을 닫으면 잠금이 해제 상태로 돌아갑니다.
        </p>
      </main>
    </div>
  );
}
