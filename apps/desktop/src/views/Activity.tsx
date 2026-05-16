// Activity.tsx — 데스크톱 활동 화면.
//
// 좌측 사이드바의 "활동" 메뉴 항목에서 열린다. 잠금 해제 시에만 보이며,
// ActivityLog.list() 의 결과를 표로 렌더. 행 클릭은 native 환경(Tauri) 에서
// 외부 브라우저로 explorer URL 을 열도록 단순히 <a target="_blank"> 사용.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityLog,
  TTL_CHAIN,
  type Activity as ActivityT,
  type WalletAccount,
} from '@nodong/wallet-sdk';
import { AmountDisplay, Button, Card } from '@nodong/design-system';
import { useT } from '@nodong/i18n/react';
import { walletStore } from '../wallet-store.js';

interface Props {
  unlocked: boolean;
  onGoWallet: () => void;
}

const EXPLORER = TTL_CHAIN.blockExplorers?.default?.url ?? 'https://scan.ttl1.top';

function fmtTime(unix: number): string {
  if (!unix || !Number.isFinite(unix)) return '-';
  const d = new Date(unix * 1000);
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function shortAddr(a: string): string {
  if (!a || a.length < 12) return a;
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}

export function Activity({ unlocked, onGoWallet }: Props) {
  const t = useT();
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [items, setItems] = useState<ActivityT[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const adapter = walletStore.getDefaultAdapter() as unknown as ConstructorParameters<
      typeof ActivityLog
    >[0];
    const log = new ActivityLog(adapter);
    log
      .list(account.address, 20)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setItems([]);
          setError(err instanceof Error ? err.message : t('activity.failed'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  if (!unlocked || !account) {
    return (
      <div className="nd-view">
        <header className="nd-view__header">
          <h1 className="nd-h1">{t('activity.title')}</h1>
          <p className="nd-lead">{t('send.locked_lead')}</p>
        </header>
        <Card as="section">
          <Button variant="primary" className="nd-button--block" onClick={onGoWallet}>
            {t('send.go_to_wallet')}
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">{t('activity.title')}</h1>
        <p className="nd-lead">{t('activity.lead_short')}</p>
      </header>

      <Card as="section">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span className="nd-muted">
            {loading
              ? t('common.loading_ellipsis')
              : t('activity.count_with_max', { n: items?.length ?? 0 })}
          </span>
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
            {t('common.refresh')}
          </Button>
        </div>

        {error && <div className="nd-error">{error}</div>}

        {!loading && items && items.length === 0 && !error && (
          <p className="nd-muted" style={{ marginTop: 12 }}>
            {t('activity.empty')}
          </p>
        )}

        {items && items.length > 0 && (
          <table className="nd-activity-table">
            <thead>
              <tr>
                <th>{t('activity.col.time')}</th>
                <th>{t('activity.col.type')}</th>
                <th>{t('activity.col.counterparty')}</th>
                <th>{t('activity.col.amount')}</th>
                <th>{t('activity.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const isOutgoing =
                  account.address.toLowerCase() === it.from.toLowerCase();
                const counterparty = isOutgoing ? it.to : it.from;
                const sign = isOutgoing ? '-' : '+';
                const tokenLabel = it.token ? t('activity.label.token') : t('activity.label.native');
                return (
                  <tr key={`${it.hash}-${it.blockNumber}`}>
                    <td>{fmtTime(it.timestamp)}</td>
                    <td>
                      {isOutgoing ? t('activity.outgoing') : t('activity.incoming')} · {tokenLabel}
                    </td>
                    <td className="nd-mono">{shortAddr(counterparty)}</td>
                    <td className="nd-mono" style={{ textAlign: 'right' }}>
                      {sign}
                      <AmountDisplay
                        value={it.value}
                        decimals={18}
                        symbol={it.token ? 'TOK' : 'TTL'}
                        maxDecimals={4}
                        size="sm"
                      />
                    </td>
                    <td>
                      <a
                        href={`${EXPLORER}/tx/${it.hash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {it.status === 'failed' ? t('activity.status_failed') : t('activity.status_confirmed')}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
