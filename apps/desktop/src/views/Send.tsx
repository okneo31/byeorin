import { useEffect, useState } from 'react';
import type { WalletAccount } from '@nodong/wallet-sdk';
import { AddressDisplay, Button, Card, Input } from '@nodong/design-system';
import { walletStore } from '../wallet-store.js';

interface Props {
  unlocked: boolean;
  onGoWallet: () => void;
}

export function Send({ unlocked, onGoWallet }: Props) {
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [toError, setToError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!unlocked || !walletStore.isUnlocked()) {
      setAccount(null);
      return;
    }
    void walletStore.getAccount().then((a) => {
      if (!cancelled) setAccount(a);
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked]);

  if (!unlocked || !account) {
    return (
      <div className="nd-view">
        <header className="nd-view__header">
          <h1 className="nd-h1">송수신</h1>
          <p className="nd-lead">먼저 지갑을 열거나 복원해 주세요.</p>
        </header>
        <Card as="section">
          <Button variant="primary" className="nd-button--block" onClick={onGoWallet}>
            지갑으로 이동
          </Button>
        </Card>
      </div>
    );
  }

  const submit = async () => {
    setError(null);
    setTxHash(null);
    setToError(null);
    setAmountError(null);

    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      setToError('받는 주소가 올바르지 않습니다.');
      return;
    }
    let value: bigint;
    try {
      value = parseTtlToWei(amount.trim());
    } catch (e) {
      setAmountError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (value <= 0n) {
      setAmountError('금액은 0보다 커야 합니다.');
      return;
    }
    setSending(true);
    try {
      const finalHash = await walletStore.transfer({ to: to.trim(), amount: value });
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

      <Card as="section">
        <div className="nd-label">보내는 주소</div>
        <AddressDisplay address={account.address} head={8} tail={6} />
      </Card>

      <Card as="section" style={{ marginTop: 16 }}>
        <Input
          id="to"
          label="받는 주소"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="0x..."
          autoComplete="off"
          spellCheck={false}
          mono
          error={toError ?? undefined}
        />

        <div style={{ height: 16 }} />

        <Input
          id="amount"
          label="금액 (TTL)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          autoComplete="off"
          error={amountError ?? undefined}
        />

        {error && <div className="nd-error">{error}</div>}
        {txHash && (
          <div className="nd-success">
            전송 완료 · 트랜잭션 해시:
            <br />
            <code style={{ wordBreak: 'break-all' }}>{txHash}</code>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <Button
            variant="primary"
            className="nd-button--block"
            onClick={submit}
            loading={sending}
            disabled={sending}
          >
            {sending ? '전송 중…' : '서명하고 전송'}
          </Button>
        </div>
      </Card>
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
