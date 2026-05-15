import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { WalletAccount } from '@nodong/wallet-sdk';
import { AddressDisplay, AmountDisplay, Button, Card } from '@nodong/design-system';
import { walletStore } from '../wallet-store.js';

interface Props {
  onSend: () => void;
  onLock: () => void;
}

export function Account({ onSend, onLock }: Props) {
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!walletStore.isUnlocked()) {
      onLock();
      return;
    }
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const acc = await walletStore.getAccount();
        if (cancelled) return;
        setAccount(acc);
        const bal = await walletStore.getDefaultAdapter().getBalance(acc.address);
        if (!cancelled) setBalance(bal);

        const url = await QRCode.toDataURL(acc.address, {
          margin: 1,
          width: 240,
          color: { dark: '#0a0a0a', light: '#ffffff' },
        });
        if (!cancelled) setQrDataUrl(url);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? `잔액을 불러오지 못했습니다: ${e.message}` : '잔액 조회 실패',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onLock]);

  if (!account) return null;

  return (
    <div>
      <h1 className="nd-h1">내 지갑</h1>
      <p className="nd-lead">TTL 메인넷 · 체인 ID 7777</p>

      <Card>
        <p className="nd-muted" style={{ marginTop: 0, marginBottom: 8 }}>잔액</p>
        {loading ? (
          <span className="nd-muted">불러오는 중...</span>
        ) : (
          <AmountDisplay
            value={balance ?? 0n}
            decimals={18}
            symbol="TTL"
            maxDecimals={4}
            size="lg"
          />
        )}
        {error && <div className="nd-error">{error}</div>}
      </Card>

      <Card>
        <p className="nd-muted" style={{ marginTop: 0, marginBottom: 8 }}>받는 주소</p>
        <AddressDisplay
          address={account.address}
          head={10}
          tail={8}
          copyLabel="주소 복사"
          copiedLabel="복사됨"
        />
        {qrDataUrl && (
          <>
            <div style={{ height: 14 }} />
            <div className="nd-qr">
              <img src={qrDataUrl} alt="receiving address QR" />
            </div>
            <p className="nd-muted" style={{ textAlign: 'center', marginTop: 10 }}>
              QR을 스캔해 이 주소로 받을 수 있습니다.
            </p>
          </>
        )}
      </Card>

      <Button variant="primary" className="nd-button--block" onClick={onSend}>
        송금
      </Button>
      <Button variant="ghost" className="nd-button--block" onClick={onLock}>
        잠금
      </Button>
    </div>
  );
}
