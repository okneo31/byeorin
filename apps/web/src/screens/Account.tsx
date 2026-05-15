import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { getAccount, getAdapter } from '../wallet-store.js';

interface Props {
  onSend: () => void;
  onLock: () => void;
}

export function Account({ onSend, onLock }: Props) {
  const account = getAccount();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!account) {
      onLock();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const adapter = getAdapter();
        const bal = await adapter.getBalance(account.address);
        if (!cancelled) setBalance(bal);
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

    void QRCode.toDataURL(account.address, {
      margin: 1,
      width: 240,
      color: { dark: '#0a0a0a', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        /* ignore QR errors */
      });

    return () => {
      cancelled = true;
    };
  }, [account, onLock]);

  if (!account) return null;

  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(account.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div>
      <h1 className="nd-h1">내 지갑</h1>
      <p className="nd-lead">TTL 메인넷 · 체인 ID 7777</p>

      <div className="nd-card">
        <p className="nd-label">잔액</p>
        <div>
          <span className="nd-balance">{loading ? '...' : formatTtl(balance)}</span>
          <span className="nd-balance__unit">TTL</span>
        </div>
        {error && <div className="nd-error">{error}</div>}
      </div>

      <div className="nd-card">
        <p className="nd-label">받는 주소</p>
        <div className="nd-addr">{account.address}</div>
        <div style={{ height: 10 }} />
        <button type="button" className="nd-btn nd-btn--ghost" onClick={copyAddr}>
          {copied ? '주소 복사됨' : '주소 복사'}
        </button>
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
      </div>

      <button type="button" className="nd-btn nd-btn--primary" onClick={onSend}>
        송금
      </button>
      <button type="button" className="nd-btn nd-btn--ghost" onClick={onLock}>
        잠금
      </button>
    </div>
  );
}

function formatTtl(wei: bigint | null): string {
  if (wei == null) return '0.0000';
  // format to 4 decimal places (truncate, not round, to be conservative)
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 4);
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}
