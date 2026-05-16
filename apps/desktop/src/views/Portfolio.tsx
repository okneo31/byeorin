import { useCallback, useEffect, useState } from 'react';
import type { WalletAccount } from '@nodong/wallet-sdk';
import { AmountDisplay, Button, Card } from '@nodong/design-system';
import { useT } from '@nodong/i18n/react';
import { walletStore } from '../wallet-store.js';

interface Props {
  unlocked: boolean;
}

/** Locale-independent status discriminant. Rendered via i18n at JSX time. */
type ChainStatus = 'live' | 'pending';

interface AssetCard {
  symbol: string;
  name: string;
  status: ChainStatus;
  /** 실제 잔액 조회가 가능한 체인인지 (현재는 TTL만 활성). */
  live?: boolean;
  /** 표시용 소수 자릿수. */
  decimals?: number;
}

const ASSETS: readonly AssetCard[] = [
  { symbol: 'TTL', name: 'TTL Mainnet', status: 'live', live: true, decimals: 18 },
  { symbol: 'ETH', name: 'Ethereum', status: 'pending' },
  { symbol: 'BTC', name: 'Bitcoin', status: 'pending' },
  { symbol: 'XRP', name: 'XRP Ledger', status: 'pending' },
  { symbol: 'ATOM', name: 'Cosmos Hub', status: 'pending' },
  { symbol: 'MATIC', name: 'Polygon', status: 'pending' },
  { symbol: 'BNB', name: 'BNB Smart Chain', status: 'pending' },
  { symbol: 'AVAX', name: 'Avalanche', status: 'pending' },
];

export function Portfolio({ unlocked }: Props) {
  const t = useT();
  const [account, setAccount] = useState<WalletAccount | null>(null);

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

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">{t('portfolio.title')}</h1>
        <p className="nd-lead">
          {t('portfolio.lead')}
        </p>
      </header>

      {!unlocked && (
        <div className="nd-warn">
          {t('portfolio.locked_warn')}
        </div>
      )}

      <section className="nd-grid">
        {ASSETS.map((a) => (
          <Card key={a.symbol} elevation="flat">
            <div className="nd-tile__sym">{a.symbol}</div>
            <div className="nd-tile__name">{a.name}</div>

            {a.live && account ? (
              <LiveTtlBalance address={account.address} decimals={a.decimals ?? 18} />
            ) : null}

            <div
              className={
                'nd-tile__status' +
                (a.status === 'live' ? ' nd-tile__status--live' : ' nd-tile__status--pending')
              }
            >
              {a.status === 'live' ? t('portfolio.status.live') : t('portfolio.status.pending')}
            </div>
          </Card>
        ))}
      </section>
    </div>
  );
}

/**
 * TTL 잔액을 라이브로 보여주는 작은 위젯.
 * 빈 지갑(0n)과 RPC 오류를 절대 혼동하지 않도록 triple-state 패턴 적용.
 */
function LiveTtlBalance({ address, decimals }: { address: string; decimals: number }) {
  const t = useT();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [reloadKey, setReloadKey] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    walletStore
      .getDefaultAdapter()
      .getBalance(address)
      .then((b) => {
        if (cancelled) return;
        setBalance(b);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBalance(null);
        setError(err instanceof Error ? err.message : t('account.balance_failed'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, reloadKey, t]);

  const retry = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  if (loading) {
    return <div className="nd-muted" style={{ marginTop: 6 }}>{t('account.balance_loading')}</div>;
  }
  if (error) {
    return (
      <div style={{ marginTop: 6 }}>
        <div className="nd-error" style={{ marginTop: 0 }}>
          {t('portfolio.balance_error', { reason: error })}
        </div>
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" size="sm" onClick={retry}>
            {t('account.retry')}
          </Button>
        </div>
      </div>
    );
  }
  if (balance != null) {
    return (
      <div style={{ marginTop: 6 }}>
        <AmountDisplay value={balance} decimals={decimals} symbol="TTL" size="md" />
      </div>
    );
  }
  return null;
}
