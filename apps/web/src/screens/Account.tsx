import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Erc20,
  TokenRegistry,
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
import { AddressDisplay, AmountDisplay, Button, Card } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';
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

  const [showAddModal, setShowAddModal] = useState(false);

  // WalletAccount 에는 label 이 없다 → 활성 계정 라벨은 listAccounts() 에서 따로 읽는다.
  // idx 는 setAccountLabel 의 유일한 식별자라 함께 들고 있는다.
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  // null = 보기 모드, 문자열 = 편집 중 입력값 (AddressbookPane 의 pendingRemove 와 같은 모양).
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  // 잠금 화면에서 부르면 빈 배열이므로 undefined 경로를 방어한다.
  const loadActiveLabel = useCallback(() => {
    const active = walletStore.listAccounts().find((a) => a.active);
    setActiveIdx(active ? active.idx : null);
    setActiveLabel(active ? active.label : null);
  }, []);

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
        loadActiveLabel();
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
  }, [onLock, t, loadActiveLabel]);

  // 라벨 저장. 빈 문자열은 null 로 넘겨 자동 이름(`계정 N`)으로 되돌린다.
  const saveLabel = useCallback(async () => {
    if (activeIdx == null || editingLabel == null) return;
    const next = editingLabel.trim();
    setRenameError(null);
    try {
      await walletStore.setAccountLabel(activeIdx, next === '' ? null : next);
      loadActiveLabel();
      setEditingLabel(null);
    } catch (e) {
      setRenameError(
        t('accounts.rename_failed', { reason: e instanceof Error ? e.message : String(e) }),
      );
    }
  }, [activeIdx, editingLabel, loadActiveLabel, t]);

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

  if (!account) return null;

  // 잔액 표시 문자열을 직접 만든다 — AmountDisplay 는 inline-flex 인데
  // 히어로는 큰 한 줄에 tabular-num + symbol 을 함께 보여줘야 하기 때문.
  const ttlBalanceText = formatTtl(balance);
  // web 은 시세를 가져오지 않는다. 없는 표를 있는 척하지 않기 위해 null 을
  // **명시적으로** 넘긴다 — 시세가 있어야 값이 나오는 자산은 조용히 0 이 되는
  // 대신 '시세 없음' 으로 드러난다.
  const prices = null;
  // TTL 은 정의상 1 TTL = 노동자 하루 품삯이라 환산 계수가 없다 — 잔액이 곧
  // 일수다. 그래도 같은 함수로 묻는다: 셸이 자릿수를 따로 정하면 히어로와
  // 합계가 갈라진다.
  const nativeValue =
    balance != null ? assetValueInTtl({ kind: 'ttl', balance }, { prices }) : null;
  const laborDays = nativeValue?.ttl ?? null;
  const chainId = Number(walletStore.getDefaultAdapter().id.replace(/^evm:/, ''));
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
  // 합계. 값 미상은 더하지 않고 센다 — `?? 0` 으로 때우면 빠진 자산을 숨긴
  // 총액이 되고 그건 거짓이다.
  const portfolio = sumTtl([
    ...(nativeValue ? [nativeValue] : []),
    ...tokenValues.map((v) => v.value),
  ]);
  const portfolioMissing = portfolio.missing + (balance == null ? 1 : 0);
  // 이 화면의 TTL 값이 **어느 앵커의 것인지**. 스냅샷을 다시 만들면 바뀌므로
  // 날짜를 코드에 적지 않고 런타임에 읽는다.
  const anchoredAt = rateSnapshot().anchoredAt;

  return (
    <div>
      <h1 className="nd-h1">{t('account.title')}</h1>
      <p className="nd-lead">{t('account.subtitle_ttl')}</p>

      {/*
        계정 이름 줄. web 에는 계정 목록이 없어 라벨 표시 자체가 여기서 처음 생긴다.
        편집은 모달이 아닌 인라인 — 저장소에 이미 있는 편집 문체(AddressbookPane)와 같게.
      */}
      {activeIdx != null && (
        <div className="nd-row" style={{ alignItems: 'center', gap: 8, marginBottom: 12 }}>
          {editingLabel == null ? (
            <>
              <p style={{ margin: 0, fontWeight: 700 }}>
                {activeLabel ?? t('accounts.no_label', { idx: activeIdx + 1 })}
              </p>
              <Button variant="ghost" size="sm" onClick={() => { setRenameError(null); setEditingLabel(activeLabel ?? ''); }}>
                {t('accounts.rename_button')}
              </Button>
            </>
          ) : (
            <>
              <input
                className="nd-input"
                value={editingLabel}
                maxLength={32}
                autoFocus
                aria-label={t('accounts.rename_aria')}
                placeholder={t('accounts.rename_placeholder')}
                onChange={(e) => setEditingLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveLabel();
                  if (e.key === 'Escape') setEditingLabel(null);
                }}
              />
              <Button variant="secondary" size="sm" onClick={() => void saveLabel()}>
                {t('accounts.rename_save')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditingLabel(null)}>
                {t('common.cancel')}
              </Button>
            </>
          )}
        </div>
      )}
      {renameError && <div className="nd-error" role="alert">{renameError}</div>}

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
              {/* TTL 은 기준이라 다른 것으로 바꿔 적지 않는다 — 그 자리에 자기 정의를 적는다. */}
              {laborDays !== null && (
                <p className="web-balance-hero__usd">
                  {t('tokens.value_labor_days', { v: formatLaborDays(laborDays) })}
                </p>
              )}
              {/*
                포트폴리오 TTL 합계. 모든 자산을 같은 자로 재므로 성립한다.
                값을 못 낸 자산 수를 반드시 함께 적는다 — 빠진 것을 숨긴 합계는
                거짓이다.
              */}
              <p className="web-balance-hero__total">
                {t('portfolio.total_ttl', { v: formatLaborDays(portfolio.ttl) })}
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
              </p>
              {/* 어느 앵커의 값인지. 한 화면에 한 번만 적는다. */}
              <p className="web-anchor-line">{t('tokens.anchor_line', { date: anchoredAt })}</p>
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
 * 한 자산의 TTL 값 한 줄.
 *
 * 산식은 이미 SDK 에서 끝났다 — 여기는 그 결과(ttl·basis·volatile·reason)를
 * 그리기만 한다. 셸이 다시 계산하지 않는다. desktop 의 같은 이름 컴포넌트와
 * 표시 규칙이 동일하다.
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
      {t(market ? 'tokens.value_ttl_market' : 'tokens.value_ttl', {
        v: formatLaborDays(value.ttl),
      })}
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

// bigint → number 하강은 SDK(baseUnitsToNumber) 한 곳에서만 한다.
// 여기 있던 사본은 지웠다 — 사본은 반드시 갈라진다.

/** 품삯 일수 표기 — 1 미만은 자리를 더 보여야 0 으로 보이지 않는다. */
function formatLaborDays(ttl: number): string {
  if (!Number.isFinite(ttl)) return '—';
  if (ttl === 0) return '0';
  if (Math.abs(ttl) < 0.0001) return '<0.0001';
  const digits = Math.abs(ttl) < 1 ? 4 : 2;
  return ttl.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
