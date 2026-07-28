// ActivityPane.tsx — 안드로이드 셸의 활동 내역 화면.
//
// 확장 popup(apps/extension/entrypoints/popup/screens/ActivityPane.tsx)에서 그대로
// 이식했다. 확장판은 데스크톱 `apps/desktop/src/views/Activity.tsx` 의 5열 <table>
// 을 좁은 폭에 맞춰 항목당 3줄짜리 카드 리스트로 바꾼 것이고, 그 구조를 유지한다:
//
//   1행: [보냄/받음] ······················· 상대 시간(절대 시간은 title)
//   2행: 상대방 주소(축약) ················· ±금액 심볼
//   3행: native/토큰 구분 · 상태 ·········· (TTL 만) 탐색기 링크
//
// 조회는 SDK 의 ActivityLog 를 그대로 쓴다. 재구현하지 않는다.
// ActivityLog 는 루트 배럴(@byeorin/wallet-sdk)에서만 export 되는데, 루트 배럴은
// cosmos/ton/xrp/solana 어댑터를 전부 끌고 온다. 그래서 App.tsx 가 multichain 을
// 다루는 방식과 동일하게 **dynamic import** 로 가져와 초기 번들을 지킨다.

import { useCallback, useEffect, useState } from 'react';
import type { Activity } from '@byeorin/wallet-sdk';
import type { ChainAdapter } from '@byeorin/wallet-sdk/core';
import type { EvmAdapter } from '@byeorin/wallet-sdk/evm';
import { ShellError } from '@byeorin/shell-core';
import { useT } from '@byeorin/i18n/react';

// ────────── 상수 ──────────

// 조회 건수 상한. 20 을 고른 이유:
//   - i18n 의 'activity.count_with_max' 문구가 "(최근 20)" 으로 고정되어 있다.
//     여기서 다른 수를 쓰면 화면과 문구가 어긋난다 (카탈로그는 이 작업에서 수정 X).
//   - 셸 화면은 세로가 짧아 20 건이면 스크롤 3~4 화면. 그 이상은 실효가 없다.
const LIMIT = 20;

// RPC fallback 시 거슬러 올라갈 블록 수. SDK 기본값은 200 이지만 셸에서는 60.
//
// 이유: ActivityLog 의 native 스캔은 eth_getBlockByNumber 를 **직렬로** 한 블록씩
// 호출한다 (includeTransactions=true 라 응답도 크다). 매칭 tx 를 못 찾으면 최악의
// 경우 lookback 만큼 왕복하는데, 사용자가 언제든 닫아버리는 화면이라 200 왕복은
// 대부분 낭비로 끝난다. 공개 RPC 의 rate limit 도 데스크톱보다 빠듯하다.
// TTL 처럼 explorer API 가 있는 체인에서는 이 경로 자체를 거의 안 타므로, fallback
// 은 "없는 것보다 낫다" 수준으로만 얕게 잡는다.
const FALLBACK_LOOKBACK = 60;

// TTL 탐색기. App.tsx 의 isTtl 규칙과 동일 — evm:ttl 에서만 노출한다.
// (scan.ttl1.top 은 TTL 전용이라 다른 EVM 체인 해시를 붙이면 404 가 난다.)
const TTL_CHAIN_KEY = 'evm:ttl';
const TTL_EXPLORER = 'https://scan.ttl1.top';

// ActivityLog 는 토큰의 decimals 를 돌려주지 않는다 (explorer 의 tokentx 응답에도
// 넣지 않고, RPC fallback 은 Transfer 로그의 raw value 만 본다). 데스크톱과 같이
// ERC-20 다수파인 18 로 가정한다. USDC(6) 같은 토큰은 자릿수가 어긋나므로 금액
// 옆에 토큰 컨트랙트를 함께 보여 사용자가 식별할 수 있게 했다.
const ASSUMED_TOKEN_DECIMALS = 18;

// ────────── 순수 헬퍼 (테스트 대상) ──────────

/** 활성 체인이 EVM 인지. App.tsx 의 isEvm 과 같은 규칙. */
export function isEvmChainKey(chainKey: string): boolean {
  return chainKey.startsWith('evm:');
}

/** TTL 탐색기 tx URL. TTL 이 아니면 null — 다른 체인에 TTL 링크를 붙이지 않는다. */
export function explorerTxUrl(chainKey: string, hash: string): string | null {
  if (chainKey !== TTL_CHAIN_KEY) return null;
  if (!hash || hash === '0x') return null;
  return `${TTL_EXPLORER}/tx/${hash}`;
}

