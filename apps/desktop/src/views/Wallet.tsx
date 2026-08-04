import { useCallback, useEffect, useState } from 'react';
import {
  Erc20,
  TokenRegistry,
  createMnemonic,
  NEW_MNEMONIC_STRENGTH,
  NEW_MNEMONIC_WORD_COUNT,
  discoverTokens,
  getPrice,
  type DiscoveredBalance,
  type TokenInfo,
  type WalletAccount,
} from '@byeorin/wallet-sdk';
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
  const [ttlPrice, setTtlPrice] = useState<number | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    void getPrice('ttl').then((v) => {
      if (!cancelled) setTtlPrice(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
              {ttlPrice != null && (
                <div className="nd-muted" style={{ marginTop: 6 }}>
                  ≈ ${usdValueOf(balance, 18, ttlPrice)} USD
                </div>
              )}
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
              {tokens.map((t) => (
                <li key={t.token.address} className="nd-tokens__row">
                  <span className="nd-tokens__sym">{t.token.symbol}</span>
                  <span className="nd-tokens__name">{t.token.name}</span>
                  <AmountDisplay
                    value={t.balance}
                    decimals={t.token.decimals}
                    symbol={t.token.symbol}
                    maxDecimals={4}
                    size="md"
                  />
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

/**
 * bigint base unit + decimals + USD price → 표시용 USD 문자열.
 * Number 변환은 표시용에 한정 (잔액 자체는 항상 bigint 로 유지).
 */
function usdValueOf(base: bigint, decimals: number, priceUsd: number): string {
  const factor = 10n ** BigInt(decimals);
  const whole = base / factor;
  const frac = base % factor;
  const fracNum = Number(frac) / Number(factor);
  const value = Number(whole) + fracNum;
  return (value * priceUsd).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}
