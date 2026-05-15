import { useCallback, useEffect, useState } from 'react';
import { createMnemonic, type WalletAccount } from '@nodong/wallet-sdk';
import {
  AddressDisplay,
  AmountDisplay,
  Button,
  Card,
} from '@nodong/design-system';
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

  // Triple-state balance: balance / balanceError / loadingBalance.
  // 빈 지갑(0n)과 네트워크 오류(null + balanceError)를 구분한다.
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState<boolean>(false);
  const [reloadKey, setReloadKey] = useState<number>(0);

  useEffect(() => {
    if (unlocked && !account) {
      setAccount(getAccount());
    }
  }, [unlocked, account]);

  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setBalance(null);
      setBalanceError(null);
      setLoadingBalance(false);
      return;
    }
    setLoadingBalance(true);
    setBalanceError(null);
    getAdapter()
      .getBalance(account.address)
      .then((b) => {
        if (cancelled) return;
        setBalance(b);
        setBalanceError(null);
        setLoadingBalance(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBalance(null);
        setBalanceError(err instanceof Error ? err.message : '잔액 조회 실패');
        setLoadingBalance(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account, reloadKey]);

  const retryBalance = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

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
    setBalanceError(null);
    onLock();
  };

  if (account && unlocked) {
    return (
      <div className="nd-view">
        <header className="nd-view__header">
          <h1 className="nd-h1">지갑</h1>
          <p className="nd-lead">TTL 메인넷에 연결되어 있습니다.</p>
        </header>

        <Card as="section">
          <div className="nd-label">잔액</div>
          {loadingBalance && <div className="nd-muted">잔액 조회 중…</div>}
          {!loadingBalance && balanceError && (
            <>
              <div className="nd-error">잔액을 불러오지 못했습니다 · {balanceError}</div>
              <div style={{ marginTop: 12 }}>
                <Button variant="secondary" onClick={retryBalance}>
                  다시 시도
                </Button>
              </div>
            </>
          )}
          {!loadingBalance && !balanceError && balance != null && (
            <AmountDisplay value={balance} decimals={18} symbol="TTL" size="lg" />
          )}
          <div className="nd-muted" style={{ marginTop: 12 }}>
            네트워크: TTL · Chain ID 7777
          </div>
        </Card>

        <Card as="section" style={{ marginTop: 16 }}>
          <div className="nd-label">주소</div>
          <AddressDisplay address={account.address} head={8} tail={6} />
          <div className="nd-row" style={{ marginTop: 16 }}>
            <Button variant="secondary" onClick={lock}>
              잠금
            </Button>
          </div>
        </Card>
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
        <Card as="section">
          <div className="nd-label">시작하기</div>
          <Button variant="primary" className="nd-button--block" onClick={startCreate}>
            새 지갑 만들기
          </Button>
          <div style={{ height: 10 }} />
          <Button variant="ghost" className="nd-button--block" onClick={startRecover}>
            복구 문구로 복원
          </Button>
        </Card>
      )}

      {mode === 'create' && (
        <Card as="section">
          <div className="nd-label">복구 문구 (12 단어)</div>
          <div className="nd-warn">
            이 12단어를 안전한 곳에 옮겨 적어 두세요. 복구 문구는 지갑 자체이며, 잃어버리면 자산을
            되찾을 수 없습니다.
          </div>
          <div className="nd-mnemonic">{draft}</div>
          {error && <div className="nd-error">{error}</div>}
          <div className="nd-row" style={{ marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setMode('idle')}>
              취소
            </Button>
            <Button variant="primary" onClick={confirmCreate}>
              저장하고 시작
            </Button>
          </div>
        </Card>
      )}

      {mode === 'recover' && (
        <Card as="section">
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
            <Button variant="ghost" onClick={() => setMode('idle')}>
              취소
            </Button>
            <Button
              variant="primary"
              onClick={confirmRecover}
              disabled={input.trim().length === 0}
            >
              복원
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
