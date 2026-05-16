import { useEffect, useMemo, useState } from 'react';
import { formatUnits, hexToString, hexToBytes, hexToNumber, isHex, type Hex } from 'viem';
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
  | { kind: 'error'; message: string }
  | { kind: 'submitted'; decision: 'approve' | 'reject' };

// 메서드 라벨 — "1시간 기억" 체크박스 문구에 사용.
const METHOD_LABEL: Record<ConfirmContext['method'], string> = {
  personal_sign: '메시지 서명',
  eth_sendTransaction: '트랜잭션 전송',
  eth_signTypedData_v4: 'EIP-712 서명',
  wallet_watchAsset: '토큰 추가',
};

const TTL_EXPLORER = 'https://scan.ttl1.top';

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

function shorten(a: string): string {
  if (!a || a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
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
function formatTtl(weiHex: string): string {
  try {
    const v = BigInt(weiHex);
    const full = formatUnits(v, 18);
    // 소수점 자르기: 최대 6자리, 후행 0 제거.
    const dot = full.indexOf('.');
    if (dot < 0) return full;
    const trimmed = full.slice(0, dot + 7).replace(/0+$/, '').replace(/\.$/, '');
    return trimmed.length === 0 ? '0' : trimmed;
  } catch {
    return '(파싱 실패)';
  }
}

function formatGasUnits(gasHex: string | null): string | null {
  if (!gasHex) return null;
  try {
    return hexToNumber(gasHex as Hex).toLocaleString('ko-KR');
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

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const requestId = getRequestIdFromUrl();
    const nonce = getNonceFromUrl();
    // 보안: nonce 가 없으면 dApp 이 직접 popup URL 을 연 시나리오 — 친절한 안내.
    if (!requestId || !nonce) {
      setState({
        kind: 'error',
        message: '이 페이지는 지갑이 직접 열어야 합니다. 사이트에서 서명 요청을 다시 시도해 주세요.',
      });
      return;
    }
    const msg: BackgroundMessage = { type: 'confirm-context-get', requestId, nonce };
    chrome.runtime.sendMessage(msg, (ctx: ConfirmContext | null) => {
      if (chrome.runtime.lastError) {
        setState({
          kind: 'error',
          message: chrome.runtime.lastError.message ?? '컨텍스트 조회 실패',
        });
        return;
      }
      if (!ctx) {
        // nonce 불일치 또는 만료 — dApp 이 fake requestId 로 직접 connect 한 경우 포함.
        setState({
          kind: 'error',
          message: '서명 요청이 만료되었거나 존재하지 않습니다. 사이트에서 다시 요청해 주세요.',
        });
        return;
      }
      setState({ kind: 'ready', ctx });
    });
  }, []);

  function send(decision: 'approve' | 'reject', rememberFor1h = false): void {
    const requestId = getRequestIdFromUrl();
    const nonce = getNonceFromUrl();
    if (!requestId || !nonce) return;
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
        <header className="brand">노동자의 지갑</header>
        <p className="muted">불러오는 중…</p>
      </main>
    );
  }

  if (state.kind === 'error') {
    return (
      <main className="confirm">
        <header className="brand">노동자의 지갑</header>
        <section className="card">
          <h2>요청 오류</h2>
          <p className="error small">{state.message}</p>
          <div className="actions">
            <button className="btn-ghost" onClick={() => window.close()}>
              창 닫기
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (state.kind === 'submitted') {
    return (
      <main className="confirm">
        <header className="brand">노동자의 지갑</header>
        <section className="card">
          <p>{state.decision === 'approve' ? '승인했습니다.' : '거부했습니다.'}</p>
          <p className="muted small">잠시 후 창이 닫힙니다.</p>
        </section>
      </main>
    );
  }

  const { ctx } = state;
  if (ctx.method === 'personal_sign') return <PersonalSignView ctx={ctx} onDecision={send} />;
  if (ctx.method === 'eth_signTypedData_v4')
    return <SignTypedDataView ctx={ctx} onDecision={send} />;
  if (ctx.method === 'wallet_watchAsset')
    return <WatchAssetView ctx={ctx} onDecision={send} />;
  return <SendTxView ctx={ctx} onDecision={send} />;
}

// ── wallet_watchAsset 프리뷰 ───────────────────────────────────────────
// EIP-747: dApp 이 ERC-20 등 토큰을 본 지갑의 watch-list 에 등록 요청.
// 본 화면은 토큰 주소·심볼·소수자리 만 표시한다 — 자산 이동/서명이 일어나지
// 않으므로 위험도가 낮지만, 위조 토큰(예: 'USDC' 라는 심볼로 다른 컨트랙트)
// 을 추가하면 잔액 표시가 거짓될 수 있어 명시적 동의를 받는다.
function WatchAssetView({
  ctx,
  onDecision,
}: {
  ctx: Extract<ConfirmContext, { method: 'wallet_watchAsset' }>;
  onDecision: (d: 'approve' | 'reject', rememberFor1h?: boolean) => void;
}) {
  return (
    <main className="confirm">
      <header className="brand">노동자의 지갑</header>
      <section className="card">
        <h2>
          토큰 추가 요청
          <span className="hex-tag">wallet_watchAsset</span>
        </h2>
        <p className="muted small">
          아래 사이트가 본 지갑의 토큰 목록에 새 자산을 추가하려고 합니다.
        </p>

        <div className="row">
          <span className="label">사이트</span>
          <span className="origin" title={ctx.origin}>
            {ctx.origin}
          </span>
        </div>

        <div className="row">
          <span className="label">토큰 표준</span>
          <span className="origin">{ctx.type}</span>
        </div>

        <div className="row">
          <span className="label">토큰 주소</span>
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
          <span className="label">심볼</span>
          <span className="origin">
            <strong>{ctx.symbol}</strong>
          </span>
        </div>

        <div className="row">
          <span className="label">소수 자리(decimals)</span>
          <span className="origin">{ctx.decimals}</span>
        </div>

        <p className="warn small">
          ※ 토큰 추가는 자산 이동을 일으키지 않지만, 위조 토큰(예: 'USDC' 라는 심볼로
          전혀 다른 컨트랙트) 일 수 있으니 토큰 주소를 한 번 더 확인하세요.
        </p>

        <div className="actions">
          <button className="btn-ghost" onClick={() => onDecision('reject')}>
            거부
          </button>
          <button className="btn-primary" onClick={() => onDecision('approve')}>
            추가
          </button>
        </div>
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
  const label = METHOD_LABEL[method];
  return (
    <label className="remember-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="remember-text">
        이 사이트({label})에서 1시간 동안 자동 승인
      </span>
    </label>
  );
}

// ── personal_sign 프리뷰 ─────────────────────────────────────────────
function PersonalSignView({
  ctx,
  onDecision,
}: {
  ctx: Extract<ConfirmContext, { method: 'personal_sign' }>;
  onDecision: (d: 'approve' | 'reject', rememberFor1h?: boolean) => void;
}) {
  const readable = useMemo(() => tryHexToReadable(ctx.message), [ctx.message]);
  const byteLen = useMemo(() => messageBytesLen(ctx.message), [ctx.message]);
  const [remember, setRemember] = useState(false);

  return (
    <main className="confirm">
      <header className="brand">노동자의 지갑</header>
      <section className="card">
        <h2>
          메시지 서명 요청
          <span className="hex-tag">personal_sign</span>
        </h2>
        <p className="muted small">
          아래 사이트가 다음 메시지를 본 지갑으로 서명해 달라고 요청합니다.
        </p>

        <div className="row">
          <span className="label">사이트</span>
          <span className="origin" title={ctx.origin}>
            {ctx.origin}
          </span>
        </div>

        <div className="row">
          <span className="label">서명자</span>
          <span className="addr" title={ctx.address}>
            {shorten(ctx.address)}
          </span>
        </div>

        <div className="row">
          <span className="label">
            서명할 메시지 {readable ? `(${byteLen} 바이트)` : '(원시 hex)'}
          </span>
          <div className={readable ? 'msg-block' : 'msg-block hex'}>
            {readable ?? ctx.message}
          </div>
        </div>

        <p className="warn small">
          ※ 서명은 본 사이트가 본 주소의 소유를 증명하는 데 사용됩니다. 메시지 내용을 반드시
          확인하세요. 자산 이전이 일어나지는 않지만, 일부 dApp 은 서명을 권한 부여 수단으로
          사용합니다.
        </p>

        {/* 1시간 자동 승인 — personal_sign 의 grant 는 임의 메시지를 자동 서명하게 된다. */}
        <p className="warn small" style={{ background: '#fff7d6', padding: '6px', borderRadius: 4 }}>
          ※ "1시간 자동 승인" 을 켜면 이 사이트가 요청하는 <strong>모든 메시지</strong> 가
          자동으로 서명됩니다. 신뢰할 수 있는 사이트에서만 켜세요.
        </p>
        <RememberToggle method={ctx.method} checked={remember} onChange={setRemember} />

        <div className="actions">
          <button className="btn-ghost" onClick={() => onDecision('reject')}>
            거부
          </button>
          <button className="btn-primary" onClick={() => onDecision('approve', remember)}>
            승인
          </button>
        </div>
      </section>
    </main>
  );
}

// ── eth_sendTransaction 프리뷰 ────────────────────────────────────────
const CALLDATA_TRUNC_AT = 256;

function SendTxView({
  ctx,
  onDecision,
}: {
  ctx: Extract<ConfirmContext, { method: 'eth_sendTransaction' }>;
  onDecision: (d: 'approve' | 'reject', rememberFor1h?: boolean) => void;
}) {
  const valueFormatted = useMemo(() => formatTtl(ctx.value), [ctx.value]);
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

  return (
    <main className="confirm">
      <header className="brand">노동자의 지갑</header>
      <section className="card">
        <h2>
          전송 승인 요청
          <span className="hex-tag">eth_sendTransaction</span>
        </h2>
        <p className="muted small">아래 내용으로 트랜잭션을 전송합니다.</p>

        <div className="row">
          <span className="label">사이트</span>
          <span className="origin" title={ctx.origin}>
            {ctx.origin}
          </span>
        </div>

        <div className="row">
          <span className="label">보내는 주소</span>
          <span className="addr" title={ctx.from}>
            {shorten(ctx.from)}
          </span>
        </div>

        <div className="row">
          <span className="label">{dataNonEmpty ? '대상 계약' : '받는 주소'}</span>
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

        <div className="row">
          <span className="label">{dataNonEmpty ? '함께 전송할 native 값' : '금액'}</span>
          <span className="value">{valueFormatted} TTL</span>
          <span className="value-sub">{ctx.value} wei</span>
        </div>

        {gasFormatted ? (
          <div className="row">
            <span className="label">가스 한도(예상)</span>
            <span className="origin">{gasFormatted}</span>
          </div>
        ) : null}

        {dataNonEmpty && decoded ? (
          <div className="row">
            <span className="label">함수 호출 (4-byte 셀렉터)</span>
            <span className="origin">
              <strong>{decoded.selector}</strong>
              {decoded.signature ? (
                <> — {decoded.signature}</>
              ) : (
                <> — <em>(알 수 없는 함수 호출)</em></>
              )}
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
                  <span className="label">토큰 받는 주소</span>
                  <span className="addr" title={erc20.to}>{erc20.to}</span>
                </div>
                <div className="row">
                  <span className="label">토큰 수량 (raw)</span>
                  <span className="value-sub">{erc20.amount.toString()}</span>
                </div>
              </>
            ) : null}
            {erc20.kind === 'approve' ? (
              <>
                <div className="row">
                  <span className="label">권한 부여 대상(spender)</span>
                  <span className="addr" title={erc20.spender}>{erc20.spender}</span>
                </div>
                <div className="row">
                  <span className="label">권한 금액 (raw)</span>
                  <span className="value-sub">{erc20.amount.toString()}</span>
                </div>
              </>
            ) : null}
            {erc20.kind === 'transferFrom' ? (
              <>
                <div className="row">
                  <span className="label">토큰 보내는 주소(from)</span>
                  <span className="addr" title={erc20.from}>{erc20.from}</span>
                </div>
                <div className="row">
                  <span className="label">토큰 받는 주소(to)</span>
                  <span className="addr" title={erc20.to}>{erc20.to}</span>
                </div>
                <div className="row">
                  <span className="label">토큰 수량 (raw)</span>
                  <span className="value-sub">{erc20.amount.toString()}</span>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {unlimitedApprove ? (
          <p className="warn small" style={{ background: '#fff7d6', padding: '8px', borderRadius: 4 }}>
            ⚠ 무제한 권한 위임(approve) 이 감지되었습니다. 본 사이트(spender) 가 해당 토큰의
            잔고 전체를 언제든 인출할 수 있게 됩니다. 의도한 바가 아니라면 거부하세요.
          </p>
        ) : null}

        {transferToZero ? (
          <p className="warn small" style={{ background: '#ffe0e0', padding: '8px', borderRadius: 4 }}>
            ⚠ 받는 주소가 0x000…000(영주소) 입니다. 토큰을 영구적으로 소각하는 호출일 수
            있습니다. 정말 보낼 의도라면 다시 한 번 확인하세요.
          </p>
        ) : null}

        {transferToSelf ? (
          <p className="warn small" style={{ background: '#fff7d6', padding: '8px', borderRadius: 4 }}>
            ⚠ 받는 주소가 보내는 주소와 동일합니다. 일부 dApp 이 이런 패턴을 미끼로 사용하는
            경우가 있으니 의도를 다시 확인하세요.
          </p>
        ) : null}

        {dataNonEmpty ? (
          <div className="row">
            <span className="label">Raw calldata</span>
            <div className="msg-block hex">{dataDisplay}</div>
            {ctx.data.length > CALLDATA_TRUNC_AT ? (
              <button
                className="btn-ghost btn-sm"
                onClick={() => setShowFullData((v) => !v)}
              >
                {showFullData ? '접기' : '더 보기'}
              </button>
            ) : null}
            <span className="warn small">
              ※ 계약 호출은 자산 이동/권한 부여(approve) 등 부수효과가 있을 수 있습니다.
              함수 시그니처와 대상 계약을 반드시 확인하세요.
            </span>
          </div>
        ) : null}

        <p className="warn small">
          ※ 승인 시 본 트랜잭션이 즉시 TTL 네트워크에 브로드캐스트됩니다. 이 결정은 되돌릴 수
          없습니다.
        </p>

        {/* 1시간 자동 승인 토글 — eth_sendTransaction 의 grant 는 method 레벨이므로
            이 사이트가 보낼 모든 트랜잭션(다른 to/value/data 포함) 이 자동 승인된다.
            사용자가 이 점을 정확히 알 수 있도록 별도 경고를 토글 바로 위에 표시. */}
        <p className="warn small" style={{ background: '#fff7d6', padding: '6px', borderRadius: 4 }}>
          ※ "1시간 자동 승인" 을 켜면 이 사이트가 보내는 <strong>모든 트랜잭션</strong> 이
          (받는 주소·금액·calldata 와 관계없이) 자동 승인됩니다. 신뢰할 수 있는 사이트에서만
          켜세요.
        </p>
        <RememberToggle method={ctx.method} checked={remember} onChange={setRemember} />

        <div className="actions">
          <button className="btn-ghost" onClick={() => onDecision('reject')}>
            거부
          </button>
          <button className="btn-primary" onClick={() => onDecision('approve', remember)}>
            승인
          </button>
        </div>
      </section>
    </main>
  );
}

// ── eth_signTypedData_v4 프리뷰 ───────────────────────────────────────
function SignTypedDataView({
  ctx,
  onDecision,
}: {
  ctx: Extract<ConfirmContext, { method: 'eth_signTypedData_v4' }>;
  onDecision: (d: 'approve' | 'reject', rememberFor1h?: boolean) => void;
}) {
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
      <header className="brand">노동자의 지갑</header>
      <section className="card">
        <h2>
          EIP-712 서명 요청
          <span className="hex-tag">eth_signTypedData_v4</span>
        </h2>
        <p className="muted small">
          아래 사이트가 구조화된(typed) 데이터를 서명해 달라고 요청합니다.
        </p>

        <div className="row">
          <span className="label">사이트</span>
          <span className="origin" title={ctx.origin}>
            {ctx.origin}
          </span>
        </div>

        <div className="row">
          <span className="label">서명자</span>
          <span className="addr" title={ctx.address}>
            {shorten(ctx.address)}
          </span>
        </div>

        <div className="row">
          <span className="label">서명 대상 타입(primaryType)</span>
          <span className="origin">{ctx.primaryType}</span>
        </div>

        {ctx.domain.name ? (
          <div className="row">
            <span className="label">도메인 이름</span>
            <span className="origin">{ctx.domain.name}</span>
          </div>
        ) : null}

        {chainIdLabel ? (
          <div className="row">
            <span className="label">chainId</span>
            <span className="origin">{chainIdLabel}</span>
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
          <span className="label">서명 다이제스트 (EIP-712 hash)</span>
          <div className="msg-block hex">{ctx.digest}</div>
        </div>

        <div className="row">
          <div className="label-row">
            <span className="label">메시지 내용</span>
            <button
              className="btn-ghost btn-sm"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? '접기' : '펼치기'}
            </button>
          </div>
          {expanded ? (
            <div className="msg-block">{ctx.messageJson}</div>
          ) : (
            <span className="muted small">
              펼쳐서 dApp 이 서명을 요청한 데이터 전체를 확인하세요.
            </span>
          )}
        </div>

        {risks.includes('permit') ? (
          <p className="warn small" style={{ background: '#ffe0e0', padding: '8px', borderRadius: 4 }}>
            ⚠ 토큰 사용 권한 위임(Permit) 서명입니다. 본 서명을 제출하면 spender 가
            해당 토큰을 본 지갑에서 인출할 수 있게 됩니다. <strong>위조 사이트 주의</strong> —
            도메인과 spender 주소를 반드시 확인하세요.
          </p>
        ) : null}

        {risks.includes('seaport') ? (
          <p className="warn small" style={{ background: '#ffe0e0', padding: '8px', borderRadius: 4 }}>
            ⚠ Seaport(OpenSea) 주문 서명입니다. 본 서명은 NFT/토큰 양도 권한을 위임합니다.
            제출하면 되돌릴 수 없습니다. 메시지의 항목(offer/consideration) 을 반드시 확인하세요.
          </p>
        ) : null}

        {risks.includes('unicode') ? (
          <p className="warn small" style={{ background: '#fff7d6', padding: '8px', borderRadius: 4 }}>
            ⚠ 도메인 이름 또는 primaryType 에 ASCII 가 아닌 문자가 포함되어 있습니다. 익숙한
            서비스(예: "Permit") 와 비슷한 동형이의어(예: "Permіt", Cyrillic "і") 일 수 있으니
            서비스 이름의 철자를 다시 확인하세요.
          </p>
        ) : null}

        <p className="warn small">
          ※ EIP-712 서명은 자산 이동/권한 부여(예: Permit, Seaport 주문) 의 인증 수단으로
          쓰일 수 있습니다. 도메인과 메시지 내용을 반드시 확인하세요.
        </p>

        {/* 1시간 자동 승인 — typed-data 자체는 자유 형식이므로 매우 위험하다. 반드시
            "이 사이트가 다음 한 시간 동안 임의의 메시지를 자동 서명받게 된다" 임을 명시. */}
        <p className="warn small" style={{ background: '#fff7d6', padding: '6px', borderRadius: 4 }}>
          ※ "1시간 자동 승인" 을 켜면 이 사이트가 요청하는 <strong>모든 EIP-712 메시지</strong>
          (Permit 등 권한 위임 포함) 가 자동 서명됩니다. 신뢰할 수 있는 사이트에서만 켜세요.
        </p>
        <RememberToggle method={ctx.method} checked={remember} onChange={setRemember} />

        <div className="actions">
          <button className="btn-ghost" onClick={() => onDecision('reject')}>
            거부
          </button>
          <button className="btn-primary" onClick={() => onDecision('approve', remember)}>
            승인
          </button>
        </div>
      </section>
    </main>
  );
}
