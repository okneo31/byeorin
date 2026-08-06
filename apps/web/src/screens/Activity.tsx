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

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import {
  ActivityLog,
  TokenRegistry,
  TTL_CHAIN,
  splitMemoLinks,
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

/** 메모 안 URL 의 <a> 클래스. 셸마다 이 상수만 다르다. */
const MEMO_LINK_CLASS = 'web-activity__memo-link';

// 활동 행 자체가 클릭 대상인 셸(web)이 있어 행 토글로 새지 않게 막는다.
function handleMemoLinkClick(e: MouseEvent<HTMLAnchorElement>): void {
  e.stopPropagation();
}

/**
 * SDK 정규식은 /https?:\/\/[^\s<]+/g 라 공백 전까지 전부 먹는다 —
 * "확인 https://a.com." 이면 마침표까지 링크가 된다. 꼬리 문장부호를 링크에서
 * 떼어내 텍스트로 돌려준다.
 *
 * **잘라낸 뒤의 값을 href 와 화면 텍스트 양쪽에 똑같이 쓴다.** 둘이 달라지는
 * 순간 링크 위장이 생긴다 — 이 함수의 반환값 link 는 그 하나뿐인 출처다.
 */
const MEMO_TAIL_PUNCT = '.,;:!?…\'"’”»';
function trimMemoUrlTail(url: string): { link: string; tail: string } {
  let end = url.length;
  while (end > 0) {
    const ch = url.charAt(end - 1);
    if (ch === ')' || ch === ']' || ch === '}') {
      // 괄호는 URL 안에 정상적으로 들어간다(위키백과 주소). 여는 짝이 URL 안에
      // 있으면 URL 의 일부로 남기고, 짝이 없을 때만(= 감싼 괄호) 떼어낸다.
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      const body = url.slice(0, end);
      const opens = body.split(open).length - 1;
      const closes = body.split(ch).length - 1;
      if (closes <= opens) break;
      end -= 1;
      continue;
    }
    if (MEMO_TAIL_PUNCT.includes(ch)) {
      end -= 1;
      continue;
    }
    break;
  }
  return { link: url.slice(0, end), tail: url.slice(end) };
}

/**
 * 메모 → React 노드 배열. **HTML 문자열을 만들지 않는다** —
 * dangerouslySetInnerHTML / innerHTML 금지. 텍스트는 React 텍스트 노드,
 * 링크만 <a> 다. 이스케이프는 React 가 한다.
 *
 * 링크가 0개면 조각이 text 하나뿐이라 이 함수의 출력은 예전과 같다.
 *
 * 다만 이 셸은 **메모 블록의 위치가 바뀌었다** — 예전에는 행 <button> 안에
 * 있었으나 지금은 그 형제다. <button> 안에 <a> 를 넣는 것이 무효 마크업이라
 * 어쩔 수 없다. 그래서 링크가 없는 메모라도 글자를 눌러 행이 펼쳐지지 않고
 * 행 hover 배경도 들어오지 않는다. 나머지 3종은 메모를 제자리에 뒀다.
 * 잘림(말줄임) 은 절대 하지 않는다 — 화면 텍스트가 목적지의 앞부분만 보이면
 * 그 자체가 링크 위장이다.
 */
function renderMemo(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  splitMemoLinks(text).forEach((seg, i) => {
    if (seg.kind === 'text') {
      out.push(<Fragment key={`t${i}`}>{seg.value}</Fragment>);
      return;
    }
    const { link, tail } = trimMemoUrlTail(seg.value);
    // 꼬리를 떼고 나니 http(s)://호스트 꼴이 아니면 링크로 만들지 않는다.
    if (!/^https?:\/\/[^/\s]/.test(link)) {
      out.push(<Fragment key={`t${i}`}>{seg.value}</Fragment>);
      return;
    }
    out.push(
      <a
        key={`l${i}`}
        className={MEMO_LINK_CLASS}
        href={link}
        target="_blank"
        rel="noreferrer noopener"
        onClick={handleMemoLinkClick}
      >
        {link}
      </a>,
    );
    if (tail.length > 0) out.push(<Fragment key={`p${i}`}>{tail}</Fragment>);
  });
  return out;
}

/** 메모에 링크가 하나라도 있나. 있으면 컨테이너의 줄접기(-webkit-line-clamp)를 끈다. */
function memoHasLink(text: string): boolean {
  return splitMemoLinks(text).some(
    (s) => s.kind === 'link' && /^https?:\/\/[^/\s]/.test(trimMemoUrlTail(s.value).link),
  );
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
                  {memo !== null && (
                    // 메모는 체인에서 온 임의 문자열이다. React 노드로만 렌더한다 —
                    // dangerouslySetInnerHTML 금지. http(s) URL 만 <a> 로 그리고
                    // href 와 화면 글자는 같은 값이라 링크 위장이 생기지 않는다.
                    //
                    // <button> 안에 <a> 를 넣는 것은 대화형 요소 중첩이라 무효
                    // 마크업이므로, 메모 블록은 행 button 밖(li 의 형제)에 둔다.
                    <div
                      className={`web-activity__memo${
                        memoHasLink(memo) ? ' web-activity__memo--has-link' : ''
                      }`}
                    >
                      <span className="web-activity__memo-label">
                        {t('activity.memo_label')}
                      </span>{' '}
                      <span className="web-activity__memo-text">{renderMemo(memo)}</span>
                    </div>
                  )}
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
