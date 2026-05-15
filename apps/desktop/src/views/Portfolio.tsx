import { useCallback, useEffect, useState } from 'react';
import type { WalletAccount } from '@nodong/wallet-sdk';
import { AmountDisplay, Button, Card } from '@nodong/design-system';
import { getAccount, getAdapter } from '../wallet-store.js';

interface Props {
  unlocked: boolean;
}

type ChainStatus = '연결' | '준비 중';

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
  { symbol: 'TTL', name: 'TTL Mainnet', status: '연결', live: true, decimals: 18 },
  { symbol: 'ETH', name: 'Ethereum', status: '준비 중' },
  { symbol: 'BTC', name: 'Bitcoin', status: '준비 중' },
  { symbol: 'XRP', name: 'XRP Ledger', status: '준비 중' },
  { symbol: 'ATOM', name: 'Cosmos Hub', status: '준비 중' },
  { symbol: 'MATIC', name: 'Polygon', status: '준비 중' },
  { symbol: 'BNB', name: 'BNB Smart Chain', status: '준비 중' },
  { symbol: 'AVAX', name: 'Avalanche', status: '준비 중' },
];

export function Portfolio({ unlocked }: Props) {
  const account: WalletAccount | null = unlocked ? getAccount() : null;

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">포트폴리오</h1>
        <p className="nd-lead">
          멀티체인 자산 한 눈에 보기. TTL 외 체인은 곧 활성화됩니다.
        </p>
      </header>

      {!unlocked && (
        <div className="nd-warn">
          지갑을 열면 자산이 표시됩니다. 좌측 메뉴에서 지갑을 시작하세요.
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
                (a.status === '연결' ? ' nd-tile__status--live' : ' nd-tile__status--pending')
              }
            >
              {a.status}
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
  const [balance, setBalance] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [reloadKey, setReloadKey] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getAdapter()
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
        setError(err instanceof Error ? err.message : '잔액 조회 실패');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, reloadKey]);

  const retry = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  if (loading) {
    return <div className="nd-muted" style={{ marginTop: 6 }}>잔액 조회 중…</div>;
  }
  if (error) {
    return (
      <div style={{ marginTop: 6 }}>
        <div className="nd-error" style={{ marginTop: 0 }}>잔액 오류 · {error}</div>
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" size="sm" onClick={retry}>
            다시 시도
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
