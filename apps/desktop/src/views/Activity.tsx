// Activity.tsx — 데스크톱 활동 화면.
//
// 좌측 사이드바의 "활동" 메뉴 항목에서 열린다. 잠금 해제 시에만 보이며,
// ActivityLog.list() 의 결과를 표로 렌더. 행 클릭은 native 환경(Tauri) 에서
// 외부 브라우저로 explorer URL 을 열도록 단순히 <a target="_blank"> 사용.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityLog,
  TokenRegistry,
  TTL_CHAIN,
  type Activity as ActivityT,
  type WalletAccount,
} from '@byeorin/wallet-sdk';
import { AmountDisplay, Button, Card } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';
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

// 네이티브 심볼을 체인 정의에서 가져온다 — 화면에 'TTL' 을 박아두면 체인이 바뀔 때 틀린다.
const NATIVE_SYMBOL = TTL_CHAIN.nativeCurrency.symbol;
const NATIVE_DECIMALS = TTL_CHAIN.nativeCurrency.decimals;

// 내장 토큰 목록. 데스크톱 셸에는 발견된 토큰 상태가 없어 이 레지스트리가 유일한 조회처다.
const tokenRegistry = new TokenRegistry();

// 자릿수를 모르는 토큰은 소수로 환산하지 않는다 — 추측한 자릿수는 금액을 틀리게 만든다.
function withCommas(v: bigint): string {
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 활동 항목의 컨트랙트 주소로 심볼·자릿수를 찾는다. 못 찾으면 null — 추측 금지.
function resolveTokenMeta(token: string | undefined): { symbol: string; decimals: number } | null {
  if (!token) return { symbol: NATIVE_SYMBOL, decimals: NATIVE_DECIMALS };
  const info = tokenRegistry.getToken(TTL_CHAIN.id, token as `0x${string}`);
  return info ? { symbol: info.symbol, decimals: info.decimals } : null;
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
                const meta = resolveTokenMeta(it.token);
                // 심볼 자리에 고정 문구 "토큰" 을 쓰지 않는다 — 모르면 주소를 그대로 보여준다.
                const tokenLabel = meta
                  ? meta.symbol
                  : `${t('activity.label.unknown_token')} · ${shortAddr(it.token as string)}`;
                return (
                  <tr key={`${it.hash}-${it.blockNumber}`}>
                    <td>{fmtTime(it.timestamp)}</td>
                    <td>
                      {isOutgoing ? t('activity.outgoing') : t('activity.incoming')} · {tokenLabel}
                    </td>
                    <td className="nd-mono">{shortAddr(counterparty)}</td>
                    <td className="nd-mono" style={{ textAlign: 'right' }}>
                      {sign}
                      {meta ? (
                        <AmountDisplay
                          value={it.value}
                          decimals={meta.decimals}
                          symbol={meta.symbol}
                          maxDecimals={4}
                          size="sm"
                        />
                      ) : (
                        // 자릿수 미상 — 최소 단위임을 금액 옆에 붙여 소수로 오독되지 않게 한다.
                        <span title={t('activity.label.raw_units')}>
                          {withCommas(it.value)} {shortAddr(it.token as string)}{' '}
                          <span className="nd-muted">({t('activity.label.raw_units')})</span>
                        </span>
                      )}
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
