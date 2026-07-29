// ExchangePane.tsx — 벼린 거래소(TTL 체인 AMM) 스왑 화면 (안드로이드 셸).
//
// 설계 원천: docs/EXCHANGE.md. 계약: packages/wallet-sdk/src/exchange/types.ts.
// ZION SwapPane(App.tsx)의 "자산 선택 → 견적 → 확정" 흐름을 따르되 TTL 체인용이다.
//
// 확장판(apps/extension/entrypoints/popup/screens/ExchangePane.tsx)과 **내용이 같다**
// — 다른 것은 이 헤더 주석과 wallet-service import 경로뿐이다.
//
// 핵심 결정:
//  - `client` 는 **구조적 타입**(TtlAmmClientLike)으로 받는다. E-4(TtlAmmClient)가
//    아직 완성되지 않았고, 화면이 특정 구현에 결합하면 병렬 작업이 서로를
//    기다리게 된다. 실제 인스턴스는 상위(App.tsx)가 만들어 주입한다.
//  - `client === null` 이면 "아직 배포되지 않음" 을 그대로 그린다 — 성공한 척하지
//    않는다 (배포 주소가 아직 없다는 것이 현재의 사실이다).
//  - 실패를 구분한다: 풀 없음 / 준비금 0(시딩 전) / 견적 실패는 각각 다른
//    문구다. 0 이나 추정치를 지어내지 않는다.
//  - 창세 가격(벼린 환율) 대비 괴리는 **정보이지 경고가 아니다** — 시장가는
//    의도된 동작이다 (EXCHANGE.md §0). 환율이 없는 자산은 그 줄을 생략한다.
//  - ERC-20 입력이면 approve → swap 2단계임을 명시하고 순서대로 서명한다.
//    승인이 확정되기 전의 스왑은 실패할 수 있다 — 그 사실도 화면에 적는다.

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ChainAdapter, TransferIntent } from '@byeorin/wallet-sdk/core';
import { rateByAddress, TTL_AMM_NATIVE } from '@byeorin/wallet-sdk/evm';
import { ShellError } from '@byeorin/shell-core';
import { useT } from '@byeorin/i18n/react';
import { walletStore } from '../wallet-service.js';
import {
  formatAssetAmount,
  parseAssetAmount,
  type SelectedAsset,
} from '../lib/token-send.js';
import type { PortableTokenBalance } from '../lib/token-visibility.js';

// ────────── 거래소 계약 — 구조적 타입 ──────────
//
// `packages/wallet-sdk/src/exchange/types.ts` 의 TtlAmmPool / TtlAmmQuote /
// TtlAmmSwapCall 과 **구조가 같은** 선언이다. import 하지 않는 이유:
// wallet-sdk 의 공개 barrel(`./core`·`./evm`·`./multichain`)에 exchange 가 아직
// 노출돼 있지 않고, 셸 typecheck 는 기존 dist/*.d.ts 로 해석하므로 지금 import
// 하면 깨진다 (token-visibility.ts 의 PortableTokenBalance 와 같은 사정).
// barrel 에 노출되면 이 선언들을 지우고 import 한 줄로 바꾸면 된다.

/** 한 풀의 스냅샷 — Pair.getReserves 를 읽은 결과. tokenTtl 은 항상 WTTL. */
export interface TtlAmmPoolLike {
  pair: string;
  tokenTtl: string;
  token: string;
  reserveTtl: bigint;
  reserveToken: bigint;
}

/** 견적 — 슬리피지 반영 최소 수령량까지. route 는 1홉(직접) 또는 2홉(TTL 경유). */
export interface TtlAmmQuoteLike {
  amountOutEst: bigint;
  minAmountOut: bigint;
  route: readonly TtlAmmPoolLike[];
  /** 수수료 합 (홉당 33bps 누적) — **보내는 자산의 base unit** 기준 추정. */
  feeEst: bigint;
}

/** Router/ERC-20 호출 한 건 — TransferIntent 로 변환해 기존 서명 경로를 탄다. */
export interface TtlAmmSwapCallLike {
  to: string;
  data: `0x${string}`;
  value: bigint;
}

/**
 * E-4 `TtlAmmClient` 의 실제 표면 — 위치 인자, native 는 TTL_AMM_NATIVE
 * 센티널('native'). 구조적 타입이므로 실제 클래스든 null 이든 그대로 받는다.
 *
 * (처음에는 객체 인자로 자체 계약을 뒀지만, SDK 구현이 확정되며 표면을 하나로
 *  통일했다 — 어댑터를 끼우는 것보다 통일이 싸다.)
 */
