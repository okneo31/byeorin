// Activity.tsx — 최근 활동 목록 화면 (web).
//
// 잠금이 풀린 상태에서 walletStore.getAccount() 로 주소를 얻고
// ActivityLog.list() 로 최근 20건을 받아 보여준다.
//
// UX:
//   - 행은 button 으로 만들어 키보드 enter 로 확장 가능.
//   - 클릭 → 인라인 확장(트랜잭션 해시 + 탐색기 링크).
//   - 상태 칩(완료/보류/실패) 으로 시각 위계 강화.
//   - 비어 있을 때 중앙 정렬 빈 상태 메시지 + 작은 아이콘.

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
  onBack: () => void;
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

// 상태 → 칩 prop. ActivityLog 의 status 가 'failed' | 'confirmed' | 'pending' 추정.
type PillKind = 'done' | 'pending' | 'fail';
function pillKindOf(status: string | undefined): PillKind {
  if (status === 'failed') return 'fail';
  if (status === 'pending') return 'pending';
  // 'confirmed' 외에 빈 값이 와도 일단 done 으로 보여 준다 — Activity API 가
  // 명시적인 status 를 채우지 않는 어댑터가 있을 수 있다.
  return 'done';
}

export function Activity({ onBack }: Props) {
  const t = useT();
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [items, setItems] = useState<ActivityT[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!walletStore.isUnlocked()) return;
    void walletStore.getAccount().then((a) => {
      if (!cancelled) setAccount(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const adapter = walletStore.getDefaultAdapter() as unknown as ConstructorParameters<typeof ActivityLog>[0];
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
  }, [account, reloadKey, t]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const pillLabel = (k: PillKind) =>
    k === 'done' ? t('activity.status_done')
    : k === 'pending' ? t('activity.status_pending')
    : t('activity.status_fail');

  return (
    <div>
      <h1 className="nd-h1">{t('activity.title')}</h1>
      <p className="nd-lead">{t('activity.lead')}</p>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="nd-muted">
            {loading
              ? t('common.loading_ellipsis')
              : t('activity.count', { n: items?.length ?? 0 })}
          </span>
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
            {t('common.refresh')}
          </Button>
        </div>
        {error && <div className="nd-error">{error}</div>}
        {!loading && items && items.length === 0 && !error && (
          <div className="web-activity__empty">
            <div className="web-activity__empty-icon" aria-hidden="true">·</div>
            <p className="nd-muted" style={{ margin: 0 }}>
              {t('activity.empty_web')}
            </p>
          </div>
        )}
        {items && items.length > 0 && (
          <ul className="web-activity">
            {items.map((it) => {
              const isOutgoing =
                account?.address?.toLowerCase() === it.from.toLowerCase();
              const counterparty = isOutgoing ? it.to : it.from;
              const sign = isOutgoing ? '-' : '+';
              const rowKey = `${it.hash}-${it.blockNumber}`;
              const isOpen = expanded === rowKey;
              const pk = pillKindOf(it.status);
              return (
                <li key={rowKey} className="web-activity__item">
                  <button
                    type="button"
                    className="web-activity__row"
                    onClick={() => setExpanded(isOpen ? null : rowKey)}
                    aria-expanded={isOpen}
                  >
                    <div>
                      <div className="web-activity__time">{fmtTime(it.timestamp)}</div>
                      <div className="web-activity__direction">
                        <span>{isOutgoing ? t('activity.outgoing') : t('activity.incoming')}</span>
                        <span className={`web-pill web-pill--${pk}`}>{pillLabel(pk)}</span>
                      </div>
                      <div className="web-activity__counterparty">
                        {shortAddr(counterparty)}
                      </div>
                    </div>
                    <div className="web-activity__amount">
                      <span>
                        {sign}
                        <AmountDisplay
                          value={it.value}
                          decimals={it.token ? 18 : 18}
                          symbol={it.token ? 'TOK' : 'TTL'}
                          maxDecimals={4}
                          size="sm"
                        />
                      </span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="web-activity__expanded">
                      <div>
                        <strong>{t('activity.tx_hash_label')}: </strong>
                        <span className="nd-hash">{it.hash}</span>
                      </div>
                      <div>
                        <a
                          href={`${EXPLORER}/tx/${it.hash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('activity.view_in_explorer')}
                        </a>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Button variant="ghost" className="nd-button--block" onClick={onBack}>
        {t('common.back')}
      </Button>
    </div>
  );
}
