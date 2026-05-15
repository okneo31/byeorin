import { useState } from 'react';
import { createMnemonic } from '@nodong/wallet-sdk';
import { Button, Card } from '@nodong/design-system';
import { setMnemonic } from '../wallet-store.js';

type Mode = 'choose' | 'create' | 'recover';

interface Props {
  onReady: () => void;
}

export function Home({ onReady }: Props) {
  const [mode, setMode] = useState<Mode>('choose');

  if (mode === 'create') return <CreateFlow onDone={onReady} onBack={() => setMode('choose')} />;
  if (mode === 'recover')
    return <RecoverFlow onDone={onReady} onBack={() => setMode('choose')} />;

  return (
    <div>
      <h1 className="nd-h1">노동자에게 자기 결정권을.</h1>
      <p className="nd-lead">
        수수료 투명, 다크 패턴 없음, 데이터는 당신의 기기에. TTL 체인을 포함한 EVM 호환 자산을
        쉽고 안전하게.
      </p>

      <Card>
        <p className="nd-muted" style={{ marginTop: 0 }}>처음 사용하세요?</p>
        <Button
          variant="primary"
          className="nd-button--block"
          onClick={() => setMode('create')}
        >
          지갑 생성
        </Button>
      </Card>

      <Card>
        <p className="nd-muted" style={{ marginTop: 0 }}>이미 복구 문구가 있나요?</p>
        <Button
          variant="secondary"
          className="nd-button--block"
          onClick={() => setMode('recover')}
        >
          복구
        </Button>
      </Card>
    </div>
  );
}

function CreateFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
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
      setError('클립보드 접근에 실패했습니다. 직접 적어주세요.');
    }
  };

  const onConfirm = () => {
    try {
      setMnemonic(mnemonic);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '지갑 생성에 실패했습니다.');
    }
  };

  return (
    <div>
      <h1 className="nd-h1">복구 문구를 기억하세요</h1>
      <p className="nd-lead">
        아래 12개 단어는 당신의 지갑 그 자체입니다. 종이에 적거나 안전한 곳에 보관하세요.
        절대 다른 사람과 공유하지 마세요.
      </p>

      <div className="nd-warn">
        이 문구를 잃어버리면 지갑을 복구할 수 없습니다. 화면 캡처는 권하지 않습니다.
      </div>

      <Card>
        <div className="nd-mnemonic">{mnemonic}</div>
        <div style={{ height: 12 }} />
        <Button variant="ghost" className="nd-button--block" onClick={onCopy}>
          {copied ? '복사됨' : '복사하기'}
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
        <span>위 12개 단어를 안전하게 보관했습니다.</span>
      </label>

      {error && <div className="nd-error">{error}</div>}

      <Button
        variant="primary"
        className="nd-button--block"
        disabled={!confirmed}
        onClick={onConfirm}
      >
        외웠습니다, 다음
      </Button>
      <Button variant="ghost" className="nd-button--block" onClick={onBack}>
        뒤로
      </Button>
    </div>
  );
}

function RecoverFlow({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = () => {
    setError(null);
    try {
      setMnemonic(input);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '복구에 실패했습니다.');
    }
  };

  return (
    <div>
      <h1 className="nd-h1">지갑 복구</h1>
      <p className="nd-lead">
        12개 또는 24개의 복구 단어를 띄어쓰기로 입력하세요. 영어 또는 한국어 단어 모두 지원합니다.
      </p>

      <Card>
        {/* TODO(design-system): Input 컴포넌트가 textarea 모드를 아직 지원하지
            않는다. 일단 native <textarea>로 두고, 디자인 시스템 확장 여부는
            별도 결정한다. */}
        <label className="nd-field__label" htmlFor="nd-mnemonic-input">
          복구 문구
        </label>
        <div style={{ height: 8 }} />
        <textarea
          id="nd-mnemonic-input"
          className="nd-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="예) word1 word2 word3 ..."
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
        복구하기
      </Button>
      <Button variant="ghost" className="nd-button--block" onClick={onBack}>
        뒤로
      </Button>
    </div>
  );
}