export interface TtlAmmClientLike {
  listPools(tokens: string[]): Promise<readonly TtlAmmPoolLike[]>;
  quote(
    pools: readonly TtlAmmPoolLike[],
    tokenIn: string,
    amountIn: bigint,
    tokenOut: string,
    slippageBpsOverride?: number,
  ): TtlAmmQuoteLike;
  buildSwapCall(
    quote: TtlAmmQuoteLike,
    tokenIn: string,
    amountIn: bigint,
    recipient: string,
    deadline: bigint,
  ): TtlAmmSwapCallLike;
  buildApproveCall(token: string, amount: bigint): TtlAmmSwapCallLike;
}

// ────────── 상수 ──────────

/** 지갑 기본 슬리피지 보호 — 0.5% (EXCHANGE.md §8). */
const SLIPPAGE_BPS = 50;
/** 홉당 스왑 수수료 표시용 — exchange/types.ts 의 TTL_AMM_FEE_BPS 와 같은 값. */
const FEE_BPS = 33;
/** 이 화면은 TTL 체인 전용이다 — native 는 항상 TTL 18 decimals. */
const TTL_CHAIN_KEY = 'evm:ttl';
const TTL_SYMBOL = 'TTL';
const TTL_DECIMALS = 18;

// ────────── props ──────────

export interface ExchangePaneProps {
  /** E-4 클라이언트. null = 아직 배포/주입 전 — 화면이 그 사실을 그대로 그린다. */
  client: TtlAmmClientLike | null;
  /** 스왑 후보 토큰 (상위의 sendTokens 그대로). null = 아직 조회 전. */
  tokens: readonly PortableTokenBalance[] | null;
  /** native TTL 잔액 (wei). 모르면 null — 잔액 초과 검사를 건너뛴다. */
  nativeBalance: bigint | null;
  /** 서명·브로드캐스트용 활성 체인 어댑터. */
  adapter: ChainAdapter;
  /** 'evm:ttl' 일 때만 활성. 다른 체인이면 안내만 그린다. */
  chainKey: string;
  onBack: () => void;
}

// ────────── 경로 탐색 (순수) ──────────

/** 경로 판정 결과 — 화면이 실패 사유를 구분해 그릴 수 있게 종류를 나눈다. */
type RouteFind =
  | { kind: 'ready'; route: readonly TtlAmmPoolLike[]; hops: 1 | 2 }
  | { kind: 'no-pool'; symbol: string }
  | { kind: 'empty-reserves'; symbol: string };

/** 토큰 주소 → 그 토큰의 TTL 풀. 여러 개면 TTL 준비금이 가장 깊은 풀. */
function hopPool(
  pools: readonly TtlAmmPoolLike[],
  tokenAddr: string,
): TtlAmmPoolLike | null {
  const matches = pools.filter(
    (p) => p.token.toLowerCase() === tokenAddr.toLowerCase(),
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, p) => (p.reserveTtl > best.reserveTtl ? p : best));
}

/**
 * (tokenIn, tokenOut) → 경로. 허브 구조(EXCHANGE.md §4)라 판단이 단순하다:
 * 한쪽이 TTL 이면 그 토큰의 풀 하나(직접 1홉), 둘 다 토큰이면 각자의 풀을
 * 이어 2홉이다. 풀이 없으면 no-pool, 있어도 준비금이 0 이면 empty-reserves —
 * "시딩 전" 과 "풀 자체가 없음" 은 다른 사실이므로 구분한다.
 */
