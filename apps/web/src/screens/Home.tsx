import { useState } from 'react';
import { createMnemonic } from '@nodong/wallet-sdk';
import { ShellError } from '@nodong/shell-core';
import { Button, Card } from '@nodong/design-system';
import { useT } from '@nodong/i18n/react';
import { walletStore } from '../wallet-store.js';

type Mode = 'choose' | 'create' | 'recover';

interface Props {
  onReady: () => void;
}

export function Home({ onReady }: Props) {
  const [mode, setMode] = useState<Mode>('choose');
  const t = useT();

  if (mode === 'create') return <CreateFlow onDone={onReady} onBack={() => setMode('choose')} />;
  if (mode === 'recover')
    return <RecoverFlow onDone={onReady} onBack={() => setMode('choose')} />;

  return (
    <div>
      <h1 className="nd-h1">{t('brand.tagline')}</h1>
      <p className="nd-lead">{t('home.lead')}</p>

      <Card>
        <p className="nd-muted" style={{ marginTop: 0 }}>{t('home.new_user_question')}</p>
        <Button
          variant="primary"
          className="nd-button--block"
          onClick={() => setMode('create')}
        >
          {t('home.create_button')}
        </Button>
      </Card>

      <Card>
        <p className="nd-muted" style={{ marginTop: 0 }}>{t('home.recover_question')}</p>
        <Button
          variant="secondary"
          className="nd-button--block"
          onClick={() => setMode('recover')}
        >
          {t('home.recover_button')}
        </Button>
      </Card>
    </div>
  );
}

/**
 * shell-core 에서 throw 된 에러를 사용자 언어로 매핑한다.
 *
 * - ShellError(code) → `errors.<code>` 카탈로그 키.
 * - 그 외 일반 Error → fallback 메시지(`fallback` 인자).
 */
function localizeError(t: (k: string) => string, e: unknown, fallback: string): string {
  if (e instanceof ShellError) return t(`errors.${e.code}`);
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

function CreateFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const t = useT();
  // i18n: 한국어 wordlist 로 새 니모닉 생성 — 사용자가 선택한 언어와 무관.
  // 니모닉 자체는 BIP39 표준이므로 ko/en 어느 wordlist 로 만들든 안전.
  const [mnemonic] = useState(() => createMnemonic(128, 'korean'));
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(t('create.copy_failed'));
    }
  };

  const onConfirm = () => {
    void (async () => {
      try {
        await walletStore.unlock(mnemonic);
        onDone();
      } catch (e) {
        setError(localizeError(t, e, t('create.failed')));
      }
    })();
  };

  return (
    <div>
      <h1 className="nd-h1">{t('create.title')}</h1>
      <p className="nd-lead">{t('create.lead')}</p>

      <div className="nd-warn">{t('create.warn')}</div>

      <Card>
        <div className="nd-mnemonic">{mnemonic}</div>
        <div style={{ height: 12 }} />
        <Button variant="ghost" className="nd-button--block" onClick={onCopy}>
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </Card>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          margin: '12px 0 16px',
          fontSize: 15,
        }}
      >
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          style={{ width: 18, height: 18 }}
        />
        <span>{t('create.checkbox_safe')}</span>
      </label>

      {error && <div className="nd-error">{error}</div>}

      <Button
        variant="primary"
        className="nd-button--block"
        disabled={!confirmed}
        onClick={onConfirm}
      >
        {t('create.confirm_done')}
      </Button>
      <Button variant="ghost" className="nd-button--block" onClick={onBack}>
        {t('common.back')}
      </Button>
    </div>
  );
}

function RecoverFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const t = useT();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = () => {
    setError(null);
    void (async () => {
      try {
        await walletStore.unlock(input);
        onDone();
      } catch (e) {
        setError(localizeError(t, e, t('recover.failed')));
      }
    })();
  };

  return (
    <div>
      <h1 className="nd-h1">{t('recover.title')}</h1>
      <p className="nd-lead">{t('recover.lead')}</p>

      <Card>
        {/* TODO(design-system): Input 컴포넌트가 textarea 모드를 아직 지원하지
            않는다. 일단 native <textarea>로 두고, 디자인 시스템 확장 여부는
            별도 결정한다. */}
        <label className="nd-field__label" htmlFor="nd-mnemonic-input">
          {t('recover.label')}
        </label>
        <div style={{ height: 8 }} />
        <textarea
          id="nd-mnemonic-input"
          className="nd-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('recover.placeholder')}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </Card>

      {error && <div className="nd-error">{error}</div>}

      <Button
        variant="primary"
        className="nd-button--block"
        disabled={input.trim().split(/\s+/).filter(Boolean).length < 12}
        onClick={onSubmit}
      >
        {t('recover.submit')}
      </Button>
      <Button variant="ghost" className="nd-button--block" onClick={onBack}>
        {t('common.back')}
      </Button>
    </div>
  );
}
