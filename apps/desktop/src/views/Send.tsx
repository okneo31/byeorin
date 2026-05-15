import { useState } from 'react';
import { getAccount } from '../wallet-store.js';

interface Props {
  unlocked: boolean;
  onGoWallet: () => void;
}

export function Send({ unlocked, onGoWallet }: Props) {
  const account = getAccount();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (!unlocked || !account) {
    return (
      <div className="nd-view">
        <header className="nd-view__header">
          <h1 className="nd-h1">송수신</h1>
          <p className="nd-lead">먼저 지갑을 열거나 복원해 주세요.</p>
        </header>
        <section className="nd-card">
          <button type="button" className="nd-btn nd-btn--primary" onClick={onGoWallet}>
            지갑으로 이동
          </button>
        </section>
      </div>
    );
  }

  const submit = async () => {
    setError(null);
    setTxHash(null);
    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      setError('받는 주소가 올바르지 않습니다.');
      return;
    }
    let value: bigint;
    try {
      value = parseTtlToWei(amount.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (value <= 0n) {
      setError('금액은 0보다 커야 합니다.');
      return;
    }
    setSending(true);
    try {
      // Construct a transient Wallet (mnemonic still in session); easier path:
      // use the adapter via account.signer to manually run transfer.
      const acc = account;
      const unsigned = await acc.adapter.buildTransfer(
        { to: to.trim(), amount: value },
        { sender: acc.address, signer: acc.signer },
      );
      const hash = await acc.adapter.serializeForSigning(unsigned);
      const sig = await acc.signer.sign(hash);
      const signed = await acc.adapter.applySignature(unsigned, sig);
      const finalHash = await acc.adapter.broadcast(signed);
      setTxHash(finalHash);
      setAmount('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">송수신</h1>
        <p className="nd-lead">TTL을 송금합니다. 수수료는 자동 추정됩니다.</p>
      </header>

      <section className="nd-card">
        <div className="nd-label">보내는 주소</div>
        <div className="nd-addr">{account.address}</div>
      </section>

      <section className="nd-card">
        <label className="nd-label" htmlFor="to">
          받는 주소
        </label>
        <input
          id="to"
          className="nd-input"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="0x..."
          autoComplete="off"
          spellCheck={false}
        />

        <label className="nd-label" htmlFor="amount" style={{ marginTop: 16 }}>
          금액 (TTL)
        </label>
        <input
          id="amount"
          className="nd-input"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          autoComplete="off"
        />

        {error && <div className="nd-error">{error}</div>}
        {txHash && (
          <div className="nd-success">
            전송 완료 · 트랜잭션 해시:
            <br />
            <code style={{ wordBreak: 'break-all' }}>{txHash}</code>
          </div>
        )}

        <button
          type="button"
          className="nd-btn nd-btn--primary"
          onClick={submit}
          disabled={sending}
          style={{ marginTop: 16 }}
        >
          {sending ? '전송 중…' : '서명하고 전송'}
        </button>
      </section>
    </div>
  );
}

function parseTtlToWei(s: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error('금액 형식이 올바르지 않습니다.');
  }
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole ?? '0') * 10n ** 18n + BigInt(fracPadded || '0');
}
