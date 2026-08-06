// TokenListPane — 토큰 목록 전용 화면 (검색 · 보기/가리기 · 벼린 환율 가치).
//
// 확장 popup(apps/extension/entrypoints/popup/screens/TokenListPane.tsx)에서
// 그대로 이식했다. 다른 점은 저장 백엔드 하나뿐이다 — 확장은 ChromeLocalBackend,
// 안드로이드 WebView 는 LocalStorageBackend. 둘 다 shell-core 가 같은 Promise
// 표면으로 내주므로 `loadHidden`/`saveHidden` 호출부는 글자 하나 안 바뀐다.
//
// **모든 체인에서 같은 화면이다.** 예전에는 `chainKey.startsWith('evm:')` 로
// 화면 전체를 막았지만 이제는 막지 않는다. 토큰은 체인 무관 형식
// (`PortableTokenBalance`)으로 들어오고, 어댑터가 토큰을 모르는 체인이면 상위가
// `supported={false}` 를 내려 "지원하지 않음" 한 줄만 그린다 — 화면에 **도달은
// 한다.** 도달조차 못 하면 사용자는 지갑이 고장난 것인지 그 체인이 원래 토큰을
// 안 다루는 것인지 구분할 수 없다.
//
// TTL 체인에 통화 스테이블이 66 종 발행돼 있고 지갑이 그걸 자동 감지한다.
// 활성 계정 카드의 간단한 목록은 "지금 뭘 갖고 있나" 를 훑는 용도라 66 줄을
// 감당하지 못한다. 그래서 훑기와 다루기를 화면으로 분리했다 — 카드는 그대로
// 두고, 검색·가리기·환율 근거는 전부 이쪽에 둔다.
//
// 조회하지 않는다. tokens 는 상위(App)가 이미 RPC 로 받아 둔 값을 props 로
// 받는다. 같은 balanceOf 를 화면 전환마다 66 번씩 다시 쏘지 않기 위해서다.
//
// 판단(필터·정렬·검색·가리기 상태)은 전부 `lib/token-visibility.ts` 에 있다.
// 이 파일은 그 결과를 그리기만 한다 — 그래야 규칙을 jsdom 없이 테스트할 수 있다.
//
// 값은 재구현하지 않는다. wallet-sdk 의 `assetValueInTtl` 이 유일한 출처다 —
// 이 화면은 그 결과의 `basis`·`volatile`·`reason` 을 표기로 옮기기만 한다.
//
// **고정 액면과 시세 기준을 구분해 적는다.** 둘 다 "≈ N TTL" 로만 적으면 시세
// 따라 출렁이는 줄이 "TTL 이 BTC 를 따라간다" 로 읽히고, 그건 방금 지운 옛
// 페그와 화면상 구별이 안 된다. 그래서 배지 텍스트(아이콘 아님 — 좁은 화면과
// 고대비 모드에서 아이콘·색은 사라진다)와 마커 문자를 붙인다.
//
// 용어 주의: 1 TTL = 노동자 1일 품삯이고, perTtl 은 "1 TTL 이 그 통화로 얼마인가"
// 다. 시장환율이 아니다. tUSD 는 실제 달러가 아니다. 화면 문구에서 이 둘을
// 섞지 않는다 — 하단 고지가 그 경계를 명시한다.

import { useEffect, useMemo, useState } from 'react';
import { LocalStorageBackend } from '@byeorin/shell-core';
import { rateSnapshot, type PriceTable } from '@byeorin/wallet-sdk/evm';
import { useT } from '@byeorin/i18n/react';
import { formatAssetAmount } from '../lib/token-send.js';
import {
  EMPTY_HIDDEN,
  buildTokenRows,
  formatBigNumber,
  formatPerTtl,
  formatTtl,
  loadHidden,
  saveHidden,
  selectTokenView,
  withHidden,
  type HiddenMap,
  type PortableTokenBalance,
  type TokenRow,
} from '../lib/token-visibility.js';

