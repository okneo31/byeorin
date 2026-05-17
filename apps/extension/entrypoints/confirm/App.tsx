import { useEffect, useMemo, useState } from 'react';
import { formatUnits, hexToString, hexToBytes, hexToNumber, isHex, type Hex } from 'viem';
import { useT } from '@nodong/i18n/react';
import { AddressDisplay, AmountDisplay, Logo } from '@nodong/design-system';
import type { BackgroundMessage, ConfirmContext } from '../../src/lib/rpc.js';
import {
  decode4Byte,
  decodeErc20Call,
  detectTypedDataRisks,
  isUnlimitedApprove,
  isZeroAddress,
} from '../../src/lib/selectors.js';

// 노동자의 지갑 — 서명/전송 확인 popup.
//
// background 가 chrome.windows.create('confirm.html?requestId=...') 로 띄운다.
// 본 화면은:
//  1) URL 의 requestId 로 background 에 컨텍스트(method, origin, address, payload) 조회
//  2) 메서드별(personal_sign / eth_sendTransaction) 프리뷰 렌더
//  3) 사용자가 거부/승인 클릭 시 background 로 결과 전송 후 자체 close.
//
// 비-커스토디 원칙: 본 popup 이 서명/전송에 대한 유일한 동의 표면이다.

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; ctx: ConfirmContext }
  | { kind: 'error'; messageKey: string }
  | { kind: 'submitting'; ctx: ConfirmContext; decision: 'approve' | 'reject' }
  | { kind: 'submitted'; decision: 'approve' | 'reject' };

const TTL_EXPLORER = 'https://scan.ttl1.top';

// 메서드별 색상 매핑 — 헤더 칩에서 사용. 위험도가 높을수록 따뜻한 색.
//  personal_sign: green   — 자산 이동 없음, 인증 용도
//  signTypedData: orange  — Permit/Seaport 등 권한 위임 가능
//  send_tx (no data): blue — 단순 TTL 전송, 직관적
//  send_tx (with data): red — 컨트랙트 호출, 가장 위험
//  watch_asset: gray      — 자산 이동 없음
type TagTone = 'green' | 'orange' | 'blue' | 'red' | 'gray';

function getRequestIdFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('requestId');
  } catch {
    return null;
  }
}

function getNonceFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('nonce');
  } catch {
    return null;
  }
}

/**
 * 16진(0x...) → UTF-8 문자열 시도. 디코딩이 가능하고, 출력 가능한 문자만 남는 경우만 채택.
 * 그 외에는 null 반환 → 호출부가 raw hex 로 표시.
 */
