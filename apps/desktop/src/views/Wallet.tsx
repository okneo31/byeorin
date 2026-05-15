import { useEffect, useState } from 'react';
import { createMnemonic, type WalletAccount } from '@nodong/wallet-sdk';
import { clear, getAccount, getAdapter, setMnemonic } from '../wallet-store.js';

interface Props {
  unlocked: boolean;
  onReady: () => void;
  onLock: () => void;
}

type Mode = 'idle' | 'create' | 'recover';

export function Wallet({ unlocked, onReady, onLock }: Props) {
  const [account, setAccount] = useState<WalletAccount | null>(() => getAccount());
  const [mode, setMode] = useState<Mode>('idle');
  const [draft, setDraft] = useState<string>('');
  const [input, setInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loadingBalance, setLoadingBalance] = useState<boolean>(false);

  useEffect(() => {
    if (unlocked && !account) {
      setAccount(getAccount());
    }
  }, [unlocked, account]);

  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setBalance(null);
      return;
    }
    setLoadingBalance(true);
    getAdapter()
      .getBalance(account.address)
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        if (!cancelled) setBalance(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingBalance(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  const startCreate = () => {
    setError(null);
    setDraft(createMnemonic(128, 'english'));
    setMode('create');
  };

  const startRecover = () => {
    setError(null);
    setInput('');
    setMode('recover');
  };

  const confirmCreate = () => {
    try {
      const acc = setMnemonic(draft);
      setAccount(acc);
      setMode('idle');
      setDraft('');
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmRecover = () => {
    try {
      const acc = setMnemonic(input);
      setAccount(acc);
      setMode('idle');
      setInput('');
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const lock = () => {
    clear();
    setAccount(null);
    setMode('idle');
    setBalance(null);
    onLock();
  };

  if (account && unlocked) {
    return (
      <div className="nd-view">
        <header className="nd-view__header">
          <h1 className="nd-h1">지갑</h1>
          <p className="nd-lead">TTL 메인넷에 연결되어 있습니다.</p>
        </header>

        <section className="nd-card">
          <div className="nd-label">잔액</div>
          <div className="nd-balance">
            {loadingBalance
              ? '…'
              : balance != null
                ? formatTtl(balance)
                : '—'}
            <span className="nd-balance__unit">TTL</span>
          </div>
          <div className="nd-muted" style={{ marginTop: 12 }}>
            네트워크: TTL · Chain ID 7777
          </div>
        </section>

        <section className="nd-card">
          <div className="nd-label">주소</div>
          <div className="nd-addr">{account.address}</div>
          <div className="nd-row" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="nd-btn nd-btn--ghost"
              onClick={() => {
                if (navigator.clipboard) {
                  void navigator.clipboard.writeText(account.address);
                }
              }}
            >
              주소 복사
            </button>
            <button type="button" className="nd-btn nd-btn--secondary" onClick={lock}>
              잠금
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">노동자의 지갑에 오신 것을 환영합니다</h1>
        <p className="nd-lead">
          비수탁 데스크톱 지갑입니다. 새 지갑을 만들거나, 기존 복구 문구로 복원할 수 있습니다.
        </p>
      </header>

      {mode === 'idle' && (
        <section className="nd-card">
          <div className="nd-label">시작하기</div>
          <button type="button" className="nd-btn nd-btn--primary" onClick={startCreate}>
            새 지갑 만들기
          </button>
          <button type="button" className="nd-btn nd-btn--ghost" onClick={startRecover}>
            복구 문구로 복원
          </button>
        </section>
      )}

      {mode === 'create' && (
        <section className="nd-card">
          <div className="nd-label">복구 문구 (12 단어)</div>
          <div className="nd-warn">
            이 12단어를 안전한 곳에 옮겨 적어 두세요. 복구 문구는 지갑 자체이며, 잃어버리면 자산을
            되찾을 수 없습니다.
          </div>
          <div className="nd-mnemonic">{draft}</div>
          {error && <div className="nd-error">{error}</div>}
          <div className="nd-row" style={{ marginTop: 16 }}>
            <button type="button" className="nd-btn nd-btn--ghost" onClick={() => setMode('idle')}>
              취소
            </button>
            <button type="button" className="nd-btn nd-btn--primary" onClick={confirmCreate}>
              저장하고 시작
            </button>
          </div>
        </section>
      )}

      {mode === 'recover' && (
        <section className="nd-card">
          <div className="nd-label">복구 문구 입력</div>
          <textarea
            className="nd-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="12 또는 24개의 단어를 공백으로 구분하여 입력하세요"
            autoFocus
          />
          {error && <div className="nd-error">{error}</div>}
          <div className="nd-row" style={{ marginTop: 16 }}>
            <button type="button" className="nd-btn nd-btn--ghost" onClick={() => setMode('idle')}>
              취소
            </button>
            <button
              type="button"
              className="nd-btn nd-btn--primary"
              onClick={confirmRecover}
              disabled={input.trim().length === 0}
            >
              복원
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function formatTtl(wei: bigint): string {
  const denom = 10n ** 18n;
  const whole = wei / denom;
  const frac = wei % denom;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  // limit to 6 decimal places for display
  return `${whole.toString()}.${fracStr.slice(0, 6)}`;
}