export interface TokenListPaneProps {
  /**
   * 상위가 이미 조회한 토큰 잔액 (`discoverPortableTokens` 의 결과 그대로).
   * `null` = 아직 조회 중(로딩 3상태의 하나). 이 화면은 절대 직접 조회하지 않는다.
   */
  tokens: PortableTokenBalance[] | null;
  /** 활성 체인 키. 가리기 상태를 체인별로 저장하는 데 쓴다. */
  chainKey: string;
  /**
   * EVM chainId (EVM 이 아니면 null). 스테이블 액면은 chainId 스코프로만
   * 판정되므로, 넘기지 않으면 EVM 스테이블이 액면을 못 얻어 값이 통째로 빈다.
   */
  chainId?: number | null;
  /**
   * Binance ticker 표. 상장자산 행의 TTL 값이 여기서만 온다.
   * 상위가 시세를 못 받았으면 `null` — 그 행은 "시세 없음" 으로 사유를 밝힌다.
   */
  prices: PriceTable | null;
  /**
   * 이 체인의 어댑터가 토큰을 다룰 수 있는가 — 상위가 wallet-sdk 의
   * `supportsTokens(adapter)` 를 그대로 넘긴다.
   *
   * 빈 배열만으로는 "보유 토큰이 없다" 와 "이 체인은 토큰을 모른다" 를 구분할 수
   * 없어서 따로 받는다. 넘기지 않으면(undefined) 지원하는 것으로 보고 평소 흐름을
   * 탄다 — 기존 호출부가 그대로 동작하게 하기 위해서다.
   */
  supported?: boolean;
  /** 상위의 조회 실패 사유. 있으면 에러 상태로 그린다. */
  error?: string | null;
  /** 있으면 새로고침 버튼을 그린다. 재조회는 상위 책임. */
  onRefresh?: () => void;
  onBack?: () => void;
}

