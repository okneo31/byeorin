import { useMemo, useState } from 'react';
import {
  createMnemonic,
  NEW_MNEMONIC_STRENGTH,
  NEW_MNEMONIC_WORD_COUNT,
} from '@byeorin/wallet-sdk';
import { ShellError } from '@byeorin/shell-core';
import { Button, Card } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';
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

  // 홈 히어로:
  //   1) 큰 로고 (mark-with-text, 56px)
  //   2) 운동성 태그라인
  //   3) 평이한 보조 설명
  //   4) 두 개의 CTA 버튼 (red 채움 + ghost outline)
  //   5) 비수탁 안내 한 줄
  // 모든 카피는 i18n 카탈로그 키로만 — 하드코딩된 한국어 텍스트 없음.
  return (
    <div>
      <div className="web-hero">
        <div className="web-hero__mark">
          {/* 앱 아이콘과 동일한 PNG 마스터를 쓴다 — design-system 의 Logo SVG 는
              옛 디자인이라 실제 아이콘과 시각이 어긋난다. android·확장 셸이
              먼저 이 방식으로 옮겼고 web·desktop 만 남아 있었다. */}
          <img src="/icon/128.png" width={56} height={56} alt="" />
          <span className="web-hero__wordmark">{t('brand.name')}</span>
        </div>
        <h1 className="web-hero__tagline">{t('home.web_tagline')}</h1>
        <p className="web-hero__subtagline">{t('home.web_subtagline')}</p>
        <div className="web-hero__cta-row">
          <Button
            variant="primary"
            size="lg"
            onClick={() => setMode('create')}
          >
            {t('home.web_cta_create')}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => setMode('recover')}
          >
            {t('home.web_cta_recover')}
          </Button>
        </div>
        <p className="web-hero__footer-note">{t('home.web_footer_note')}</p>
      </div>
    </div>
  );
}

/**
 * shell-core 에서 throw 된 에러를 사용자 언어로 매핑한다.
 *
 * - ShellError(code) → `errors.<code>` 카탈로그 키.
 * - 그 외 일반 Error → fallback 메시지(`fallback` 인자).
 */
function localizeError(t: (k: string, vars?: Record<string, string | number>) => string, e: unknown, fallback: string): string {
  if (e instanceof ShellError) return t(`errors.${e.code}`);
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

function CreateFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const t = useT();
  // i18n: 한국어 wordlist 로 새 니모닉 생성 — 사용자가 선택한 언어와 무관.
  // 니모닉 자체는 BIP39 표준이므로 ko/en 어느 wordlist 로 만들든 안전.
  const [mnemonic] = useState(() => createMnemonic(NEW_MNEMONIC_STRENGTH, 'korean'));
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 12 단어를 4×3 그리드로 분해. 인덱스는 1-base 로 보여 준다 (사용자 직관).
  const words = useMemo(() => mnemonic.split(/\s+/).filter(Boolean), [mnemonic]);

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
      <p className="nd-lead">{t('create.lead', { n: NEW_MNEMONIC_WORD_COUNT })}</p>

      <div className="nd-warn">{t('create.warn')}</div>

      <Card>
        <p className="nd-muted" style={{ margin: '0 0 0.5rem' }}>
          {t('create.mnemonic_grid_label', { n: NEW_MNEMONIC_WORD_COUNT })}
        </p>
        {/*
          4×3 그리드 — 각 셀에 인덱스 번호 + 단어. 디자인 시스템 토큰을 쓰되
          웹 셸 전용 스타일(.web-mnemonic-*)로 폴리시. 인장 종이 느낌의 1px 보더.
        */}
        <ul className="web-mnemonic-grid" aria-label={t('create.mnemonic_grid_label', { n: NEW_MNEMONIC_WORD_COUNT })}>
          {words.map((w, i) => (
            <li
              key={`${i}-${w}`}
              className="web-mnemonic-cell"
              aria-label={t('create.word_index_label', { n: i + 1 })}
            >
              <span className="web-mnemonic-cell__index" aria-hidden="true">
                {i + 1}
              </span>
              <span className="web-mnemonic-cell__word">{w}</span>
            </li>
          ))}
        </ul>
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
        <span>{t('create.checkbox_safe', { n: NEW_MNEMONIC_WORD_COUNT })}</span>
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

  // 단어 카운터 — 0..12 까지만 의미있게 보여 준다. 12+ 는 24 단어 케이스도 있어 그대로.
  const wordCount = input.trim().split(/\s+/).filter(Boolean).length;

  const onPaste = async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) setInput(txt.trim());
    } catch {
      // 권한 거부 시 조용히 무시 — 사용자에게는 직접 붙여넣기 옵션이 남아 있다.
    }
  };

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
        <label className="nd-field__label" htmlFor="nd-mnemonic-input">
          {t('recover.label')}
        </label>
        <div style={{ height: 8 }} />
        <div className="web-recover-input">
          <textarea
            id="nd-mnemonic-input"
            className="web-recover-input__textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('recover.placeholder')}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            rows={4}
          />
          <div className="web-recover-input__meta">
            <span>{t('recover.word_count', { n: wordCount })}</span>
            <button
              type="button"
              className="web-recover-input__paste"
              onClick={onPaste}
            >
              {t('recover.paste_button')}
            </button>
          </div>
        </div>
      </Card>

      {error && <div className="nd-error">{error}</div>}

      <Button
        variant="primary"
        className="nd-button--block"
        disabled={wordCount < 12}
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
