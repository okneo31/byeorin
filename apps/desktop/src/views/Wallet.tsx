import { useCallback, useEffect, useState } from 'react';
import {
  Erc20,
  TokenRegistry,
  createMnemonic,
  NEW_MNEMONIC_STRENGTH,
  NEW_MNEMONIC_WORD_COUNT,
  discoverTokens,
  type DiscoveredBalance,
  type TokenInfo,
  type WalletAccount,
} from '@byeorin/wallet-sdk';
// 환산은 SDK 한 곳에서만 한다. 셸은 이 함수만 부른다 — v0.5.21 에 셸마다
// 짜서 4 벌이 어긋났다. 환율 숫자는 여기(그리고 어디에도) 적지 않는다:
// 값은 런타임에 rate-snapshot 에서 온다.
import {
  assetValueInTtl,
  sumTtl,
  rateSnapshot,
  type AssetValue,
} from '@byeorin/wallet-sdk/evm';
import {
  AddressDisplay,
  AmountDisplay,
  Button,
  Card,
} from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';
import { walletStore } from '../wallet-store.js';

// chainId 별 TokenRegistry — 사용자 커스텀이 즉시 반영되도록 모듈 단위 공유.
const sharedRegistry = new TokenRegistry();

interface Props {
  unlocked: boolean;
  onReady: () => void;
  onLock: () => void;
}

type Mode = 'idle' | 'create' | 'recover';