export function TokenListPane({
  tokens,
  chainKey,
  chainId = null,
  prices,
  supported = true,
  error = null,
  onRefresh,
  onBack,
}: TokenListPaneProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  // 펼쳐 놓은 행의 key(소문자 주소). 한 번에 하나만 — 여러 개가 펼쳐지면 목록의
  // 형태를 잃는다.
  const [expanded, setExpanded] = useState<string | null>(null);

  // 가리기 상태 — localStorage. shell-core 의 백엔드를 그대로 재사용한다
  // (주소록/금고와 같은 저장 계층).
  const backend = useMemo(() => new LocalStorageBackend(), []);
  const [hidden, setHidden] = useState<HiddenMap>(EMPTY_HIDDEN);

  useEffect(() => {
    let cancelled = false;
    void loadHidden(backend).then((map) => {
      if (!cancelled) setHidden(map);
    });
    return () => {
      cancelled = true;
    };
  }, [backend]);

  const rows = useMemo<TokenRow[]>(
    () => (tokens ? buildTokenRows(tokens, hidden, chainKey, chainId, prices) : []),
    [tokens, hidden, chainKey, chainId, prices],
  );

  // 어느 앵커의 값인지. 화면에 TTL 값을 보이면서 기준 날짜를 감추면, 재앵커 후
  // 옛 화면과 새 화면이 같은 얼굴로 다른 수를 말한다. 값은 스냅샷에서 읽는다 —
  // 날짜를 코드에 적지 않는다.
  const anchoredAt = rateSnapshot().anchoredAt;

  const view = useMemo(
    () => selectTokenView(rows, { query, showHidden }),
    [rows, query, showHidden],
  );

  // 저장 실패(스토리지 가득참 등)해도 화면은 메모리 상태로 계속 동작한다.
  // saveHidden 이 false 를 돌려주면 그 사실만 알린다 — 조작 자체를 막지는 않는다.
  const [persistFailed, setPersistFailed] = useState(false);

  function toggleHidden(row: TokenRow): void {
    const next = withHidden(hidden, chainKey, row.id, !row.hidden);
    setHidden(next);
    void saveHidden(backend, next).then((ok) => {
      if (!ok) setPersistFailed(true);
    });
  }

  return (
    <section className="card">
      <h2 className="create-step__title">{t('tokens.title')}</h2>
      <p className="create-step__lead">{t('tokens.lead')}</p>

      {/* 체인이 토큰을 모르는 경우. 화면은 열리고, 이유만 말한다. */}
      {!supported ? (
        <p className="empty-state">{t('tokens.unsupported')}</p>
      ) : error ? (
        <p className="error" role="alert">
          {t('tokens.error', { reason: error })}
        </p>
      ) : tokens === null ? (
        <p className="muted small">{t('tokens.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="empty-state">{t('tokens.empty')}</p>
      ) : (
        <>
          {/* 검색 — 66 종에서는 이게 없으면 목록을 쓸 수 없다. */}
          <label className="label" htmlFor="token-search">
            {t('tokens.search_label')}
          </label>
          <input
            id="token-search"
            type="search"
            className="verify-row__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('tokens.search_placeholder')}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
          />

          {/* 보임 ↔ 가림 전환. 가린 항목은 사라지는 게 아니라 이쪽 탭으로 간다. */}
          <div className="token-list__tabs">
            <button
              type="button"
              className={
                showHidden ? 'token-list__tab' : 'token-list__tab token-list__tab--on'
              }
              aria-pressed={!showHidden}
              onClick={() => setShowHidden(false)}
            >
              {t('tokens.tab_visible', { n: view.visibleCount })}
            </button>
            <button
              type="button"
              className={
                showHidden ? 'token-list__tab token-list__tab--on' : 'token-list__tab'
              }
              aria-pressed={showHidden}
              onClick={() => setShowHidden(true)}
            >
              {t('tokens.tab_hidden', { n: view.hiddenCount })}
            </button>
            {onRefresh && (
              <button type="button" className="zion-assets__toggle" onClick={onRefresh}>
                {t('common.refresh')}
              </button>
            )}
          </div>

          {view.rows.length === 0 ? (
            // "검색 결과 없음" 과 "이 탭이 비었음" 은 다른 사건이다. 사용자가
            // 검색어를 지워야 하는지, 아무것도 안 가렸는지 구분되어야 한다.
            <p className="empty-state">
              {query.trim()
                ? t('tokens.search_empty', { query: query.trim() })
                : showHidden
                  ? t('tokens.hidden_empty')
                  : t('tokens.visible_empty')}
            </p>
          ) : (
            <ul className="token-list">
              {view.rows.map((row) => (
                <TokenRowItem
                  key={row.key}
                  row={row}
                  expanded={expanded === row.key}
                  onToggleExpand={() =>
                    setExpanded((cur) => (cur === row.key ? null : row.key))
                  }
                  onToggleHidden={() => toggleHidden(row)}
                  anchoredAt={anchoredAt}
                  t={t}
                />
              ))}
            </ul>
          )}

          {persistFailed && (
            <p className="warn small">{t('tokens.persist_failed')}</p>
          )}
          <p className="muted small">{t('tokens.hidden_note')}</p>
          {/* 이 화면의 TTL 값이 전부 어느 앵커 기준인지 한 번만 고지한다.
              줄마다 붙이면 66 줄이 두 배가 된다 — 행 단위 근거는 펼침 패널에. */}
          <p className="muted small">{t('tokens.anchor_line', { date: anchoredAt })}</p>
          {/* 통화토큰과 실제 통화를 섞지 않게 하는 고지. 지워서는 안 된다. */}
          <p className="muted small">{t('tokens.disclaimer')}</p>
        </>
      )}

      {onBack && (
        <button className="btn-ghost" onClick={onBack}>
          {t('common.back')}
        </button>
      )}
    </section>
  );
}

// ────────── 목록 한 줄 ──────────

function TokenRowItem({
  row,
  expanded,
  onToggleExpand,
  onToggleHidden,
  anchoredAt,
  t,
}: {
  row: TokenRow;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleHidden: () => void;
  anchoredAt: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const held = row.balance > 0n;
  const panelId = `token-basis-${row.key}`;
  const v = row.value;
  // 값을 못 낸 사유 → 문구 키. 뭉뚱그리지 않는다: 신원을 모르는 것, 시세가 없는
  // 것, 환율표에 그 통화가 없는 것, 자릿수가 이상한 것은 서로 다른 사실이다.
  const reasonKey =
    v.reason === 'unverified'
      ? 'tokens.value_unverified'
      : v.reason === 'unlisted'
        ? 'tokens.value_unlisted'
        : v.reason === 'bad-decimals'
          ? 'tokens.value_bad_decimals'
          : 'tokens.value_no_face_rate';

  return (
    <li className={row.hidden ? 'token-row token-row--hidden' : 'token-row'}>
      <div className="token-row__head">
        <span className="token-row__ident">
          <span className="token-row__symbol" title={row.name}>
            {row.symbol}
          </span>
          {/* 국가명은 66 종을 구분하는 가장 빠른 단서다. 없으면 자리를 비운다. */}
          {row.meta.country && (
            <span className="token-row__country small muted">{row.meta.country}</span>
          )}
        </span>
        <span className="token-row__amounts">
          <span
            className={
              held ? 'token-row__balance' : 'token-row__balance token-row__balance--zero'
            }
          >
            {formatAssetAmount(row.balance, row.decimals)}
          </span>
          {/* 값을 못 내면 가치 자리를 **비우되 사유를 적는다**. 0 이나 추정치를
              넣으면 "값이 없는 토큰" 과 "값을 모르는 토큰" 이 구분되지 않는다.
              시세 기준(volatile)은 다른 문구·다른 배지로 적는다 — 고정 액면과
              같은 얼굴로 그리면 출렁임이 TTL 의 성질로 읽힌다. */}
          {row.ttl !== null ? (
            <span
              className={
                v.volatile ? 'token-row__ttl token-row__ttl--market' : 'token-row__ttl'
              }
            >
              {v.volatile
                ? t('tokens.value_ttl_market', { v: formatTtl(row.ttl) })
                : t('tokens.value_ttl', { v: formatTtl(row.ttl) })}
              <span
                className={
                  v.volatile
                    ? 'value-badge value-badge--market'
                    : 'value-badge value-badge--fixed'
                }
                title={
                  v.volatile
                    ? t('tokens.basis_market_hint')
                    : t('tokens.basis_fixed_hint')
                }
              >
                {v.volatile ? t('tokens.basis_market') : t('tokens.basis_fixed')}
              </span>
            </span>
          ) : (
            <span
              className="token-row__ttl token-row__ttl--none"
              title={
                v.reason === 'unverified' ? t('tokens.value_unverified_hint') : undefined
              }
            >
              {t(reasonKey)}
            </span>
          )}
        </span>
      </div>

      <div className="token-row__actions">
        <button
          type="button"
          className="zion-assets__toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggleExpand}
        >
          {expanded ? t('tokens.basis_hide') : t('tokens.basis_show')}
        </button>
        <button type="button" className="zion-assets__toggle" onClick={onToggleHidden}>
          {row.hidden ? t('tokens.unhide') : t('tokens.hide')}
        </button>
      </div>

      {/* 근거 — 숫자만 있고 근거가 없으면 믿으라는 말밖에 안 된다. */}
      {expanded && (
        <dl id={panelId} className="token-basis">
          {row.meta.rate ? (
            <>
              <div className="token-basis__row">
                <dt>{t('tokens.basis_per_ttl')}</dt>
                <dd>
                  1 TTL = {formatPerTtl(row.meta.rate.perTtl)} {row.meta.rate.iso}
                </dd>
              </div>
              <div className="token-basis__row">
                <dt>{t('tokens.basis_gdp', { year: row.meta.rate.inputs.gdpYear })}</dt>
                <dd>{formatBigNumber(row.meta.rate.inputs.gdpLocal)}</dd>
              </div>
              <div className="token-basis__row">
                <dt>
                  {t('tokens.basis_population', {
                    year: row.meta.rate.inputs.populationYear,
                  })}
                </dt>
                <dd>{formatBigNumber(row.meta.rate.inputs.population)}</dd>
              </div>
              <div className="token-basis__row">
                <dt>{t('tokens.basis_iso3')}</dt>
                <dd>{row.meta.rate.iso3}</dd>
              </div>
              {row.meta.rate.inputs.gdpSynthetic && (
                <div className="token-basis__row">
                  <dt>{t('tokens.basis_synthetic')}</dt>
                  <dd>{row.meta.rate.inputs.gdpSynthetic}</dd>
                </div>
              )}
              <p className="token-basis__formula muted small">
                {t('tokens.basis_formula')}
              </p>
            </>
          ) : (
            <p className="token-basis__formula warn small">
              {t('tokens.basis_unresolved', {
                reason: row.meta.unresolvedReason ?? t('tokens.basis_unknown_reason'),
              })}
            </p>
          )}
          {/* 시세 기준 행의 근거. "몇 USD 를 어느 페어로 얻었는가" 를 적는다 —
              이 줄이 없으면 출렁이는 TTL 값의 출처가 화면 어디에도 없다. */}
          {v.market && (
            <div className="token-basis__row">
              <dt>{t('tokens.basis_market')}</dt>
              <dd>
                {t('tokens.basis_market_unit', {
                  usd: formatPerTtl(v.market.unitUsd),
                  via: v.market.via,
                })}
              </dd>
            </div>
          )}
          {/* 어느 앵커의 값인가. 스냅샷을 다시 만들면 66 종이 전부 바뀐다 —
              날짜 없이 숫자만 보이면 그 사실을 확인할 방법이 없다. */}
          <div className="token-basis__row">
            <dt>{t('tokens.basis_anchored_at')}</dt>
            <dd>{anchoredAt}</dd>
          </div>
          {/* 잔액의 출처. 체인에서 직접 읽은 값과 인덱서가 말해준 값은 신뢰도가
              다르므로 숫자 옆이 아니라 근거 자리에 사실대로 적는다.
              (문구가 하드코딩인 이유: i18n 카탈로그는 이 작업의 소유 범위 밖이라
               `tokens.basis_source` / `tokens.basis_source_onchain` 키를 추가하지
               못했다. 키가 생기면 t() 로 바꾼다.) */}
          <div className="token-basis__row">
            <dt>잔액 출처</dt>
            <dd>{row.source ?? '체인에서 직접 읽음'}</dd>
          </div>
          <p className="token-basis__addr addr small muted" title={row.id}>
            {row.id}
          </p>
        </dl>
      )}
    </li>
  );
}
