// Activity.tsx — 최근 활동 목록 화면 (web).
//
// 잠금이 풀린 상태에서 walletStore.getAccount() 로 주소를 얻고
// ActivityLog.list() 로 최근 20건을 받아 보여준다. 행 클릭은 explorer 의
// /tx/{hash} 로 새 탭 이동.
//
// 본 화면은 의도적으로 가볍게 만들었다 — refresh 버튼 한 개, 행마다
// 4개 정보(시간/타입/상대주소/금액) 만. 디자인 시스템에 새 컴포넌트 추가
// 없이 .nd-card / .nd-button / .nd-muted 만 재사용.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityLog,
  TTL_CHAIN,
  type Activity as ActivityT,
  type WalletAccount,
} from '@nodong/wallet-sdk';
import { AmountDisplay, Button, Card } from '@nodong/design-system';
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

export function Activity({ onBack }: Props) {
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [items, setItems] = useState<ActivityT[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
          setError(err instanceof Error ? err.message : '활동을 불러오지 못했습니다.');
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

  return (
    <div>
      <h1 className="nd-h1">활동</h1>
      <p className="nd-lead">최근 송금 및 토큰 전송 기록입니다.</p>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="nd-muted">{loading ? '불러오는 중…' : `${items?.length ?? 0}건`}</span>
          <Button variant="ghost" onClick={reload} disabled={loading}>
            새로고침
          </Button>
        </div>
        {error && <div className="nd-error">{error}</div>}
        {!loading && items && items.length === 0 && !error && (
          <p className="nd-muted" style={{ marginTop: 12 }}>
            아직 기록이 없습니다.
          </p>
        )}
        {items && items.length > 0 && (
          <ul className="nd-activity">
            {items.map((it) => {
              const isOutgoing =
                account?.address?.toLowerCase() === it.from.toLowerCase();
              const counterparty = isOutgoing ? it.to : it.from;
              const sign = isOutgoing ? '-' : '+';
              const tokenLabel = it.token ? '토큰' : 'TTL';
              return (
                <li key={`${it.hash}-${it.blockNumber}`} className="nd-activity__row">
                  <a
                    href={`${EXPLORER}/tx/${it.hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="nd-activity__link"
                  >
                    <div className="nd-activity__meta">
                      <span className="nd-activity__type">
                        {isOutgoing ? '보냄' : '받음'} · {tokenLabel}
                      </span>
                      <span className="nd-muted">{fmtTime(it.timestamp)}</span>
                    </div>
                    <div className="nd-activity__sub">
                      <span className="nd-muted">{shortAddr(counterparty)}</span>
                      <span className="nd-activity__value">
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
                    {it.status === 'failed' && <div className="nd-error">실패</div>}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Button variant="ghost" className="nd-button--block" onClick={onBack}>
        뒤로
      </Button>
    </div>
  );
}
