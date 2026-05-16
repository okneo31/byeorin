import { useCallback, useEffect, useState } from 'react';
import {
  Erc20,
  TokenRegistry,
  createMnemonic,
  discoverTokens,
  getPrice,
  type DiscoveredBalance,
  type TokenInfo,
  type WalletAccount,
} from '@nodong/wallet-sdk';
import {
  AddressDisplay,
  AmountDisplay,
  Button,
  Card,
} from '@nodong/design-system';
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
      setTokensError(e instanceof Error ? e.message : '토큰 조회 실패');
      setTokens([]);
    } finally {
      setTokensLoading(false);
    }
  }, []);

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
      if (!cancelled) setAccount(a);
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked]);

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
      .then((b) => {
        if (cancelled) return;
        setBalance(b);
        setBalanceError(null);
        setLoadingBalance(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBalance(null);
        setBalanceError(err instanceof Error ? err.message : '잔액 조회 실패');
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
    setDraft(createMnemonic(128, 'english'));
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

  const lock = () => {
    void walletStore.lock();
    setAccount(null);
    setMode('idle');
    setBalance(null);
    setBalanceError(null);
    onLock();
  };

  if (account && unlocked) {
    return (
      <div className="nd-view">
        <header className="nd-view__header">
          <h1 className="nd-h1">지갑</h1>
          <p className="nd-lead">TTL 메인넷에 연결되어 있습니다.</p>
        </header>

        <Card as="section">
          <div className="nd-label">잔액</div>
          {loadingBalance && <div className="nd-muted">잔액 조회 중…</div>}
          {!loadingBalance && balanceError && (
            <>
              <div className="nd-error">잔액을 불러오지 못했습니다 · {balanceError}</div>
              <div style={{ marginTop: 12 }}>
                <Button variant="secondary" onClick={retryBalance}>
                  다시 시도
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
            네트워크: TTL · Chain ID 7777
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
            <div className="nd-label" style={{ marginBottom: 0 }}>토큰</div>
            <Button variant="ghost" size="sm" onClick={() => setShowAddModal(true)}>
              토큰 추가
            </Button>
          </div>
          {tokensLoading && (
            <div className="nd-muted" style={{ marginTop: 8 }}>토큰 조회 중…</div>
          )}
          {tokensError && <div className="nd-error">{tokensError}</div>}
          {!tokensLoading && tokens && tokens.length === 0 && !tokensError && (
            <p className="nd-muted" style={{ marginTop: 8 }}>
              보유 토큰이 없습니다. "토큰 추가" 로 컨트랙트를 등록해보세요.
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
          <div className="nd-label">주소</div>
          <AddressDisplay address={account.address} head={8} tail={6} />
          <div className="nd-row" style={{ marginTop: 16 }}>
            <Button variant="secondary" onClick={lock}>
              잠금
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
        <h1 className="nd-h1">노동자의 지갑에 오신 것을 환영합니다</h1>
        <p className="nd-lead">
          비수탁 데스크톱 지갑입니다. 새 지갑을 만들거나, 기존 복구 문구로 복원할 수 있습니다.
        </p>
      </header>

      {mode === 'idle' && (
        <Card as="section">
          <div className="nd-label">시작하기</div>
          <Button variant="primary" className="nd-button--block" onClick={startCreate}>
            새 지갑 만들기
          </Button>
          <div style={{ height: 10 }} />
          <Button variant="ghost" className="nd-button--block" onClick={startRecover}>
            복구 문구로 복원
          </Button>
        </Card>
      )}

      {mode === 'create' && (
        <Card as="section">
          <div className="nd-label">복구 문구 (12 단어)</div>
          <div className="nd-warn">
            이 12단어를 안전한 곳에 옮겨 적어 두세요. 복구 문구는 지갑 자체이며, 잃어버리면 자산을
            되찾을 수 없습니다.
          </div>
          <div className="nd-mnemonic">{draft}</div>
          {error && <div className="nd-error">{error}</div>}
          <div className="nd-row" style={{ marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setMode('idle')}>
              취소
            </Button>
            <Button variant="primary" onClick={confirmCreate}>
              저장하고 시작
            </Button>
          </div>
        </Card>
      )}

      {mode === 'recover' && (
        <Card as="section">
          <div className="nd-label">복구 문구 입력</div>
          <textarea
            className="nd-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="12 또는 24개의 단어를 공백으로 구분하여 입력하세요"
            autoFocus
          />
          {error && <div className="nd-error">{error}</div>}
          <div className="nd-row" style={{ marginTop: 16 }}>
            <Button variant="ghost" onClick={() => setMode('idle')}>
              취소
            </Button>
            <Button
              variant="primary"
              onClick={confirmRecover}
              disabled={input.trim().length === 0}
            >
              복원
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * "토큰 추가" 모달 — 데스크톱 버전.
 * web 의 모달과 동일 흐름이지만 desktop 스타일에 맞게 폼만 약간 다르게.
 */
function AddTokenModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
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
      setErr(e instanceof Error ? e.message : '토큰 정보 조회 실패');
    } finally {
      setLoading(false);
    }
  }, [addr]);

  const add = () => {
    if (!info) return;
    const chainIdStr = walletStore.getDefaultAdapter().id.replace(/^evm:/, '');
    sharedRegistry.addCustomToken(Number(chainIdStr), info);
    onAdded();
  };

  return (
    <div className="nd-modal" role="dialog" aria-modal="true" aria-label="토큰 추가">
      <div className="nd-modal__sheet">
        <h2 style={{ margin: '0 0 8px', fontSize: 20 }}>토큰 추가</h2>
        <p className="nd-muted" style={{ marginTop: 0 }}>
          ERC-20 컨트랙트 주소를 입력하세요.
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
            정보 조회
          </Button>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
        </div>
        {err && <div className="nd-error">{err}</div>}
        {info && (
          <div style={{ marginTop: 12 }}>
            <p className="nd-muted" style={{ marginBottom: 4 }}>
              발견된 토큰
            </p>
            <p style={{ margin: 0, fontWeight: 700 }}>
              {info.symbol} <span className="nd-muted">· {info.name}</span>
            </p>
            <p className="nd-muted" style={{ marginTop: 4 }}>
              소수 자릿수: {info.decimals}
            </p>
            <Button variant="primary" className="nd-button--block" onClick={add}>
              내 지갑에 추가
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