function findRoute(
  pools: readonly TtlAmmPoolLike[],
  tokenIn: string | null,
  tokenOut: string | null,
  symbolIn: string,
  symbolOut: string,
): RouteFind {
  // 홉 후보를 (토큰 주소, 심볼) 순서대로 모은다. 둘 다 null(TTL↔TTL)은
  // 호출 전에 same-asset 검사로 막힌다.
  const hops: Array<{ addr: string; symbol: string }> = [];
  if (tokenIn !== null) hops.push({ addr: tokenIn, symbol: symbolIn });
  if (tokenOut !== null) hops.push({ addr: tokenOut, symbol: symbolOut });

  const route: TtlAmmPoolLike[] = [];
  for (const hop of hops) {
    const p = hopPool(pools, hop.addr);
    if (p === null) return { kind: 'no-pool', symbol: hop.symbol };
    if (p.reserveTtl === 0n || p.reserveToken === 0n) {
      return { kind: 'empty-reserves', symbol: hop.symbol };
    }
    route.push(p);
  }
  // tokenIn 이 null(TTL→토큰)이면 hops 는 [out] 하나 — 1홉.
  // tokenOut 이 null(토큰→TTL)이면 [in] 하나 — 1홉. 둘 다 토큰이면 [in, out] 2홉.
  return { kind: 'ready', route, hops: route.length === 2 ? 2 : 1 };
}

// ────────── 창세 가격 대비 괴리 (순수) ──────────

/**
 * 견적의 실효 가격이 창세 가격(벼린 환율)에서 몇 % 벗어났는가.
 *
 * perTtl 은 "1 TTL = perTtl 단위의 그 토큰" 이므로 창세 교차 가격은
 * perTtl(out) / perTtl(in) (TTL 자신은 1). 환율이 없는 자산이 끼면 null —
 * 지어내지 않고 그 줄을 생략한다. Number 변환은 표시용 근사로 충분하다.
 */
function genesisDeviationPct(
  tokenIn: string | null,
  tokenOut: string | null,
  amountIn: bigint,
  amountOutEst: bigint,
  decimalsIn: number,
  decimalsOut: number,
): number | null {
  const perIn = tokenIn === null ? 1 : (rateByAddress(tokenIn)?.perTtl ?? null);
  const perOut = tokenOut === null ? 1 : (rateByAddress(tokenOut)?.perTtl ?? null);
  if (perIn === null || perOut === null || !(perIn > 0) || !(perOut > 0)) return null;
  const genesis = perOut / perIn;
  const inUnits = Number(amountIn) / 10 ** decimalsIn;
  const outUnits = Number(amountOutEst) / 10 ** decimalsOut;
  if (!(inUnits > 0) || !Number.isFinite(outUnits)) return null;
  const market = outUnits / inUnits;
  if (!Number.isFinite(market) || !(genesis > 0)) return null;
  return (market / genesis - 1) * 100;
}

// ────────── 자산 해석 (순수) ──────────

/**
 * 선택 키('native' | 토큰 id) → SelectedAsset. SendPane 의 selectAsset 과 같은
 * 규칙: 목록에서 사라진 키는 native 로 되돌린다 — "정체를 모르는 자산으로 스왑"
 * 상태를 만들지 않기 위해서다.
 */
function resolvePaneAsset(
  key: string,
  nativeBalance: bigint | null,
  tokens: readonly PortableTokenBalance[],
): SelectedAsset {
  if (key !== 'native') {
    const hit = tokens.find((tok) => tok.id.toLowerCase() === key.toLowerCase());
    if (hit) {
      return {
        kind: 'erc20',
        symbol: hit.symbol,
        decimals: hit.decimals,
        address: hit.id,
        balance: hit.balance,
      };
    }
  }
  return {
    kind: 'native',
    symbol: TTL_SYMBOL,
    decimals: TTL_DECIMALS,
    address: null,
    balance: nativeBalance,
  };
}

// ────────── 화면 ──────────