/** 주소/해시 축약. App.tsx 의 shortenAddress 와 같은 모양(6…4). */
export function shortenHex(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** 정수부 천 단위 쉼표. App.tsx 의 withCommas 와 같은 규칙. */
function withCommas(numStr: string): string {
  const [whole, frac] = numStr.split('.');
  const grouped = (whole ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/**
 * base-unit bigint → 소수 4자리 고정 문자열. App.tsx 의 formatAmount 와 동일한
 * 표기를 쓴다 (잔액 히어로와 활동 금액의 자릿수가 달라 보이면 안 된다).
 */
export function formatAmount(base: bigint, decimals: number): string {
  const factor = 10n ** BigInt(decimals);
  const whole = base / factor;
  const frac = base % factor;
  const fracStr = (Number(frac) / Number(factor)).toFixed(4).slice(2);
  return `${withCommas(whole.toString())}.${fracStr}`;
}

/**
 * 상대 시간 조각. i18n 을 끌어들이지 않으려고 키 + 수치만 돌려주고 문자열 조립은
 * 컴포넌트가 한다 (그래야 순수 함수로 테스트할 수 있다).
 *
 * timestamp 가 0 이면 null — ActivityLog 의 RPC fallback 은 ERC-20 Transfer 로그에
 * 블록 시각을 붙이지 않아 0 이 그대로 올라온다. 이 경우 화면은 블록 번호를 쓴다.
 */
export function relativeParts(
  unixSec: number,
  nowMs: number,
): { key: string; n: number } | null {
  if (!unixSec || !Number.isFinite(unixSec)) return null;
  const diffSec = Math.floor(nowMs / 1000) - Math.floor(unixSec);
  // 미래 시각(노드 시계 오차)은 "방금" 으로 흡수.
  if (diffSec < 60) return { key: 'activity.rel.just_now', n: 0 };
  if (diffSec < 3600) return { key: 'activity.rel.minutes', n: Math.floor(diffSec / 60) };
  if (diffSec < 86_400) return { key: 'activity.rel.hours', n: Math.floor(diffSec / 3600) };
  return { key: 'activity.rel.days', n: Math.floor(diffSec / 86_400) };
}

/** 절대 시각 'YYYY-MM-DD HH:mm' (로컬). title 속성용. 0 이면 null. */
export function absoluteTime(unixSec: number): string | null {
  if (!unixSec || !Number.isFinite(unixSec)) return null;
  const d = new Date(unixSec * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** 활성 주소 기준 방향 판정. 대소문자 무시 (체크섬 주소 대비). */
export function isOutgoing(activity: Activity, self: string): boolean {
  return activity.from.toLowerCase() === self.toLowerCase();
}

/** 상태 → i18n 키. 카탈로그의 기존 activity.status_* 를 그대로 쓴다. */
export function statusKey(status: Activity['status']): string {
  if (status === 'failed') return 'activity.status_failed';
  if (status === 'pending') return 'activity.status_pending';
  return 'activity.status_confirmed';
}

/** shell-core 도메인 에러를 i18n 키로. App.tsx 의 localizeShellError 와 동일 규칙. */
function localizeShellError(
  t: (k: string) => string,
  e: unknown,
  fallback: string,
): string {
  if (e instanceof ShellError) return t(`errors.${e.code}`);
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

// ────────── 화면 ──────────

export interface ActivityPaneProps {
  /** 홈으로 돌아가기. */
  onBack: () => void;
  /** 활성 계정 × 활성 체인 주소. null 이면 조회하지 않는다 (주소 도출 전/미지원). */
  address: string | null;
  /** 활성 체인 어댑터. EVM 일 때만 ActivityLog 로 넘어간다. */
  adapter: ChainAdapter;
  /** 활성 체인 키 ('evm:ttl' 등). EVM 분기와 탐색기 링크 판정에 쓴다. */
  chainKey: string;
  /** native 금액 표기용. */
  nativeSymbol: string;
  nativeDecimals: number;
}

export function ActivityPane({
  onBack,
  address,
  adapter,
  chainKey,
  nativeSymbol,
  nativeDecimals,
}: ActivityPaneProps) {
  const t = useT();
  const [items, setItems] = useState<Activity[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 상대 시간의 기준 시각. mount/재조회 시점에 한 번 고정한다 — 매 렌더마다
  // Date.now() 를 읽으면 같은 목록이 리렌더될 때마다 문구가 흔들린다.
  const [now, setNow] = useState<number>(() => Date.now());

  const isEvm = isEvmChainKey(chainKey);

  // 조회 — App.tsx 의 잔액 로딩과 같은 패턴 (cancelled 플래그로 race 차단).
  // 체인/주소를 빠르게 바꾸면 늦게 도착한 응답이 최신 상태를 덮어쓸 수 있다.
  useEffect(() => {
    if (!isEvm || !address) {
      setItems(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems(null);
    setNow(Date.now());
    void (async () => {
      try {
        // 루트 배럴 dynamic import — 초기 번들에 전 체인 어댑터가 안 실린다.
        const mod = await import('@byeorin/wallet-sdk');
        if (cancelled) return;
        // isEvm 분기를 이미 통과했으므로 어댑터는 EvmAdapter 다. ChainAdapter 는
        // 공통 인터페이스라 구조적으로 좁힐 방법이 없어 단언으로 넘긴다.
        const log = new mod.ActivityLog(adapter as unknown as EvmAdapter, {
          fallbackLookback: FALLBACK_LOOKBACK,
        });
        const rows = await log.list(address, LIMIT);
        if (!cancelled) setItems(rows);
      } catch (e) {
        // ActivityLog.list 자체는 실패를 삼키고 [] 를 주지만, dynamic import 실패
        // (CSP/네트워크) 나 어댑터 초기화 실패는 여기로 올라온다.
        if (!cancelled) {
          setItems([]);
          setError(localizeShellError(t, e, t('activity.failed')));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, adapter, isEvm, reloadKey, t]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // 비-EVM 체인 — ActivityLog 는 EVM 전용이므로 조회 자체를 시도하지 않는다.
  if (!isEvm) {
    return (
      <section className="card">
        <h2 className="create-step__title">{t('activity.title')}</h2>
        <p className="muted small">{t('activity.unsupported_chain')}</p>
        <button className="btn-ghost" onClick={onBack}>
          {t('common.back')}
        </button>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="create-step__title">{t('activity.title')}</h2>
      <p className="create-step__lead">{t('activity.lead_short')}</p>

      <div className="activity-head">
        <span className="muted small">
          {loading
            ? t('common.loading_ellipsis')
            : t('activity.count_with_max', { n: items?.length ?? 0 })}
        </span>
        <button className="btn-ghost btn-sm" onClick={reload} disabled={loading}>
          {t('common.refresh')}
        </button>
      </div>

      {/* 에러 — 재시도 버튼을 같이 둔다. 목록은 비운 상태. */}
      {error && (
        <>
          <p className="error small" role="alert">
            {error}
          </p>
          <button className="btn-primary btn-sm" onClick={reload} disabled={loading}>
            {t('activity.retry')}
          </button>
        </>
      )}

      {/* 로딩 */}
      {loading && <p className="muted small">{t('common.loading_ellipsis')}</p>}

      {/* 빈 목록 */}
      {!loading && !error && items !== null && items.length === 0 && (
        <p className="empty-state">{t('activity.empty')}</p>
      )}

      {/* 목록 */}
      {!loading && items !== null && items.length > 0 && (
        <ul className="activity-list">
          {items.map((it, i) => {
            const out = address !== null && isOutgoing(it, address);
            const peer = out ? it.to : it.from;
            const rel = relativeParts(it.timestamp, now);
            const abs = absoluteTime(it.timestamp);
            const decimals = it.token ? ASSUMED_TOKEN_DECIMALS : nativeDecimals;
            const symbol = it.token ? t('activity.label.token') : nativeSymbol;
            const url = explorerTxUrl(chainKey, it.hash);
            return (
              // RPC fallback 경로에서는 같은 hash 가 native/토큰 양쪽으로 잡힐 수
              // 있어 index 까지 키에 넣는다.
              <li key={`${it.hash}-${it.blockNumber.toString()}-${i}`} className="activity-row">
                <div className="activity-row__line">
                  <span
                    className={`activity-row__dir activity-row__dir--${out ? 'out' : 'in'}`}
                  >
                    {out ? t('activity.outgoing') : t('activity.incoming')}
                  </span>
                  <span className="activity-row__time muted small" title={abs ?? undefined}>
                    {rel
                      ? t(rel.key, { n: rel.n })
                      : t('activity.block_number', { n: it.blockNumber.toString() })}
                  </span>
                </div>

                <div className="activity-row__line">
                  <span className="activity-row__peer addr" title={peer}>
                    {shortenHex(peer)}
                  </span>
                  <span
                    className={`activity-row__amount activity-row__amount--${out ? 'out' : 'in'}`}
                  >
                    {out ? '−' : '+'}
                    {formatAmount(it.value, decimals)}{' '}
                    <span className="activity-row__symbol">{symbol}</span>
                  </span>
                </div>

                <div className="activity-row__line activity-row__line--foot">
                  <span className="muted small" title={it.token ?? undefined}>
                    {it.token
                      ? `${t('activity.label.token')} · ${shortenHex(it.token)}`
                      : nativeSymbol}
                    {' · '}
                    <span
                      className={
                        it.status === 'failed'
                          ? 'activity-row__status activity-row__status--failed'
                          : it.status === 'pending'
                            ? 'activity-row__status activity-row__status--pending'
                            : 'activity-row__status'
                      }
                    >
                      {t(statusKey(it.status))}
                    </span>
                  </span>
                  {/* TTL 에서만 탐색기 링크 — App.tsx 의 isTtl 규칙과 동일. */}
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="activity-row__link small"
                    >
                      {t('activity.view_in_explorer')}
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button className="btn-ghost" onClick={onBack}>
        {t('common.back')}
      </button>
    </section>
  );
}
