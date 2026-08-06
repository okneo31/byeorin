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
  TokenRegistry,
  TTL_CHAIN,
  validateMemo,
  type Activity as ActivityT,
  type WalletAccount,
} from '@byeorin/wallet-sdk';
import { AmountDisplay, Button, Card } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';
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

const NATIVE_SYMBOL = TTL_CHAIN.nativeCurrency?.symbol ?? 'TTL';
const NATIVE_DECIMALS = TTL_CHAIN.nativeCurrency?.decimals ?? 18;

const tokenRegistry = new TokenRegistry();

// 활동 항목의 컨트랙트 주소로 심볼·자릿수를 찾는다. 못 찾으면 null —
// 추측해서 소수로 환산하면 화면의 금액 자체가 틀린다.
function resolveTokenMeta(token: string | undefined): { symbol: string; decimals: number } | null {
  if (!token) return { symbol: NATIVE_SYMBOL, decimals: NATIVE_DECIMALS };
  const info = tokenRegistry.getToken(TTL_CHAIN.id, token as `0x${string}`);
  return info ? { symbol: info.symbol, decimals: info.decimals } : null;
}

// 웹 셸에는 발견된 토큰 목록 상태가 없다 — 즉 ERC-20 의 자릿수를 알 방법이 없다.
// 모르는 자릿수를 18 로 가정하면 화면의 금액 자체가 틀리므로(USDC 는 6),
// 토큰 항목은 소수 환산을 하지 않고 최소 단위 그대로 쉼표만 넣어 보여준다.
export function rawAmount(v: bigint): string {
  const s = v.toString();
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  return (neg ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 활동 항목의 메모. TTL(chainId 7777) 인덱서 경로에서만 채워지므로 이 셸에서는
// 체인 분기를 두지 않는다 — 값이 있으면 그린다.
//
// 인덱서가 준 문자열을 그대로 믿지 않고 송신 때와 같은 규칙(SDK validateMemo)으로
// 한 번 더 거른다. 제어문자·깨진 글자가 화면에 오르지 않는다.
// 필드는 optional 로 확장되는 중이라(SDK activity/log.ts) 좁혀서 읽는다.
function memoOf(it: ActivityT): string | null {
  const raw = (it as { memo?: unknown }).memo;
  if (typeof raw !== 'string') return null;
  return validateMemo(raw).ok ? raw : null;
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
              const memo = memoOf(it);
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
                      {memo !== null && (
                        // 메모는 체인에서 온 임의 문자열이다. React 텍스트 노드로만
                        // 렌더한다 — dangerouslySetInnerHTML 금지, 링크 변환도 하지
                        // 않는다(행이 button 이라 <a> 를 넣을 수도 없다).
                        <div className="web-activity__memo">
                          <span className="web-activity__memo-label">
                            {t('activity.memo_label')}
                          </span>{' '}
                          <span className="web-activity__memo-text">{memo}</span>
                        </div>
                      )}
                    </div>
                    <div className="web-activity__amount">
                      <span>
                        {sign}
                        {(() => {
                          const meta = resolveTokenMeta(it.token);
                          // meta 가 null 인 경우는 it.token 이 있을 때뿐이지만(native 는
                          // 항상 값이 나온다) 타입은 그걸 모르므로 빈 문자열로 좁힌다.
                          // 자릿수를 모르면 소수로 읽히지 않도록 최소 단위임을 함께 적는다.
                          return meta === null ? (
                            <span title={t('activity.label.raw_units')}>
                              {rawAmount(it.value)} {shortAddr(it.token ?? '')}
                            </span>
                          ) : (
                            <AmountDisplay
                              value={it.value}
                              decimals={meta.decimals}
                              symbol={meta.symbol}
                              maxDecimals={4}
                              size="sm"
                            />
                          );
                        })()}
                      </span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="web-activity__expanded">
                      {it.token && resolveTokenMeta(it.token) === null && (
                        <div className="nd-muted">
                          {t('activity.label.unknown_token')} · {shortAddr(it.token)} ·{' '}
                          {t('activity.label.raw_units')}
                        </div>
                      )}
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