function tryHexToReadable(messageHex: string): string | null {
  if (!isHex(messageHex)) return null;
  try {
    const s = hexToString(messageHex as Hex);
    if (!s) return null;
    // 제어문자(개행/탭 제외)가 섞이면 raw hex 로 노출 — 가독성보다 안전성 우선.
    // \x09(TAB), \x0A(LF), \x0D(CR) 만 허용.
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return null;
      // U+FFFD(replacement) 가 섞여 있다면 깨진 디코딩 → null.
      if (c === 0xfffd) return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** wei(BigInt) → "1.234560 TTL" 같은 표현. 소수점 이하 6자리로 trim. */
function formatTtl(weiHex: string, parseFailedLabel: string): string {
  try {
    const v = BigInt(weiHex);
    const full = formatUnits(v, 18);
    // 소수점 자르기: 최대 6자리, 후행 0 제거.
    const dot = full.indexOf('.');
    if (dot < 0) return full;
    const trimmed = full.slice(0, dot + 7).replace(/0+$/, '').replace(/\.$/, '');
    return trimmed.length === 0 ? '0' : trimmed;
  } catch {
    return parseFailedLabel;
  }
}

function formatGasUnits(gasHex: string | null): string | null {
  if (!gasHex) return null;
  try {
    return hexToNumber(gasHex as Hex).toLocaleString('en-US');
  } catch {
    return gasHex;
  }
}

function messageBytesLen(messageHex: string): number {
  try {
    return hexToBytes(messageHex as Hex).length;
  } catch {
    return 0;
  }
}

/** value(wei hex) → bigint, 파싱 실패 시 0n. AmountDisplay 입력용. */
function safeBigInt(hex: string): bigint {
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

export function App() {
  const t = useT();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const requestId = getRequestIdFromUrl();
    const nonce = getNonceFromUrl();
    // 보안: nonce 가 없으면 dApp 이 직접 popup URL 을 연 시나리오 — 친절한 안내.
    if (!requestId || !nonce) {
      setState({ kind: 'error', messageKey: 'confirm.error.no_context' });
      return;
    }
    const msg: BackgroundMessage = { type: 'confirm-context-get', requestId, nonce };
    chrome.runtime.sendMessage(msg, (ctx: ConfirmContext | null) => {
      if (chrome.runtime.lastError) {
        setState({ kind: 'error', messageKey: 'confirm.error.context_lookup_failed' });
        return;
      }
      if (!ctx) {
        // nonce 불일치 또는 만료 — dApp 이 fake requestId 로 직접 connect 한 경우 포함.
        setState({ kind: 'error', messageKey: 'confirm.error.expired' });
        return;
      }
      setState({ kind: 'ready', ctx });
    });
  }, []);

  function send(decision: 'approve' | 'reject', rememberFor1h = false): void {
    const requestId = getRequestIdFromUrl();
    const nonce = getNonceFromUrl();
    if (!requestId || !nonce) return;
    // optimistic submitting state — 버튼이 비활성화되고 로딩 표시.
    setState((prev) =>
      prev.kind === 'ready'
        ? { kind: 'submitting', ctx: prev.ctx, decision }
        : prev,
    );
    const msg: BackgroundMessage = {
      type: 'confirm-result',
      requestId,
      nonce,
      decision,
      // grant 는 approve 일 때만 의미가 있다. reject 에는 항상 false 송신.
      rememberFor1h: decision === 'approve' ? rememberFor1h : false,
    };
    chrome.runtime.sendMessage(msg, () => {
      setState({ kind: 'submitted', decision });
      // background 가 popup window 를 닫지만, 안전망으로 자체 close.
      setTimeout(() => window.close(), 200);
    });
  }

  if (state.kind === 'loading') {
    return (
      <main className="confirm">
        <BrandHeader />
        <p className="muted">{t('common.loading_ellipsis')}</p>
      </main>
    );
  }

  if (state.kind === 'error') {
    return (
      <main className="confirm">
        <BrandHeader />
        <section className="card">
          <h2>{t('confirm.error_title')}</h2>
          <p className="error small">{t(state.messageKey)}</p>
          <div className="actions">
            <button className="btn-ghost" onClick={() => window.close()}>
              {t('connect.close_window')}
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (state.kind === 'submitted') {
    return (
      <main className="confirm">
        <BrandHeader />
        <section className="card">
          <p>{state.decision === 'approve' ? t('confirm.approved') : t('confirm.rejected')}</p>
          <p className="muted small">{t('confirm.closing_soon')}</p>
        </section>
      </main>
    );
  }

  // ready/submitting 모두 같은 view 를 쓰되, submitting 시에는 awaiting 플래그로 전달.
  const ctx = state.kind === 'submitting' ? state.ctx : state.ctx;
  const awaiting = state.kind === 'submitting';
  if (ctx.method === 'personal_sign')
    return <PersonalSignView ctx={ctx} awaiting={awaiting} onDecision={send} />;
  if (ctx.method === 'eth_signTypedData_v4')
    return <SignTypedDataView ctx={ctx} awaiting={awaiting} onDecision={send} />;
  if (ctx.method === 'wallet_watchAsset')
    return <WatchAssetView ctx={ctx} awaiting={awaiting} onDecision={send} />;
  return <SendTxView ctx={ctx} awaiting={awaiting} onDecision={send} />;
}

// ── 공용 컴포넌트들 ───────────────────────────────────────────────────────

// 브랜드 헤더 — 좌측 작은 로고(인장) + 브랜드명.
// method tag 는 카드 헤더(<h2>) 에 붙는다 — 브랜드와 분리해 시각적 hierarchy 유지.
function BrandHeader() {
  const t = useT();
  return (
    <header className="brand">
      <Logo size={20} variant="mark" />
      <span className="brand-text">{t('brand.name')}</span>
    </header>
  );
}

// 메서드 칩 — 카드 <h2> 옆에 붙는 작은 색상 pill.
function MethodTag({ tone, label }: { tone: TagTone; label: string }) {
  return <span className={`method-tag method-tag--${tone}`}>{label}</span>;
}

// 사이트 origin 행 — 주소 표시줄처럼 보이도록 별도 스타일링.
function OriginRow({ origin }: { origin: string }) {
  const t = useT();
  return (
    <div className="origin-row" title={origin}>
      <span className="origin-row__label">{t('confirm.label.site_short')}</span>
      <span className="origin-row__url">{origin}</span>
    </div>
  );
}

// 서명자/보내는 주소 — design-system AddressDisplay 사용.
// copy 라벨은 i18n 으로 호출자가 주입한다.
function SignerRow({
  labelKey,
  address,
}: {
  labelKey: string;
  address: string;
}) {
  const t = useT();
  return (
    <div className="row">
      <span className="label">{t(labelKey)}</span>
      <AddressDisplay
        address={address}
        copyLabel={t('confirm.btn.copy')}
        copiedLabel={t('confirm.btn.copied')}
      />
    </div>
  );
}

// 액션 푸터 — 1시간 grant 토글이 버튼 위, separator, 거부(왼쪽) + 승인(오른쪽 강조).
function ActionFooter({
  remember,
  setRemember,
  method,
  approveLabel,
  rejectLabel,
  onApprove,
  onReject,
  awaiting,
}: {
  remember?: boolean;
  setRemember?: (v: boolean) => void;
  method?: ConfirmContext['method'];
  approveLabel: string;
  rejectLabel: string;
  onApprove: () => void;
  onReject: () => void;
  awaiting: boolean;
}) {
  return (
    <div className="footer">
      {method && setRemember ? (
        <RememberToggle
          method={method}
          checked={remember === true}
          onChange={setRemember}
        />
      ) : null}
      <div className="actions">
        <button
          className="btn-ghost"
          onClick={onReject}
          disabled={awaiting}
        >
          {rejectLabel}
        </button>
        <button
          className="btn-primary btn-cta"
          onClick={onApprove}
          disabled={awaiting}
        >
          {awaiting ? <span className="spinner" aria-hidden /> : null}
          <span>{approveLabel}</span>
        </button>
      </div>
    </div>
  );
}

// ── wallet_watchAsset 프리뷰 ───────────────────────────────────────────
// EIP-747: dApp 이 ERC-20 등 토큰을 본 지갑의 watch-list 에 등록 요청.
// 본 화면은 토큰 주소·심볼·소수자리 만 표시한다 — 자산 이동/서명이 일어나지
// 않으므로 위험도가 낮지만, 위조 토큰(예: 'USDC' 라는 심볼로 다른 컨트랙트)
// 을 추가하면 잔액 표시가 거짓될 수 있어 명시적 동의를 받는다.
function WatchAssetView({
  ctx,
  onDecision,
  awaiting,
}: {
  ctx: Extract<ConfirmContext, { method: 'wallet_watchAsset' }>;
  onDecision: (d: 'approve' | 'reject', rememberFor1h?: boolean) => void;
  awaiting: boolean;
}) {
  const t = useT();
  return (
    <main className="confirm">
      <BrandHeader />
      <section className="card">
        <h2>
          <span>{t('confirm.title.watch_asset')}</span>
          <MethodTag tone="gray" label="wallet_watchAsset" />
        </h2>
        <p className="muted small">{t('confirm.lead.watch_asset')}</p>

        <OriginRow origin={ctx.origin} />

        <div className="row">
          <span className="label">{t('confirm.label.token_standard')}</span>
          <span className="origin">{ctx.type}</span>
        </div>

        <div className="row">
          <span className="label">{t('confirm.label.token_address')}</span>
          <a
            className="addr-link"
            href={`${TTL_EXPLORER}/address/${ctx.tokenAddress}`}
            target="_blank"
            rel="noreferrer noopener"
            title={ctx.tokenAddress}
          >
            {ctx.tokenAddress}
          </a>
        </div>

        <div className="row">
          <span className="label">{t('confirm.label.symbol')}</span>
          <span className="origin">
            <strong>{ctx.symbol}</strong>
          </span>
        </div>

        <div className="row">
          <span className="label">{t('confirm.label.decimals')}</span>
          <span className="origin">{ctx.decimals}</span>
        </div>

        <p className="warn small">{t('confirm.warn.watch_asset')}</p>

        <ActionFooter
          approveLabel={t('confirm.btn.add_token')}
          rejectLabel={t('confirm.btn.reject')}
          onApprove={() => onDecision('approve')}
          onReject={() => onDecision('reject')}
          awaiting={awaiting}
        />
      </section>
    </main>
  );
}

// "이 사이트에서 1시간 동안 자동 승인" 체크박스 (공통 UI).
//
// 정책 강조:
//  - 본 옵션은 origin + 메서드(personal_sign 등) 조합으로만 grant 를 발급한다.
//  - grant 는 chrome.storage.session 에만 — 브라우저 종료/잠금 시 즉시 무효.
//  - 메시지 내용 자체에는 묶이지 않으므로, 1시간 내 임의 서명을 자동 통과시킬 수 있음을
//    사용자에게 명확히 경고한다.
function RememberToggle({
  method,
  checked,
  onChange,
}: {
  method: ConfirmContext['method'];
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const t = useT();
  // wallet_watchAsset 은 popup.method 카탈로그에 없으므로 confirm 전용 라벨로 합친다.
  // 다른 method 들은 popup.method.{name} 으로 매핑된다 (팝업/confirm 양쪽이 같은 키 사용).
  const label =
    method === 'wallet_watchAsset' ? 'wallet_watchAsset' : t(`popup.method.${method}`);
  return (
    <label className="remember-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="remember-text">
        {t('confirm.remember.template', { method: label })}
      </span>
    </label>
  );
}

// ── personal_sign 프리뷰 ─────────────────────────────────────────────
function PersonalSignView({
  ctx,
  onDecision,
  awaiting,
}: {
  ctx: Extract<ConfirmContext, { method: 'personal_sign' }>;
  onDecision: (d: 'approve' | 'reject', rememberFor1h?: boolean) => void;
  awaiting: boolean;
}) {
  const t = useT();
  const readable = useMemo(() => tryHexToReadable(ctx.message), [ctx.message]);
  const byteLen = useMemo(() => messageBytesLen(ctx.message), [ctx.message]);
  // 가독 메시지가 있을 때, raw hex 는 기본 숨김 — 펼치기로 노출.
  const [showRaw, setShowRaw] = useState(false);
  const [remember, setRemember] = useState(false);

  return (
    <main className="confirm">
      <BrandHeader />
      <section className="card">
        <h2>
          <span>{t('confirm.title.personal_sign')}</span>
          <MethodTag tone="green" label="personal_sign" />
        </h2>
        <p className="muted small">{t('confirm.lead.personal_sign')}</p>

        <OriginRow origin={ctx.origin} />

        <SignerRow labelKey="confirm.label.signer" address={ctx.address} />

        <div className="row">
          <div className="label-row">
            <span className="label">
              {readable
                ? t('confirm.label.message_to_sign', { byteLen })
                : t('confirm.label.message_to_sign_raw')}
            </span>
            {readable ? (
              <button
                className="btn-ghost btn-sm"
                onClick={() => setShowRaw((v) => !v)}
                disabled={awaiting}
              >
                {showRaw ? t('confirm.label.collapse') : t('confirm.label.expand')}
              </button>
            ) : null}
          </div>
          {readable && !showRaw ? (
            <div className="msg-block">{readable}</div>
          ) : (
            <div className="msg-block hex">{ctx.message}</div>
          )}
        </div>

        <p className="warn small">{t('confirm.warn.personal_sign_proof')}</p>

        {/* 1시간 자동 승인 — personal_sign 의 grant 는 임의 메시지를 자동 서명하게 된다. */}
        <p className="warn-banner">{t('confirm.warn.grant_personal_sign')}</p>

        <ActionFooter
          method={ctx.method}
          remember={remember}
          setRemember={setRemember}
          approveLabel={t('confirm.btn.approve')}
          rejectLabel={t('confirm.btn.reject')}
          onApprove={() => onDecision('approve', remember)}
          onReject={() => onDecision('reject')}
          awaiting={awaiting}
        />
      </section>
    </main>
  );
}

// ── eth_sendTransaction 프리뷰 ────────────────────────────────────────
const CALLDATA_TRUNC_AT = 256;

function SendTxView({
  ctx,
  onDecision,
  awaiting,
}: {
  ctx: Extract<ConfirmContext, { method: 'eth_sendTransaction' }>;
  onDecision: (d: 'approve' | 'reject', rememberFor1h?: boolean) => void;
  awaiting: boolean;
}) {
  const t = useT();
  const parseFailed = t('confirm.parse_failed');
  const valueFormatted = useMemo(() => formatTtl(ctx.value, parseFailed), [ctx.value, parseFailed]);
  const valueBigInt = useMemo(() => safeBigInt(ctx.value), [ctx.value]);
  const gasFormatted = useMemo(() => formatGasUnits(ctx.gas), [ctx.gas]);
  const dataNonEmpty = !!(ctx.data && ctx.data !== '0x' && ctx.data !== '');
  const decoded = useMemo(() => (dataNonEmpty ? decode4Byte(ctx.data) : null), [
    ctx.data,
    dataNonEmpty,
  ]);
  // ERC-20 transfer / approve / transferFrom 의 인자(주소+금액) 추출.
  // 실패(셀렉터 미일치 또는 길이 부족) 시 null. UI 는 fallback 으로 raw hex 만 표시.
  const erc20 = useMemo(
    () => (dataNonEmpty ? decodeErc20Call(ctx.data) : null),
    [ctx.data, dataNonEmpty],
  );
  // 무제한 권한 위임 휴리스틱 — approve 의 amount 가 2^200 이상.
  const unlimitedApprove = !!(erc20 && erc20.kind === 'approve' && isUnlimitedApprove(erc20.amount));
  // 자기 자신/0주소 위험 — transfer/transferFrom 의 to 가 from 과 같거나 0x00..00.
  const transferTo: string | null =
    erc20 && (erc20.kind === 'transfer' || erc20.kind === 'transferFrom')
      ? erc20.to
      : null;
  const transferToSelf =
    transferTo !== null && transferTo.toLowerCase() === ctx.from.toLowerCase();
  const transferToZero = transferTo !== null && isZeroAddress(transferTo);
  const [showFullData, setShowFullData] = useState(false);
  const [remember, setRemember] = useState(false);

  const dataDisplay = useMemo(() => {
    if (!ctx.data) return '';
    if (showFullData) return ctx.data;
    if (ctx.data.length <= CALLDATA_TRUNC_AT) return ctx.data;
    return ctx.data.slice(0, CALLDATA_TRUNC_AT) + '…';
  }, [ctx.data, showFullData]);

  // 컨트랙트 호출 = data 있음 → red 칩(가장 위험), 단순 value 전송 → blue 칩.
  const methodTone: TagTone = dataNonEmpty ? 'red' : 'blue';
  // 함수 인식 여부에 따른 prominent 칩 — 헤더 바로 아래 띠.
  const fnRecognized = !!(decoded && decoded.signature);

  return (
    <main className="confirm">
      <BrandHeader />
      <section className="card">
        <h2>
          <span>{t('confirm.title.send_tx')}</span>
          <MethodTag tone={methodTone} label="eth_sendTransaction" />
        </h2>
        <p className="muted small">{t('confirm.lead.send_tx')}</p>

        {/* 컨트랙트 호출일 때만 prominent 함수 칩을 헤더 바로 아래에 띄운다. */}
        {dataNonEmpty && decoded ? (
          <div className={`fn-banner ${fnRecognized ? 'fn-banner--ok' : 'fn-banner--unknown'}`}>
            <span className="fn-banner__selector">{decoded.selector}</span>
            <span className="fn-banner__name">
              {fnRecognized
                ? decoded.signature
                : t('confirm.label.unknown_fn_chip')}
            </span>
          </div>
        ) : null}

        <OriginRow origin={ctx.origin} />

        <SignerRow labelKey="confirm.label.from" address={ctx.from} />

        <div className="row">
          <span className="label">
            {dataNonEmpty ? t('confirm.label.target_contract') : t('confirm.label.to_address')}
          </span>
          <a
            className="addr-link"
            href={`${TTL_EXPLORER}/address/${ctx.to}`}
            target="_blank"
            rel="noreferrer noopener"
            title={ctx.to}
          >
            {ctx.to}
          </a>
        </div>

        <div className="row amount-row">
          <span className="label">
            {dataNonEmpty ? t('confirm.label.native_with_call') : t('confirm.label.amount')}
          </span>
          <div className="amount-row__main">
            <AmountDisplay
              value={valueBigInt}
              decimals={18}
              symbol="TTL"
              size="lg"
              maxDecimals={6}
            />
          </div>
          <span className="value-sub">
            {valueFormatted} TTL · {ctx.value} wei
          </span>
        </div>

        {gasFormatted ? (
          <div className="row">
            <span className="label">{t('confirm.label.gas_estimate')}</span>
            <span className="origin tabular">{gasFormatted}</span>
          </div>
        ) : null}

        {ctx.chainId ? (
          <div className="row">
            <span className="label">{t('confirm.label.chain')}</span>
            <span className="origin">
              <span className="chain-chip">{ctx.chainId}</span>
            </span>
          </div>
        ) : null}

        {/* ERC-20 인자 파싱 결과: transfer/approve/transferFrom 각각에 대해
            사람이 읽을 수 있는 주소+금액을 직접 보여준다. raw calldata 만으로는
            대상 주소가 어디 박혀있는지 사용자가 식별하기 어렵다. */}
        {erc20 ? (
          <>
            {erc20.kind === 'transfer' ? (
              <>
                <div className="row">
                  <span className="label">{t('confirm.label.token_to')}</span>
                  <span className="addr" title={erc20.to}>{erc20.to}</span>
                </div>
                <div className="row">
                  <span className="label">{t('confirm.label.token_amount_raw')}</span>
                  <span className="value-sub tabular">{erc20.amount.toString()}</span>
                </div>
              </>
            ) : null}
            {erc20.kind === 'approve' ? (
              <>
                <div className="row">
                  <span className="label">{t('confirm.label.spender')}</span>
                  <span className="addr" title={erc20.spender}>{erc20.spender}</span>
                </div>
                <div className="row">
                  <span className="label">{t('confirm.label.allowance_raw')}</span>
                  <span className="value-sub tabular">{erc20.amount.toString()}</span>
                </div>
              </>
            ) : null}
            {erc20.kind === 'transferFrom' ? (
              <>
                <div className="row">
                  <span className="label">{t('confirm.label.token_from')}</span>
                  <span className="addr" title={erc20.from}>{erc20.from}</span>
                </div>
                <div className="row">
                  <span className="label">{t('confirm.label.token_to_arrow')}</span>
                  <span className="addr" title={erc20.to}>{erc20.to}</span>
                </div>
                <div className="row">
                  <span className="label">{t('confirm.label.token_amount_raw')}</span>
                  <span className="value-sub tabular">{erc20.amount.toString()}</span>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {unlimitedApprove ? (
          <p className="warn-banner">{t('confirm.warn.unlimited_approve')}</p>
        ) : null}

        {transferToZero ? (
          <p className="warn-banner danger">{t('confirm.warn.transfer_to_zero')}</p>
        ) : null}

        {transferToSelf ? (
          <p className="warn-banner">{t('confirm.warn.transfer_to_self')}</p>
        ) : null}

        {dataNonEmpty ? (
          <div className="row">
            <div className="label-row">
              <span className="label">{t('confirm.label.raw_calldata')}</span>
              {ctx.data.length > CALLDATA_TRUNC_AT ? (
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setShowFullData((v) => !v)}
                  disabled={awaiting}
                >
                  {showFullData ? t('confirm.label.collapse') : t('confirm.label.show_more')}
                </button>
              ) : null}
            </div>
            <div className="msg-block hex">{dataDisplay}</div>
            <span className="warn small">{t('confirm.warn.contract_call_side_effects')}</span>
          </div>
        ) : null}

        <p className="warn small">{t('confirm.warn.broadcast_irreversible')}</p>

        {/* 1시간 자동 승인 토글 — eth_sendTransaction 의 grant 는 method 레벨이므로
            이 사이트가 보낼 모든 트랜잭션(다른 to/value/data 포함) 이 자동 승인된다.
            사용자가 이 점을 정확히 알 수 있도록 별도 경고를 토글 바로 위에 표시. */}
        <p className="warn-banner">{t('confirm.warn.grant_send_tx')}</p>

        <ActionFooter
          method={ctx.method}
          remember={remember}
          setRemember={setRemember}
          approveLabel={t('confirm.btn.approve')}
          rejectLabel={t('confirm.btn.reject')}
          onApprove={() => onDecision('approve', remember)}
          onReject={() => onDecision('reject')}
          awaiting={awaiting}
        />
      </section>
    </main>
  );
}

// ── eth_signTypedData_v4 프리뷰 ───────────────────────────────────────
function SignTypedDataView({
  ctx,
  onDecision,
  awaiting,
}: {
  ctx: Extract<ConfirmContext, { method: 'eth_signTypedData_v4' }>;
  onDecision: (d: 'approve' | 'reject', rememberFor1h?: boolean) => void;
  awaiting: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [remember, setRemember] = useState(false);

  const chainIdLabel = useMemo(() => {
    if (ctx.domain.chainId === undefined || ctx.domain.chainId === null) return null;
    return String(ctx.domain.chainId);
  }, [ctx.domain.chainId]);

  // 위험 패턴: Permit(EIP-2612 권한 위임), Seaport(NFT 양도 위임), Unicode 동형이의어.
  const risks = useMemo(
    () =>
      detectTypedDataRisks({
        primaryType: ctx.primaryType,
        domainName: ctx.domain.name,
        verifyingContract: ctx.domain.verifyingContract,
      }),
    [ctx.primaryType, ctx.domain.name, ctx.domain.verifyingContract],
  );

  return (
    <main className="confirm">
      <BrandHeader />
      <section className="card">
        <h2>
          <span>{t('confirm.title.typed_data')}</span>
          <MethodTag tone="orange" label="eth_signTypedData_v4" />
        </h2>
        <p className="muted small">{t('confirm.lead.typed_data')}</p>

        <OriginRow origin={ctx.origin} />

        <SignerRow labelKey="confirm.label.signer" address={ctx.address} />

        <div className="row">
          <span className="label">{t('confirm.label.primary_type')}</span>
          <span className="origin">
            <span className="primary-type-chip">{ctx.primaryType}</span>
          </span>
        </div>

        {ctx.domain.name ? (
          <div className="row">
            <span className="label">{t('confirm.label.domain_name')}</span>
            <span className="origin">{ctx.domain.name}</span>
          </div>
        ) : null}

        {chainIdLabel ? (
          <div className="row">
            <span className="label">chainId</span>
            <span className="origin tabular">{chainIdLabel}</span>
          </div>
        ) : null}

        {ctx.domain.verifyingContract ? (
          <div className="row">
            <span className="label">verifyingContract</span>
            <a
              className="addr-link"
              href={`${TTL_EXPLORER}/address/${ctx.domain.verifyingContract}`}
              target="_blank"
              rel="noreferrer noopener"
              title={ctx.domain.verifyingContract}
            >
              {ctx.domain.verifyingContract}
            </a>
          </div>
        ) : null}

        <div className="row">
          <span className="label">{t('confirm.label.eip712_digest')}</span>
          <div className="msg-block hex">{ctx.digest}</div>
        </div>

        <div className="row">
          <div className="label-row">
            <span className="label">{t('confirm.label.message_content')}</span>
            <button
              className="btn-ghost btn-sm"
              onClick={() => setExpanded((v) => !v)}
              disabled={awaiting}
            >
              {expanded ? t('confirm.label.collapse') : t('confirm.label.expand')}
            </button>
          </div>
          {expanded ? (
            <div className="msg-block">{ctx.messageJson}</div>
          ) : (
            <span className="muted small">{t('confirm.label.expand_to_see')}</span>
          )}
        </div>

        {risks.includes('permit') ? (
          <p className="warn-banner danger">{t('confirm.warn.permit_risk')}</p>
        ) : null}

        {risks.includes('seaport') ? (
          <p className="warn-banner danger">{t('confirm.warn.seaport_risk')}</p>
        ) : null}

        {risks.includes('unicode') ? (
          <p className="warn-banner">{t('confirm.warn.unicode_risk')}</p>
        ) : null}

        <p className="warn small">{t('confirm.warn.typed_data')}</p>

        {/* 1시간 자동 승인 — typed-data 자체는 자유 형식이므로 매우 위험하다. */}
        <p className="warn-banner">{t('confirm.warn.grant_typed_data')}</p>

        <ActionFooter
          method={ctx.method}
          remember={remember}
          setRemember={setRemember}
          approveLabel={t('confirm.btn.approve')}
          rejectLabel={t('confirm.btn.reject')}
          onApprove={() => onDecision('approve', remember)}
          onReject={() => onDecision('reject')}
          awaiting={awaiting}
        />
      </section>
    </main>
  );
}
