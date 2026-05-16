import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Erc20,
  TokenRegistry,
  discoverTokens,
  getPrice,
  type DiscoveredBalance,
  type TokenInfo,
  type WalletAccount,
} from '@nodong/wallet-sdk';
import { AddressDisplay, AmountDisplay, Button, Card } from '@nodong/design-system';
import { walletStore } from '../wallet-store.js';

interface Props {
  onSend: () => void;
  onLock: () => void;
  onActivity: () => void;
}

// chainId 별 TokenRegistry 는 화면 단위로 한 번만 만든다 — 사용자 커스텀
// 토큰을 모달에서 추가하면 즉시 목록에 반영하기 위함.
const sharedRegistry = new TokenRegistry();

export function Account({ onSend, onLock, onActivity }: Props) {
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tokens, setTokens] = useState<DiscoveredBalance[] | null>(null);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokensError, setTokensError] = useState<string | null>(null);

  const [ttlPrice, setTtlPrice] = useState<number | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!walletStore.isUnlocked()) {
      onLock();
      return;
    }
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const acc = await walletStore.getAccount();
        if (cancelled) return;
        setAccount(acc);
        const bal = await walletStore.getDefaultAdapter().getBalance(acc.address);
        if (!cancelled) setBalance(bal);

        const url = await QRCode.toDataURL(acc.address, {
          margin: 1,
          width: 240,
          color: { dark: '#0a0a0a', light: '#ffffff' },
        });
        if (!cancelled) setQrDataUrl(url);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? `잔액을 불러오지 못했습니다: ${e.message}` : '잔액 조회 실패',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onLock]);

  const refreshTokens = useCallback(async (acc: WalletAccount) => {
    setTokensLoading(true);
    setTokensError(null);
    try {
      // TTL chain 은 빌트인 토큰이 없으므로 사용자 추가만 보인다.
      // discoverTokens 자체는 50 RPC 호출 상한.
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
    if (account) void refreshTokens(account);
  }, [account, refreshTokens]);

  // TTL 가격은 CoinGecko 에 등록되어 있지 않을 확률이 높다 → null 받을 가능성.
  useEffect(() => {
    let cancelled = false;
    void getPrice('ttl').then((v) => {
      if (!cancelled) setTtlPrice(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!account) return null;

  return (
    <div>
      <h1 className="nd-h1">내 지갑</h1>
      <p className="nd-lead">TTL 메인넷 · 체인 ID 7777</p>

      <Card>
        <p className="nd-muted" style={{ marginTop: 0, marginBottom: 8 }}>잔액</p>
        {loading ? (
          <span className="nd-muted">불러오는 중...</span>
        ) : (
          <>
            <AmountDisplay
              value={balance ?? 0n}
              decimals={18}
              symbol="TTL"
              maxDecimals={4}
              size="lg"
            />
            {ttlPrice != null && balance != null && (
              <div className="nd-muted" style={{ marginTop: 6 }}>
                ≈ ${usdValueOf(balance, 18, ttlPrice)} USD
              </div>
            )}
          </>
        )}
        {error && <div className="nd-error">{error}</div>}
      </Card>

      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <p className="nd-muted" style={{ margin: 0 }}>토큰</p>
          <Button variant="ghost" onClick={() => setShowAddModal(true)}>
            토큰 추가
          </Button>
        </div>
        {tokensLoading && <span className="nd-muted">토큰 조회 중…</span>}
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

      <Card>
        <p className="nd-muted" style={{ marginTop: 0, marginBottom: 8 }}>받는 주소</p>
        <AddressDisplay
          address={account.address}
          head={10}
          tail={8}
          copyLabel="주소 복사"
          copiedLabel="복사됨"
        />
        {qrDataUrl && (
          <>
            <div style={{ height: 14 }} />
            <div className="nd-qr">
              <img src={qrDataUrl} alt="receiving address QR" />
            </div>
            <p className="nd-muted" style={{ textAlign: 'center', marginTop: 10 }}>
              QR을 스캔해 이 주소로 받을 수 있습니다.
            </p>
          </>
        )}
      </Card>

      <Button variant="primary" className="nd-button--block" onClick={onSend}>
        송금
      </Button>
      <Button variant="secondary" className="nd-button--block" onClick={onActivity}>
        활동 보기
      </Button>
      <Button variant="ghost" className="nd-button--block" onClick={onLock}>
        잠금
      </Button>

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

/**
 * "토큰 추가" 모달.
 *
 * 사용자가 컨트랙트 주소를 붙여넣으면 Erc20 으로 symbol/name/decimals 를
 * 읽어 미리보기 → 사용자 확인 후 sharedRegistry 에 등록한다.
 *
 * 실패 케이스(잘못된 주소/컨트랙트 아님)는 에러 메시지로만 안내한다.
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
    const chainId = walletStore.getDefaultAdapter().id.replace(/^evm:/, '');
    sharedRegistry.addCustomToken(Number(chainId), info);
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
  // 1000 분의 1 까지만 표기 — UI 가시성 우선, 정확도 손실은 표시 단계에서만.
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
