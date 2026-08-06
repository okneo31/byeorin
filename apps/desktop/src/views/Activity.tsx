// Activity.tsx — 데스크톱 활동 화면.
//
// 좌측 사이드바의 "활동" 메뉴 항목에서 열린다. 잠금 해제 시에만 보이며,
// ActivityLog.list() 의 결과를 표로 렌더. 행 클릭은 native 환경(Tauri) 에서
// 외부 브라우저로 explorer URL 을 열도록 단순히 <a target="_blank"> 사용.

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import {
  ActivityLog,
  splitMemoLinks,
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

/**
 * 활동 항목의 메모를 읽는다. 인덱서(TTL 전용 경로)가 채워 주는 값이고, 그 외
 * 경로(다른 EVM 체인·RPC fallback)에서는 아예 없다 — 그래서 optional 로 읽는다.
 *
 * 인덱서가 이미 판정한 값이지만 지갑에서 한 번 더 거른다. 체인에서 온 임의
 * 문자열이라 남이 준 판정을 그대로 믿지 않는다. 규칙은 SDK 의 validateMemo 하나뿐.
 */
function readMemo(it: ActivityT): string | null {
  const raw = (it as { memo?: unknown }).memo;
  if (typeof raw !== 'string') return null;
  return validateMemo(raw).ok ? raw : null;
}

/** 메모 안 URL 의 <a> 클래스. 셸마다 이 상수만 다르다. */
const MEMO_LINK_CLASS = 'nd-activity-memo-link';

// 이 파일의 탐색기 링크(아래 <td> 안 <a target="_blank">)와 **같은 방식**을 쓴다.
// 그쪽은 이미 출시돼 동작하는 경로다. 메모 링크만 preventDefault + window.open 으로
// 따로 가면, 그 경로가 막혔을 때 두 칸 옆 탐색기 링크는 열리는데 메모 링크만
// 무반응이 된다 — 한 화면에 서로 다른 동작이 생긴다.
// 행 토글로 새지 않게 전파만 막는다. 나머지 3종도 이 한 줄뿐이다.
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
 * 링크가 0개면 조각이 text 하나뿐이라 결과 DOM 은 예전과 완전히 같다(회귀 0).
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
                const memo = readMemo(it);
                return (
                  <Fragment key={`${it.hash}-${it.blockNumber}`}>
                  <tr>
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
                  {/* 메모 — 표를 6열로 늘리지 않고 행 아래 전폭 행으로 붙인다.
                      React 노드로만 렌더한다(dangerouslySetInnerHTML 금지).
                      http(s) URL 은 <a> 로 만든다 — href 와 화면 글자가 같은 값이라
                      링크 위장이 생기지 않고, javascript:/data: 는 SDK 정규식이
                      애초에 잡지 않아 평문으로 남는다. */}
                  {memo && (
                    <tr className="nd-activity-table__memo-row">
                      <td colSpan={5}>
                        <span className="nd-muted">{t('activity.memo_label')}</span>{' '}
                        <span
                          className={`nd-activity-memo${memoHasLink(memo) ? ' nd-activity-memo--has-link' : ''}`}
                        >
                          {renderMemo(memo)}
                        </span>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
