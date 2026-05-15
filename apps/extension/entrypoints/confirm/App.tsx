import { useEffect, useMemo, useState } from 'react';
import { formatUnits, hexToString, hexToBytes, hexToNumber, isHex, type Hex } from 'viem';
import type { BackgroundMessage, ConfirmContext } from '../../src/lib/rpc.js';

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

const TTL_EXPLORER = 'https://scan.ttl1.top';

function getRequestIdFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('requestId');
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
    if (!requestId) {
      setState({ kind: 'error', message: '잘못된 서명 요청 (requestId 누락)' });
      return;
    }
    const msg: BackgroundMessage = { type: 'confirm-context-get', requestId };
    chrome.runtime.sendMessage(msg, (ctx: ConfirmContext | null) => {
      if (chrome.runtime.lastError) {
        setState({
          kind: 'error',
          message: chrome.runtime.lastError.message ?? '컨텍스트 조회 실패',
        });
        return;
      }
      if (!ctx) {
        setState({
          kind: 'error',
          message: '서명 요청이 만료되었거나 존재하지 않습니다',
        });
        return;
      }
      setState({ kind: 'ready', ctx });
    });
  }, []);

  function send(decision: 'approve' | 'reject'): void {
    const requestId = getRequestIdFromUrl();
    if (!requestId) return;
    const msg: BackgroundMessage = { type: 'confirm-result', requestId, decision };
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
  return <SendTxView ctx={ctx} onDecision={send} />;
}

// ── personal_sign 프리뷰 ─────────────────────────────────────────────
function PersonalSignView({
  ctx,
  onDecision,
}: {
  ctx: Extract<ConfirmContext, { method: 'personal_sign' }>;
  onDecision: (d: 'approve' | 'reject') => void;
}) {
  const readable = useMemo(() => tryHexToReadable(ctx.message), [ctx.message]);
  const byteLen = useMemo(() => messageBytesLen(ctx.message), [ctx.message]);

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

        <div className="actions">
          <button className="btn-ghost" onClick={() => onDecision('reject')}>
            거부
          </button>
          <button className="btn-primary" onClick={() => onDecision('approve')}>
            승인
          </button>
        </div>
      </section>
    </main>
  );
}

// ── eth_sendTransaction 프리뷰 ────────────────────────────────────────
function SendTxView({
  ctx,
  onDecision,
}: {
  ctx: Extract<ConfirmContext, { method: 'eth_sendTransaction' }>;
  onDecision: (d: 'approve' | 'reject') => void;
}) {
  const valueFormatted = useMemo(() => formatTtl(ctx.value), [ctx.value]);
  const gasFormatted = useMemo(() => formatGasUnits(ctx.gas), [ctx.gas]);
  const dataNonEmpty = ctx.data && ctx.data !== '0x' && ctx.data !== '';

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
          <span className="label">받는 주소</span>
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
          <span className="label">금액</span>
          <span className="value">{valueFormatted} TTL</span>
          <span className="value-sub">{ctx.value} wei</span>
        </div>

        {gasFormatted ? (
          <div className="row">
            <span className="label">가스 한도(예상)</span>
            <span className="origin">{gasFormatted}</span>
          </div>
        ) : null}

        {dataNonEmpty ? (
          <div className="row">
            <span className="label">데이터 (계약 호출)</span>
            <div className="msg-block hex">{ctx.data}</div>
            <span className="warn small">
              ※ 계약 호출은 v0.3 에서 지원됩니다. 현재는 단순 전송만 가능합니다.
            </span>
          </div>
        ) : null}

        <p className="warn small">
          ※ 승인 시 본 트랜잭션이 즉시 TTL 네트워크에 브로드캐스트됩니다. 이 결정은 되돌릴 수
          없습니다.
        </p>

        <div className="actions">
          <button className="btn-ghost" onClick={() => onDecision('reject')}>
            거부
          </button>
          <button className="btn-primary" onClick={() => onDecision('approve')}>
            승인
          </button>
        </div>
      </section>
    </main>
  );
}
