import { useState } from 'react';
import { getAccount, getWallet } from '../wallet-store.js';

interface Props {
  onBack: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'sent'; hash: string }
  | { kind: 'error'; message: string };

export function Send({ onBack }: Props) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const account = getAccount();
  const wallet = getWallet();

  if (!account || !wallet) {
    return (
      <div>
        <h1 className="nd-h1">송금</h1>
        <div className="nd-error">지갑이 잠겨있습니다. 다시 시작해주세요.</div>
        <button type="button" className="nd-btn nd-btn--ghost" onClick={onBack}>
          뒤로
        </button>
      </div>
    );
  }

  const validAddress = /^0x[0-9a-fA-F]{40}$/.test(to.trim());
  const parsedAmount = parseFloat(amount);
  const validAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const disabled =
    !validAddress || !validAmount || status.kind === 'pending' || status.kind === 'sent';

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setStatus({ kind: 'pending' });
    try {
      // wei = amount * 1e18 (simple — caller already validated > 0)
      const value = BigInt(Math.floor(parsedAmount * 1e18));
      const hash = await wallet.transfer(account, {
        to: to.trim(),
        amount: value,
      });
      setStatus({ kind: 'sent', hash });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : '송금에 실패했습니다.',
      });
    }
  };

  return (
    <div>
      <h1 className="nd-h1">송금</h1>
      <p className="nd-lead">TTL을 다른 주소로 보냅니다. 수수료는 네트워크가 자동 산정합니다.</p>

      <form onSubmit={onSubmit}>
        <div className="nd-card">
          <label className="nd-label" htmlFor="nd-to">
            받는 주소
          </label>
          <input
            id="nd-to"
            className="nd-input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x..."
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={status.kind === 'pending' || status.kind === 'sent'}
          />
          {to && !validAddress && (
            <div className="nd-error">주소 형식이 올바르지 않습니다 (0x + 40자리 16진수).</div>
          )}
        </div>

        <div className="nd-card">
          <label className="nd-label" htmlFor="nd-amt">
            금액 (TTL)
          </label>
          <input
            id="nd-amt"
            className="nd-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.0001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            disabled={status.kind === 'pending' || status.kind === 'sent'}
          />
        </div>

        {status.kind === 'pending' && (
          <div className="nd-warn">송금을 처리하고 있습니다. 잠시만 기다려주세요...</div>
        )}

        {status.kind === 'sent' && (
          <div className="nd-success">
            송금 요청 완료
            <div style={{ marginTop: 6 }}>
              <a
                href={`https://scan.ttl1.top/tx/${status.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                탐색기에서 보기 ↗
              </a>
            </div>
            <div className="nd-addr" style={{ marginTop: 6 }}>
              {status.hash}
            </div>
          </div>
        )}

        {status.kind === 'error' && <div className="nd-error">{status.message}</div>}

        {status.kind === 'sent' ? (
          <button type="button" className="nd-btn nd-btn--primary" onClick={onBack}>
            지갑으로
          </button>
        ) : (
          <button type="submit" className="nd-btn nd-btn--primary" disabled={disabled}>
            {status.kind === 'pending' ? '전송 중...' : '보내기'}
          </button>
        )}

        <button
          type="button"
          className="nd-btn nd-btn--ghost"
          onClick={onBack}
          disabled={status.kind === 'pending'}
        >
          뒤로
        </button>
      </form>
    </div>
  );
}
