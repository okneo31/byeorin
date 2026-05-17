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
import { useT } from '@nodong/i18n/react';
import { walletStore } from '../wallet-store.js';

interface Props {
  onSend: () => void;
  onLock: () => void;
  onActivity: () => void;
}

// chainId 별 TokenRegistry 는 화면 단위로 한 번만 만든다 — 사용자 커스텀
// 토큰을 모달에서 추가하면 즉시 목록에 반영하기 위함.
const sharedRegistry = new TokenRegistry();

// TTL native 자산의 정확도. 표시용 잘림 자릿수와는 별개.
const TTL_DECIMALS = 18;

export function Account({ onSend, onLock, onActivity }: Props) {
  const t = useT();
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
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
            e instanceof Error
              ? t('account.balance_failed_with_reason', { reason: e.message })
              : t('account.balance_failed'),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onLock, t]);

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
      setTokensError(e instanceof Error ? e.message : t('tokens.lookup_failed'));
      setTokens([]);
    } finally {
      setTokensLoading(false);
    }
  }, [t]);

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

  // 잔액 표시 문자열을 직접 만든다 — AmountDisplay 는 inline-flex 인데
  // 히어로는 큰 한 줄에 tabular-num + symbol 을 함께 보여줘야 하기 때문.
  const ttlBalanceText = formatTtl(balance);
  const usdText = balance != null && ttlPrice != null
    ? usdValueOf(balance, TTL_DECIMALS, ttlPrice)
    : null;

  return (
    <div>
      <h1 className="nd-h1">{t('account.title')}</h1>
      <p className="nd-lead">{t('account.subtitle_ttl')}</p>

      {/* ── 잔액 히어로 카드 ─────────────────────────── */}
      <Card>
        <div className="web-balance-hero">
          <p className="web-balance-hero__label">{t('account.balance_label')}</p>
          {loading ? (
            <span className="nd-muted">{t('common.loading')}</span>
          ) : (
            <>
              <p className="web-balance-hero__value">
                {ttlBalanceText}
                <span className="web-balance-hero__symbol">TTL</span>
              </p>
              {/*
                ≈ $0.00 가격 라인. CoinGecko 가 TTL 시세를 반환하지 않을 때
                "—" 와 함께 시세 없음을 명시한다 (디자인 요구사항).
              */}
              <p className="web-balance-hero__usd">
                {usdText != null ? `≈ $${usdText} USD` : `≈ — · ${t('account.usd_unavailable')}`}
              </p>
            </>
          )}
        </div>
        {error && <div className="nd-error">{error}</div>}
      </Card>

      {/* ── 3-버튼 액션 행: 송금(red) / 활동(ghost) / 잠금(ghost) ── */}
      <div className="web-action-row">
        <Button variant="primary" onClick={onSend}>
          {t('account.send')}
        </Button>
        <Button variant="ghost" onClick={onActivity}>
          {t('account.activity')}
        </Button>
        <Button variant="ghost" onClick={onLock}>
          {t('common.lock')}
        </Button>
      </div>

      {/* ── 주소 카드 (QR 인라인 토글) ────────────────── */}
      <Card>
        <div className="web-address-card__header">
          <p className="nd-muted" style={{ margin: 0 }}>
            {t('account.receive_address')}
          </p>
          {qrDataUrl && (
            <button
              type="button"
              className="web-qr-toggle"
              onClick={() => setShowQr((v) => !v)}
              aria-expanded={showQr}
              aria-controls="web-qr-panel"
            >
              {showQr ? t('account.hide_qr') : t('account.show_qr')}
            </button>
          )}
        </div>
        <AddressDisplay
          address={account.address}
          head={10}
          tail={8}
          copyLabel={t('account.copy_address')}
          copiedLabel={t('common.copied')}
        />
        {/*
          QR 은 모달이 아닌 인라인 확장으로 — "받기" 행동은 위협적이지 않기 때문에
          별도 창으로 사용자를 놀라게 할 필요가 없다.
        */}
        {showQr && qrDataUrl && (
          <div id="web-qr-panel" className="web-qr-inline">
            <img src={qrDataUrl} alt={t('account.qr_help')} />
            <p className="nd-muted" style={{ margin: 0, textAlign: 'center' }}>
              {t('account.qr_help')}
            </p>
          </div>
        )}
      </Card>

      {/* ── 토큰 목록 (사용자 추가형) ─────────────────── */}
      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <p className="nd-muted" style={{ margin: 0 }}>{t('tokens.title')}</p>
          <Button variant="ghost" size="sm" onClick={() => setShowAddModal(true)}>
            {t('tokens.add')}
          </Button>
        </div>
        {tokensLoading && <span className="nd-muted">{t('tokens.loading')}</span>}
        {tokensError && <div className="nd-error">{tokensError}</div>}
        {!tokensLoading && tokens && tokens.length === 0 && !tokensError && (
          <div className="web-tokens-empty">
            <p>{t('tokens.empty')}</p>
            <button
              type="button"
              className="web-tokens-empty__link"
              onClick={() => setShowAddModal(true)}
            >
              {t('tokens.add')}
            </button>
          </div>
        )}
        {tokens && tokens.length > 0 && (
          <ul className="nd-tokens">
            {tokens.map((row) => (
              <li key={row.token.address} className="nd-tokens__row">
                <span className="nd-tokens__sym">{row.token.symbol}</span>
                <span className="nd-tokens__name">{row.token.name}</span>
                <AmountDisplay
                  value={row.balance}
                  decimals={row.token.decimals}
                  symbol={row.token.symbol}
                  maxDecimals={4}
                  size="md"
                />
              </li>
            ))}
          </ul>
        )}
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
    const chainId = walletStore.getDefaultAdapter().id.replace(/^evm:/, '');
    sharedRegistry.addCustomToken(Number(chainId), info);
    onAdded();
  };

  return (
    <div className="nd-modal" role="dialog" aria-modal="true" aria-label={t('tokens.modal.title')}>
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
 * bigint TTL 잔액(wei) → "0.0000" 형식 한 단위 표기.
 * AmountDisplay 를 쓰지 않은 이유는 히어로에 큰 한 줄로 보여줘야 하고,
 * symbol/value 를 별도 색으로 분리해 표시하기 위함.
 */
function formatTtl(base: bigint | null): string {
  if (base == null) return '0.0000';
  const factor = 10n ** BigInt(TTL_DECIMALS);
  const whole = base / factor;
  const frac = base % factor;
  // 4자리 잘림 (디자인 요구사항: "0.0000 TTL").
  const fracStr = (Number(frac) / Number(factor))
    .toFixed(4)
    .slice(2); // ".XXXX" → "XXXX"
  return `${whole.toString()}.${fracStr}`;
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