export function ExchangePane({
  client,
  tokens,
  nativeBalance,
  adapter,
  chainKey,
  onBack,
}: ExchangePaneProps) {
  const t = useT();
  type Step = 'compose' | 'review';
  type TxStatus =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'sent'; hash: string }
    | { kind: 'error'; message: string };
  type QuoteState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; quote: TtlAmmQuoteLike }
    | { kind: 'error'; message: string };

  const [step, setStep] = useState<Step>('compose');
  const [fromKey, setFromKey] = useState<string>('native');
  // null = 아직 사용자가 고르지 않음 → 첫 토큰(없으면 native)을 기본값으로.
  const [toKey, setToKey] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [pools, setPools] = useState<readonly TtlAmmPoolLike[] | null>(null);
  const [poolErr, setPoolErr] = useState<string | null>(null);
  const [quoteState, setQuoteState] = useState<QuoteState>({ kind: 'idle' });
  // 2단계 확정 — approve 와 swap 의 상태를 따로 정직하게 추적한다.
  const [approveStatus, setApproveStatus] = useState<TxStatus>({ kind: 'idle' });
  const [swapStatus, setSwapStatus] = useState<TxStatus>({ kind: 'idle' });

  const isTtl = chainKey === TTL_CHAIN_KEY;
  const tokenOptions: readonly PortableTokenBalance[] = tokens ?? [];
  const effectiveToKey: string = toKey ?? tokenOptions[0]?.id ?? 'native';

  // 풀 1회 조회 — 자산 쌍 변경마다 fetch 하지 않고 메모리에서 매칭 (ZION 과 동일).
  useEffect(() => {
    if (!isTtl || client === null || tokens === null) return;
    let cancelled = false;
    setPools(null);
    setPoolErr(null);
    client
      // 어느 토큰의 풀을 물을지는 화면이 안다 — 자동 발견된 66종의 id 를 넘긴다.
      .listPools(tokens.map((tk) => tk.id))
      .then((ps) => {
        if (cancelled) return;
        setPools(ps);
        setPoolErr(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPools([]);
        setPoolErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, isTtl, tokens]);

  // 선택 자산 — 심볼/decimals/잔액이 여기서 하나로 확정된다.
  const fromAsset = useMemo(
    () => resolvePaneAsset(fromKey, nativeBalance, tokenOptions),
    [fromKey, nativeBalance, tokenOptions],
  );
  const toAsset = useMemo(
    () => resolvePaneAsset(effectiveToKey, nativeBalance, tokenOptions),
    [effectiveToKey, nativeBalance, tokenOptions],
  );

  // 같은 자산 선택 방지 — 주소는 대소문자 무시 비교 (EVM 체크섬 흡수).
  const sameAsset =
    (fromAsset.address ?? 'native').toLowerCase() ===
    (toAsset.address ?? 'native').toLowerCase();

  const tokenIn = fromAsset.address;
  const tokenOut = toAsset.address;

  // 수량 파싱 — SendPane 과 같은 규칙(형식/자릿수/잔액 초과)을 재사용한다.
  const trimmedAmount = amount.trim();
  const parsed = useMemo(
    () => parseAssetAmount(trimmedAmount, fromAsset),
    [trimmedAmount, fromAsset],
  );
  const amountValue: bigint | null = parsed.ok ? parsed.value : null;
  const amountError =
    trimmedAmount.length > 0 && !parsed.ok
      ? parsed.reason === 'insufficient'
        ? t('send.amount_exceeds_balance', {
            balance: formatAssetAmount(fromAsset.balance, fromAsset.decimals),
            symbol: fromAsset.symbol,
          })
        : parsed.reason === 'decimals'
          ? t('send.amount_decimals_exceeded', {
              symbol: fromAsset.symbol,
              decimals: fromAsset.decimals,
            })
          : t('swap.amount_invalid')
      : null;

  // 경로 판정 — 풀 목록이 오기 전(null)엔 판정하지 않는다.
  const routeFind: RouteFind | null = useMemo(() => {
    if (pools === null || sameAsset) return null;
    return findRoute(pools, tokenIn, tokenOut, fromAsset.symbol, toAsset.symbol);
  }, [pools, sameAsset, tokenIn, tokenOut, fromAsset.symbol, toAsset.symbol]);

  // 견적 — 경로·수량·클라이언트가 전부 준비된 경우에만. sync 예외와 async
  // 거절을 같은 error 상태로 수렴시킨다 (지어내지 않고 사유를 그대로 보인다).
  useEffect(() => {
    if (
      client === null ||
      routeFind === null ||
      routeFind.kind !== 'ready' ||
      amountValue === null
    ) {
      setQuoteState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setQuoteState({ kind: 'pending' });
    try {
      Promise.resolve(
        client.quote(
          pools ?? [],
          tokenIn ?? TTL_AMM_NATIVE,
          amountValue,
          tokenOut ?? TTL_AMM_NATIVE,
          SLIPPAGE_BPS,
        ),
      )
        .then((q) => {
          if (!cancelled) setQuoteState({ kind: 'ok', quote: q });
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setQuoteState({
              kind: 'error',
              message: e instanceof Error ? e.message : String(e),
            });
          }
        });
    } catch (e) {
      setQuoteState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
    return () => {
      cancelled = true;
    };
  }, [client, routeFind, amountValue, tokenIn, tokenOut]);

  // 창세 가격 대비 괴리 — 정보이지 경고가 아니다. 환율이 없으면 null(생략).
  const deviationPct: number | null = useMemo(() => {
    if (quoteState.kind !== 'ok' || amountValue === null) return null;
    return genesisDeviationPct(
      tokenIn,
      tokenOut,
      amountValue,
      quoteState.quote.amountOutEst,
      fromAsset.decimals,
      toAsset.decimals,
    );
  }, [quoteState, amountValue, tokenIn, tokenOut, fromAsset.decimals, toAsset.decimals]);

  // ERC-20 입력이면 approve 가 먼저다. native TTL 입력은 승인이 필요 없다.
  const needsApprove = tokenIn !== null;
  const locked =
    approveStatus.kind === 'pending' ||
    swapStatus.kind === 'pending' ||
    swapStatus.kind === 'sent';
  const quoteReady = quoteState.kind === 'ok';
  const canProceed = !sameAsset && quoteReady && amountValue !== null && !locked;

  /** compose 로 되돌아갈 때 서명 상태를 초기화한다 — 이미 보낸 tx 는 체인에 남는다. */
  function backToCompose(): void {
    setStep('compose');
    setApproveStatus({ kind: 'idle' });
    setSwapStatus({ kind: 'idle' });
  }

  /** call → TransferIntent. 기존 서명·브로드캐스트 경로(walletStore.transfer)를 그대로 탄다. */
  function toIntent(call: TtlAmmSwapCallLike): TransferIntent {
    return { to: call.to, amount: call.value, data: call.data };
  }

  async function performApprove(): Promise<void> {
    if (client === null || tokenIn === null || amountValue === null) return;
    setApproveStatus({ kind: 'pending' });
    try {
      const call = await client.buildApproveCall(tokenIn, amountValue);
      const hash = await walletStore.transfer(toIntent(call), adapter);
      setApproveStatus({ kind: 'sent', hash });
    } catch (err) {
      setApproveStatus({ kind: 'error', message: errorText(err) });
    }
  }

  async function performSwap(): Promise<void> {
    if (client === null || quoteState.kind !== 'ok' || amountValue === null) return;
    setSwapStatus({ kind: 'pending' });
    try {
      // 활성 계정의 TTL 주소 — 수령 주소(recipient)로 쓴다.
      const accounts = walletStore.listAccounts();
      const activeIdx = accounts.findIndex((a) => a.active);
      if (activeIdx < 0) {
        throw new ShellError('account.not_found', 'no active account');
      }
      const acc = walletStore.getAccountAt(activeIdx, adapter);
      // 견적-체결 사이가 벌어지면 오래된 가격으로 체결되는 것을 막는다 — 20분.
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
      const call = await client.buildSwapCall(
        quoteState.quote,
        tokenIn ?? TTL_AMM_NATIVE,
        amountValue,
        acc.address,
        deadline,
      );
      const hash = await walletStore.transfer(toIntent(call), adapter);
      setSwapStatus({ kind: 'sent', hash });
    } catch (err) {
      setSwapStatus({ kind: 'error', message: errorText(err) });
    }
  }

  function errorText(err: unknown): string {
    if (err instanceof ShellError) return t(`errors.${err.code}`);
    if (err instanceof Error) return err.message || t('swap.failed');
    return t('swap.failed');
  }

  // ── 견적 요약 (compose/review 공용) ──
  function quoteSummary(): ReactElement | null {
    if (routeFind === null || routeFind.kind !== 'ready' || quoteState.kind !== 'ok') {
      return null;
    }
    const q = quoteState.quote;
    return (
      <div className="swap-summary">
        <div className="muted small">
          {t('exchange.route_label')}:{' '}
          {routeFind.hops === 1
            ? t('exchange.route_direct', {
                symbol: tokenIn === null ? toAsset.symbol : fromAsset.symbol,
              })
            : t('exchange.route_two_hop', {
                from: fromAsset.symbol,
                to: toAsset.symbol,
              })}
        </div>
        <div className="small">
          {t('swap.estimate_label')}: ≈{' '}
          {formatAssetAmount(q.amountOutEst, toAsset.decimals)} {toAsset.symbol}
        </div>
        <div className="small">
          {t('swap.min_label')}: ≥{' '}
          {formatAssetAmount(q.minAmountOut, toAsset.decimals)} {toAsset.symbol}
        </div>
        <div className="muted small">
          {t('swap.fee_label')}:{' '}
          {t('exchange.fee_hops', {
            // feeEst 는 **출력 토큰 단위**다 (types.ts) — 받는 자산 자릿수로 표시한다.
            fee: formatAssetAmount(q.feeEst, toAsset.decimals),
            symbol: fromAsset.symbol,
            bps: (FEE_BPS / 100).toFixed(2),
            hops: routeFind.hops,
          })}
        </div>
        {deviationPct !== null && (
          <div className="muted small">
            {t('exchange.genesis_line', {
              pct: `${deviationPct >= 0 ? '+' : ''}${deviationPct.toFixed(2)}%`,
            })}{' '}
            — {t('exchange.genesis_note')}
          </div>
        )}
      </div>
    );
  }

  // ── 가드 1: TTL 체인이 아니면 사실대로 안내 ──
  if (!isTtl) {
    return (
      <section className="card">
        <h2 className="create-step__title">{t('exchange.title')}</h2>
        <p className="warn">{t('exchange.ttl_only')}</p>
        <button className="btn-ghost" onClick={onBack}>
          {t('common.back')}
        </button>
      </section>
    );
  }

  // ── 가드 2: 클라이언트 미주입 = 거래소 미배포. 성공한 척하지 않는다 ──
  if (client === null) {
    return (
      <section className="card">
        <h2 className="create-step__title">{t('exchange.title')}</h2>
        <p className="warn">{t('exchange.not_deployed')}</p>
        <button className="btn-ghost" onClick={onBack}>
          {t('common.back')}
        </button>
      </section>
    );
  }

  // ── review 단계 ──
  if (step === 'review') {
    const q = quoteState.kind === 'ok' ? quoteState.quote : null;
    return (
      <section className="card">
        <h2 className="create-step__title">{t('exchange.review_title')}</h2>
        <p className="create-step__lead">
          {t('exchange.review_summary', {
            amountIn: trimmedAmount,
            from: fromAsset.symbol,
            amountOut: q ? formatAssetAmount(q.amountOutEst, toAsset.decimals) : '—',
            to: toAsset.symbol,
          })}
        </p>

        {quoteSummary()}

        <p className="warn small" style={{ margin: 0 }}>
          {t('send.review_irreversible')}
        </p>

        {/* 1단계: approve — ERC-20 입력일 때만. 2단계임을 숨기지 않는다. */}
        {needsApprove && (
          <>
            <p className="muted small">
              {t('exchange.two_step_note', { symbol: fromAsset.symbol })}
            </p>
            {approveStatus.kind === 'pending' && (
              <p className="muted small">{t('exchange.approve_pending')}</p>
            )}
            {approveStatus.kind === 'sent' && (
              <div className="send-sent">
                <p className="label">{t('exchange.approve_sent')}</p>
                <p className="addr send-hash" title={approveStatus.hash}>
                  {shorten(approveStatus.hash)}
                </p>
                <p className="muted small">{t('exchange.approve_wait_note')}</p>
              </div>
            )}
            {approveStatus.kind === 'error' && (
              <p className="error">{approveStatus.message}</p>
            )}
            {approveStatus.kind !== 'sent' && (
              /* canProceed 가 이미 !locked 를 포함하므로(pending 포함) 이것으로 충분하다. */
              <button
                className="btn-primary"
                disabled={!canProceed}
                onClick={() => {
                  void performApprove();
                }}
              >
                {approveStatus.kind === 'pending'
                  ? t('exchange.approve_pending')
                  : t('exchange.approve_button', { symbol: fromAsset.symbol })}
              </button>
            )}
          </>
        )}

        {/* 2단계(또는 native 입력의 유일한 단계): swap */}
        {swapStatus.kind === 'pending' && (
          <p className="muted small">{t('swap.pending')}</p>
        )}
        {swapStatus.kind === 'sent' && (
          <div className="send-sent">
            <p className="label">{t('swap.sent_title')}</p>
            <p className="addr send-hash" title={swapStatus.hash}>
              {shorten(swapStatus.hash)}
            </p>
            <a
              href={`https://scan.ttl1.top/tx/${swapStatus.hash}`}
              target="_blank"
              rel="noreferrer"
              className="small"
            >
              {t('send.view_in_explorer')}
            </a>
          </div>
        )}
        {swapStatus.kind === 'error' && <p className="error">{swapStatus.message}</p>}

        {swapStatus.kind === 'sent' ? (
          <button className="btn-primary" onClick={onBack}>
            {t('send.back_to_wallet')}
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={
              !quoteReady ||
              swapStatus.kind === 'pending' ||
              (needsApprove && approveStatus.kind !== 'sent')
            }
            onClick={() => {
              void performSwap();
            }}
          >
            {swapStatus.kind === 'pending'
              ? t('swap.pending')
              : needsApprove
                ? t('exchange.swap_button')
                : t('swap.confirm')}
          </button>
        )}
        <button className="btn-ghost" onClick={backToCompose} disabled={locked}>
          {t('send.review_edit')}
        </button>
      </section>
    );
  }

  // ── compose 단계 ──
  return (
    <section className="card">
      <h2 className="create-step__title">{t('exchange.title')}</h2>
      <p className="create-step__lead">{t('exchange.lead')}</p>

      {pools === null && poolErr === null && (
        <p className="muted small">{t('swap.loading_pool')}</p>
      )}
      {poolErr !== null && (
        <p className="error small" role="alert">
          {t('swap.pool_load_failed', { reason: poolErr })}
        </p>
      )}
      {tokens === null && <p className="muted small">{t('exchange.tokens_loading')}</p>}

      {/* 보낼 자산 */}
      <label className="label" htmlFor="exchange-from">
        {t('swap.from_label')}
      </label>
      <select
        id="exchange-from"
        className="chain-select"
        value={fromKey}
        onChange={(e) => setFromKey(e.target.value)}
        disabled={locked}
      >
        <option value="native">
          {t('send.asset_native_option_symbol', { symbol: TTL_SYMBOL })}
        </option>
        {tokenOptions.map((tok) => (
          <option key={tok.id} value={tok.id}>
            {tok.symbol} · {formatAssetAmount(tok.balance, tok.decimals)}
          </option>
        ))}
      </select>
      {fromAsset.balance !== null && (
        <p className="muted small send-asset__balance">
          {t('send.available_balance', {
            amount: formatAssetAmount(fromAsset.balance, fromAsset.decimals),
            symbol: fromAsset.symbol,
          })}
        </p>
      )}

      {/* 받을 자산 */}
      <label className="label" htmlFor="exchange-to">
        {t('swap.to_label')}
      </label>
      <select
        id="exchange-to"
        className="chain-select"
        value={effectiveToKey}
        onChange={(e) => setToKey(e.target.value)}
        disabled={locked}
      >
        <option value="native">
          {t('send.asset_native_option_symbol', { symbol: TTL_SYMBOL })}
        </option>
        {tokenOptions.map((tok) => (
          <option key={tok.id} value={tok.id}>
            {tok.symbol}
          </option>
        ))}
      </select>

      {sameAsset && <p className="error small">{t('swap.same_denom')}</p>}

      {/* 수량 */}
      <label className="label" htmlFor="exchange-amount">
        {t('swap.amount_label', { symbol: fromAsset.symbol })}
      </label>
      <input
        id="exchange-amount"
        type="text"
        inputMode="decimal"
        className="verify-row__input"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.0"
        disabled={locked}
      />
      {amountError !== null && <p className="error small">{amountError}</p>}

      {/* 실패 정직성 — 풀 없음 / 준비금 0 / 견적 실패를 구분해 그린다. */}
      {routeFind !== null && routeFind.kind === 'no-pool' && (
        <p className="error small">
          {t('exchange.no_pool_for', { symbol: routeFind.symbol })}
        </p>
      )}
      {routeFind !== null && routeFind.kind === 'empty-reserves' && (
        <p className="error small">
          {t('exchange.empty_reserves', { symbol: routeFind.symbol })}
        </p>
      )}
      {quoteState.kind === 'error' && (
        <p className="error small">
          {t('exchange.quote_failed', { reason: quoteState.message })}
        </p>
      )}
      {quoteState.kind === 'pending' && (
        <p className="muted small">{t('exchange.quoting')}</p>
      )}

      {quoteSummary()}

      <button
        className="btn-primary"
        disabled={!canProceed}
        onClick={() => setStep('review')}
      >
        {t('send.next_step')}
      </button>
      <button className="btn-ghost" onClick={onBack}>
        {t('common.back')}
      </button>
    </section>
  );
}

/** SendPane 의 shorten 과 같은 규칙. App.tsx 를 건드리지 않으려 복제했다. */
function shorten(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