export function Wallet({ unlocked, onReady, onLock }: Props) {
  const t = useT();
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [draft, setDraft] = useState<string>('');
  const [input, setInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Triple-state balance: balance / balanceError / loadingBalance.
  // 빈 지갑(0n)과 네트워크 오류(null + balanceError)를 구분한다.
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState<boolean>(false);
  const [reloadKey, setReloadKey] = useState<number>(0);

  // 토큰 / 가격.
  const [tokens, setTokens] = useState<DiscoveredBalance[] | null>(null);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  // 계정 이름 — WalletAccount 에는 label 이 없어 listAccounts() 에서 따로 읽는다.
  // rawLabel 은 자동 이름이 아닌 원본(null 가능)이어야 편집 후에도 자동 이름 경로가 산다.
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [rawLabel, setRawLabel] = useState<string | null>(null);
  // null 이면 보기 모드, 문자열이면 편집 중(현재 입력값).
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);

  // 잠금 화면에서 부르면 빈 배열이므로 find 결과가 undefined 인 경로를 막는다.
  const syncActiveLabel = useCallback(() => {
    if (!walletStore.isUnlocked()) {
      setActiveIdx(null);
      setRawLabel(null);
      return;
    }
    const found = walletStore.listAccounts().find((a) => a.active);
    setActiveIdx(found ? found.idx : null);
    setRawLabel(found ? found.label : null);
  }, []);

  const refreshTokens = useCallback(async (acc: WalletAccount) => {
    setTokensLoading(true);
    setTokensError(null);
    try {
      const adapter = walletStore.getDefaultAdapter() as unknown as Parameters<
        typeof discoverTokens
      >[0];
      const found = await discoverTokens(adapter, sharedRegistry, acc.address);
      setTokens(found);
    } catch (e) {
      setTokensError(e instanceof Error ? e.message : t('tokens.lookup_failed'));
      setTokens([]);
    } finally {
      setTokensLoading(false);
    }
  }, [t]);

  // unlocked 상태 변화에 따라 account 를 비동기로 동기화.
  useEffect(() => {
    let cancelled = false;
    if (!unlocked || !walletStore.isUnlocked()) {
      setAccount(null);
      return;
    }
    void walletStore.getAccount().then((a) => {
      if (cancelled) return;
      setAccount(a);
      syncActiveLabel();
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked, syncActiveLabel]);

  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setBalance(null);
      setBalanceError(null);
      setLoadingBalance(false);
      return;
    }
    setLoadingBalance(true);
    setBalanceError(null);
    walletStore
      .getDefaultAdapter()
      .getBalance(account.address)
      .then((b: bigint) => {
        if (cancelled) return;
        setBalance(b);
        setBalanceError(null);
        setLoadingBalance(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBalance(null);
        setBalanceError(err instanceof Error ? err.message : t('account.balance_failed'));
        setLoadingBalance(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account, reloadKey]);

  useEffect(() => {
    if (account) void refreshTokens(account);
  }, [account, refreshTokens]);

  const retryBalance = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const startCreate = () => {
    setError(null);
    setDraft(createMnemonic(NEW_MNEMONIC_STRENGTH, 'english'));
    setMode('create');
  };

  const startRecover = () => {
    setError(null);
    setInput('');
    setMode('recover');
  };

  const confirmCreate = () => {
    void (async () => {
      try {
        await walletStore.unlock(draft);
        const acc = await walletStore.getAccount();
        setAccount(acc);
        setMode('idle');
        setDraft('');
        onReady();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  const confirmRecover = () => {
    void (async () => {
      try {
        await walletStore.unlock(input);
        const acc = await walletStore.getAccount();
        setAccount(acc);
        setMode('idle');
        setInput('');
        onReady();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  // 저장 시 빈 문자열은 null 로 넘긴다 — null 이어야 자동 이름(계정 N)으로 돌아간다.
  const saveLabel = () => {
    if (activeIdx === null || editingLabel === null) return;
    const next = editingLabel.trim();
    void (async () => {
      try {
        await walletStore.setAccountLabel(activeIdx, next === '' ? null : next);
        setEditingLabel(null);
        setLabelError(null);
        syncActiveLabel();
      } catch (e) {
        setLabelError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  const lock = () => {
    void walletStore.lock();
    setAccount(null);
    setMode('idle');
    setBalance(null);
    setBalanceError(null);
    setActiveIdx(null);
    setRawLabel(null);
    setEditingLabel(null);
    setLabelError(null);
    onLock();
  };

  // 토큰 행마다 "몇 TTL 인가" 를 SDK 에 묻는다. 셸은 산식을 만들지 않는다 —
  // v0.5.21 에 셸마다 짜서 4 벌이 어긋났다. chainId 는 어댑터 id('evm:7777')
  // 에서 온다: 주소 신원 판정이 체인별이라 이 값이 빠지면 전부 미확인이 된다.
  const chainId = Number(walletStore.getDefaultAdapter().id.replace(/^evm:/, ''));
  // desktop 은 시세를 가져오지 않는다. 없는 표를 있는 척하지 않기 위해 null 을
  // **명시적으로** 넘긴다 — 그러면 시세가 있어야 값이 나오는 자산은 조용히
  // 0 이 되는 대신 '시세 없음' 으로 드러난다.
  const prices = null;
  const tokenValues: { row: DiscoveredBalance; value: AssetValue }[] = (tokens ?? []).map((row) => ({
    row,
    value: assetValueInTtl(
      {
        kind: 'token',
        id: row.token.address,
        family: 'evm',
        chainId: Number.isFinite(chainId) ? chainId : null,
        symbol: row.token.symbol,
        balance: row.balance,
        decimals: row.token.decimals,
      },
      { prices },
    ),
  }));
  // native TTL 은 환산이 아니라 자기 자신이다 — 그래도 같은 함수로 묻는다.
  // 셸이 자릿수를 따로 정하면 합계와 히어로가 갈라진다.
  const nativeValue =
    balance != null ? assetValueInTtl({ kind: 'ttl', balance }, { prices }) : null;
  // 합계. 값 미상은 더하지 않고 센다 — `?? 0` 으로 때우면 빠진 자산을 숨긴
  // 총액이 되고 그건 거짓이다.
  const portfolio = sumTtl([
    ...(nativeValue ? [nativeValue] : []),
    ...tokenValues.map((v) => v.value),
  ]);
  // 잔액 자체를 못 읽은 것도 빠진 자산 1 건이다.
  const portfolioMissing = portfolio.missing + (balance == null ? 1 : 0);
  // 이 화면의 TTL 값이 **어느 앵커의 것인지**. 스냅샷을 다시 만들면 바뀌므로
  // 날짜를 코드에 적지 않고 런타임에 읽는다.
  const anchoredAt = rateSnapshot().anchoredAt;

  if (account && unlocked) {
    return (
      <div className="nd-view">
        <header className="nd-view__header">
          <h1 className="nd-h1">{t('nav.wallet')}</h1>
          <p className="nd-lead">{t('account.unlocked_lead')}</p>
          {activeIdx !== null && editingLabel === null && (
            <div className="nd-row">
              <span className="nd-muted">
                {rawLabel ?? t('accounts.no_label', { idx: activeIdx + 1 })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLabelError(null);
                  setEditingLabel(rawLabel ?? '');
                }}
              >
                {t('accounts.rename_button')}
              </Button>
            </div>
          )}
          {activeIdx !== null && editingLabel !== null && (
            <div className="nd-row">
              <input
                className="nd-input"
                value={editingLabel}
                maxLength={32}
                autoFocus
                aria-label={t('accounts.rename_aria')}
                placeholder={t('accounts.rename_placeholder')}
                onChange={(e) => setEditingLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveLabel();
                  if (e.key === 'Escape') {
                    setEditingLabel(null);
                    setLabelError(null);
                  }
                }}
              />
              <Button variant="primary" size="sm" onClick={saveLabel}>
                {t('accounts.rename_save')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingLabel(null);
                  setLabelError(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          )}
          {labelError && (
            <div className="nd-error" role="alert">
              {t('accounts.rename_failed', { reason: labelError })}
            </div>
          )}
        </header>

        <Card as="section">
          <div className="nd-label">{t('account.balance_label')}</div>
          {loadingBalance && <div className="nd-muted">{t('account.balance_loading')}</div>}
          {!loadingBalance && balanceError && (
            <>
              <div className="nd-error">
                {t('account.balance_failed_with_reason', { reason: balanceError })}
              </div>
              <div style={{ marginTop: 12 }}>
                <Button variant="secondary" onClick={retryBalance}>
                  {t('account.retry')}
                </Button>
              </div>
            </>
          )}
          {!loadingBalance && !balanceError && balance != null && (
            <>
              <AmountDisplay value={balance} decimals={18} symbol="TTL" size="lg" />
              {/* TTL 은 기준이라 다른 것으로 바꿔 적지 않는다 — 자기 정의(품삯 일수)를 적는다. */}
              <div className="nd-muted" style={{ marginTop: 6 }}>
                {nativeValue?.ttl !== null && nativeValue !== null &&
                  t('tokens.value_labor_days', { v: formatTtl(nativeValue.ttl) })}
              </div>
              {/*
                포트폴리오 TTL 합계. 모든 자산을 같은 자로 재므로 성립한다.
                값을 못 낸 자산 수를 반드시 함께 적는다 — 빠진 것을 숨긴 합계는
                거짓이다. desktop 은 TTL 체인 전용이라 시세 기반 항목이 없어
                이 합계는 출렁이지 않는다.
              */}
              <div className="nd-muted" style={{ marginTop: 4 }}>
                {t('portfolio.total_ttl', { v: formatTtl(portfolio.ttl) })}
                {portfolioMissing > 0 && (
                  <span title={t('portfolio.total_excluded_hint')} style={{ marginLeft: 6 }}>
                    {t('portfolio.total_excluded', { n: portfolioMissing })}
                  </span>
                )}
                {/* 시세 자산이 섞이면 합계가 출렁인다. 그 사실을 적지 않으면
                    출렁임이 "TTL 이 시장을 따라간다" 로 읽힌다. */}
                {portfolio.volatile && (
                  <span style={{ marginLeft: 6 }}>
                    {t('portfolio.total_volatile_note', {
                      n: tokenValues.filter((v) => v.value.volatile && v.value.ttl !== null).length,
                    })}
                  </span>
                )}
              </div>
              {/* 어느 앵커의 값인지. 한 화면에 한 번만 적는다. */}
              <div className="nd-muted nd-anchor-line">
                {t('tokens.anchor_line', { date: anchoredAt })}
              </div>
            </>
          )}
          <div className="nd-muted" style={{ marginTop: 12 }}>
            {t('account.network_line')}
          </div>
        </Card>

        <Card as="section" style={{ marginTop: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div className="nd-label" style={{ marginBottom: 0 }}>{t('tokens.title')}</div>
            <Button variant="ghost" size="sm" onClick={() => setShowAddModal(true)}>
              {t('tokens.add')}
            </Button>
          </div>
          {tokensLoading && (
            <div className="nd-muted" style={{ marginTop: 8 }}>{t('tokens.loading')}</div>
          )}
          {tokensError && <div className="nd-error">{tokensError}</div>}
          {!tokensLoading && tokens && tokens.length === 0 && !tokensError && (
            <p className="nd-muted" style={{ marginTop: 8 }}>
              {t('tokens.empty')}
            </p>
          )}
          {tokens && tokens.length > 0 && (
            <ul className="nd-tokens">
              {tokenValues.map(({ row, value }) => (
                <li key={row.token.address} className="nd-tokens__row">
                  <span className="nd-tokens__sym">{row.token.symbol}</span>
                  <span className="nd-tokens__name">{row.token.name}</span>
                  {/* 수량과 TTL 값은 **같은 자릿수**를 쓴다(value.decimals) —
                      갈라지면 한 줄 안의 두 숫자가 서로를 부정한다. */}
                  <span className="nd-tokens__value">
                    <AmountDisplay
                      value={row.balance}
                      decimals={value.decimals}
                      symbol={row.token.symbol}
                      maxDecimals={4}
                      size="md"
                    />
                    <TtlValueLine value={value} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card as="section" style={{ marginTop: 16 }}>
          <div className="nd-label">{t('account.address_label')}</div>
          <AddressDisplay address={account.address} head={8} tail={6} />
          <div className="nd-row" style={{ marginTop: 16 }}>
            <Button variant="secondary" onClick={lock}>
              {t('common.lock')}
            </Button>
          </div>
        </Card>

        {showAddModal && (
          <AddTokenModal
            onClose={() => setShowAddModal(false)}
            onAdded={() => {
              setShowAddModal(false);
              if (account) void refreshTokens(account);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">{t('home.welcome_title')}</h1>
        <p className="nd-lead">
          {t('home.welcome_lead')}
        </p>
      </header>

      {mode === 'idle' && (
        <Card as="section">
          <div className="nd-label">{t('home.start_label')}</div>
          <Button variant="primary" className="nd-button--block" onClick={startCreate}>
            {t('home.create_new_wallet')}
          </Button>
          <div style={{ height: 10 }} />
          <Button variant="ghost" className="nd-button--block" onClick={startRecover}>
            {t('home.recover_from_phrase')}
          </Button>
        </Card>
      )}

      {mode === 'create' && (
        <Card as="section">
          <div className="nd-label">{t('create.mnemonic_label', { n: NEW_MNEMONIC_WORD_COUNT })}</div>
          <div className="nd-warn">
            {t('create.warn_desktop', { n: NEW_MNEMONIC_WORD_COUNT })}
          </div>
          <div className="nd-mnemonic">{draft}</div>
          {error && <div className="nd-error">{error}</div>}
          <div className="nd-row" style={{ marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setMode('idle')}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={confirmCreate}>
              {t('create.save_and_start')}
            </Button>
          </div>
        </Card>
      )}

      {mode === 'recover' && (
        <Card as="section">
          <div className="nd-label">{t('recover.input_label')}</div>
          <textarea
            className="nd-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('recover.input_placeholder')}
            autoFocus
          />
          {error && <div className="nd-error">{error}</div>}
          <div className="nd-row" style={{ marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setMode('idle')}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={confirmRecover}
              disabled={input.trim().length === 0}
            >
              {t('recover.restore')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * 한 자산의 TTL 값 한 줄.
 *
 * 산식은 이미 SDK 에서 끝났다 — 여기는 그 결과(ttl·basis·volatile·reason)를
 * 그리기만 한다. 셸이 다시 계산하지 않는다.
 *
 * 두 가지를 반드시 구분해 보인다:
 *  - 고정 액면(t{ISO}·스테이블) vs 시세 기준(상장자산). 구분이 없으면 출렁이는
 *    TTL 값이 "TTL 이 시장을 따라간다" 로 읽히고, 그건 지운 페그와 화면상
 *    구별이 안 된다.
 *  - 값 미상은 빈칸이 아니라 문장이다. 빈칸은 "0" 으로 읽힌다.
 */
function TtlValueLine({ value }: { value: AssetValue }) {
  const t = useT();
  if (value.ttl === null) {
    const reasonKey =
      value.reason === 'unverified'
        ? 'tokens.value_unverified'
        : value.reason === 'no-face-rate'
          ? 'tokens.value_no_face_rate'
          : value.reason === 'bad-decimals'
            ? 'tokens.value_bad_decimals'
            : 'tokens.value_unlisted';
    return (
      <span
        className="nd-ttl-value nd-ttl-value--unknown"
        title={value.reason === 'unverified' ? t('tokens.value_unverified_hint') : undefined}
      >
        {t(reasonKey)}
      </span>
    );
  }
  // 배지는 아이콘이 아니라 짧은 텍스트다 — 좁은 화면·고대비 모드에서 아이콘과
  // 색은 사라지지만 글자는 남는다.
  const market = value.basis === 'market';
  return (
    <span className={`nd-ttl-value${market ? ' nd-ttl-value--market' : ''}`}>
      {t(market ? 'tokens.value_ttl_market' : 'tokens.value_ttl', { v: formatTtl(value.ttl) })}
      <span
        className={`value-badge value-badge--${market ? 'market' : 'fixed'}`}
        title={t(market ? 'tokens.basis_market_hint' : 'tokens.basis_fixed_hint')}
      >
        {t(market ? 'tokens.basis_market' : 'tokens.basis_fixed')}
      </span>
    </span>
  );
}

/**
 * "Add token" 모달 — 데스크톱 버전.
 * web 의 모달과 동일 흐름이지만 desktop 스타일에 맞게 폼만 약간 다르게.
 */
function AddTokenModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useT();
  const [addr, setAddr] = useState('');
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const validAddr = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());

  const lookup = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setInfo(null);
    try {
      const adapter = walletStore.getDefaultAdapter() as unknown as ConstructorParameters<
        typeof Erc20
      >[0];
      const erc20 = new Erc20(adapter);
      const target = addr.trim();
      const [symbol, name, decimals] = await Promise.all([
        erc20.symbol(target),
        erc20.name(target),
        erc20.decimals(target),
      ]);
      setInfo({ address: target, symbol, name, decimals, custom: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('tokens.info_lookup_failed'));
    } finally {
      setLoading(false);
    }
  }, [addr, t]);

  const add = () => {
    if (!info) return;
    const chainIdStr = walletStore.getDefaultAdapter().id.replace(/^evm:/, '');
    sharedRegistry.addCustomToken(Number(chainIdStr), info);
    onAdded();
  };

  return (
    <div className="nd-modal" role="dialog" aria-modal="true" aria-label={t('tokens.add')}>
      <div className="nd-modal__sheet">
        <h2 style={{ margin: '0 0 8px', fontSize: 20 }}>{t('tokens.modal.title')}</h2>
        <p className="nd-muted" style={{ marginTop: 0 }}>
          {t('tokens.modal.lead')}
        </p>
        <input
          className="nd-input"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x..."
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <div className="nd-row" style={{ marginTop: 12 }}>
          <Button
            variant="secondary"
            onClick={lookup}
            disabled={!validAddr || loading}
            loading={loading}
          >
            {t('tokens.modal.lookup')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
        {err && <div className="nd-error">{err}</div>}
        {info && (
          <div style={{ marginTop: 12 }}>
            <p className="nd-muted" style={{ marginBottom: 4 }}>
              {t('tokens.modal.found')}
            </p>
            <p style={{ margin: 0, fontWeight: 700 }}>
              {info.symbol} <span className="nd-muted">· {info.name}</span>
            </p>
            <p className="nd-muted" style={{ marginTop: 4 }}>
              {t('tokens.modal.decimals_label', { n: info.decimals })}
            </p>
            <Button variant="primary" className="nd-button--block" onClick={add}>
              {t('tokens.modal.add_to_wallet')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// bigint → number 하강은 SDK(baseUnitsToNumber) 한 곳에서만 한다.
// 여기 있던 사본은 지웠다 — 사본은 반드시 갈라진다.

/** 품삯 일수 표기 — 1 미만은 자리를 더 보여야 0 으로 보이지 않는다. */
function formatTtl(ttl: number): string {
  if (!Number.isFinite(ttl)) return '—';
  if (ttl === 0) return '0';
  if (Math.abs(ttl) < 0.0001) return '<0.0001';
  const digits = Math.abs(ttl) < 1 ? 4 : 2;
  return ttl.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
