import { useEffect, useState } from 'react';
import { Logo } from '@nodong/design-system';
import { LocaleSwitch, useT } from '@nodong/i18n/react';
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
  const t = useT();

  useEffect(() => {
    // 브랜드명은 ko/en 어디서나 한국어로 유지 — `app.title` 카탈로그 키가 그렇게 정의되어 있다.
    document.title = t('app.title');
    // 자동 복원이 허용되는 환경(extension 등)에서만 효과가 있는 호출.
    // web 에서는 사실상 no-op 이지만 인터페이스 일관성을 위해 둔다.
    void walletStore.tryAutoRestore().then((restored) => {
      if (restored) setScreen('account');
    });
  }, [t]);

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
        <div className="nd-header__actions">
          <LocaleSwitch />
          {screen !== 'home' && (
            <button type="button" className="nd-header__action" onClick={onLock}>
              {t('common.lock')}
            </button>
          )}
        </div>
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
          {t('footer.non_custodial.web').split('\n').map((line, i) => (
            <span key={i}>
              {line}
              <br />
            </span>
          ))}
        </p>
      </main>
    </div>
  );
}
