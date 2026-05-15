import { useEffect, useState } from 'react';
import type { BackgroundMessage, ConnectContext } from '../../src/lib/rpc.js';

// 노동자의 지갑 — 사이트 연결 동의 popup.
//
// background 가 chrome.windows.create('connect.html?origin=...&requestId=...') 로 띄운다.
// 본 화면은:
//  1) URL 의 requestId 로 background 에 컨텍스트(origin, address) 조회
//  2) 사용자에게 origin/address 표시
//  3) Approve/Reject 클릭 시 background 로 결과 전송

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; ctx: ConnectContext }
  | { kind: 'error'; message: string }
  | { kind: 'submitted'; decision: 'approve' | 'reject' };

function getRequestIdFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('requestId');
  } catch {
    return null;
  }
}

function getOriginFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('origin');
  } catch {
    return null;
  }
}

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const requestId = getRequestIdFromUrl();
    if (!requestId) {
      setState({ kind: 'error', message: '잘못된 연결 요청 (requestId 누락)' });
      return;
    }
    const msg: BackgroundMessage = { type: 'connect-context-get', requestId };
    chrome.runtime.sendMessage(msg, (ctx: ConnectContext | null) => {
      if (chrome.runtime.lastError) {
        setState({ kind: 'error', message: chrome.runtime.lastError.message ?? '컨텍스트 조회 실패' });
        return;
      }
      if (!ctx) {
        // background 슬롯이 없거나 만료된 상태 — URL 파라미터로 폴백 표시.
        const fallbackOrigin = getOriginFromUrl();
        if (fallbackOrigin) {
          setState({
            kind: 'ready',
            ctx: { requestId, origin: fallbackOrigin, address: '(로딩 실패)' },
          });
          return;
        }
        setState({ kind: 'error', message: '연결 요청이 만료되었거나 존재하지 않습니다' });
        return;
      }
      setState({ kind: 'ready', ctx });
    });
  }, []);

  function send(decision: 'approve' | 'reject'): void {
    const requestId = getRequestIdFromUrl();
    if (!requestId) return;
    const msg: BackgroundMessage = { type: 'connect-result', requestId, decision };
    chrome.runtime.sendMessage(msg, () => {
      setState({ kind: 'submitted', decision });
      // background 가 popup window 를 닫지만, 안전망으로 자체 close.
      setTimeout(() => window.close(), 200);
    });
  }

  if (state.kind === 'loading') {
    return (
      <main className="connect">
        <header className="brand">노동자의 지갑</header>
        <p className="muted">불러오는 중…</p>
      </main>
    );
  }

  if (state.kind === 'error') {
    return (
      <main className="connect">
        <header className="brand">노동자의 지갑</header>
        <section className="card">
          <h2>연결 요청 오류</h2>
          <p className="error small">{state.message}</p>
          <button className="btn-ghost" onClick={() => window.close()}>
            창 닫기
          </button>
        </section>
      </main>
    );
  }

  if (state.kind === 'submitted') {
    return (
      <main className="connect">
        <header className="brand">노동자의 지갑</header>
        <section className="card">
          <p>{state.decision === 'approve' ? '연결을 승인했습니다.' : '연결을 거부했습니다.'}</p>
          <p className="muted small">잠시 후 창이 닫힙니다.</p>
        </section>
      </main>
    );
  }

  const { ctx } = state;
  return (
    <main className="connect">
      <header className="brand">노동자의 지갑</header>
      <section className="card">
        <h2>사이트 연결 요청</h2>
        <p className="muted small">아래 사이트가 지갑 주소를 보려고 합니다.</p>

        <div className="row">
          <span className="label">사이트</span>
          <span className="origin" title={ctx.origin}>{ctx.origin}</span>
        </div>

        <div className="row">
          <span className="label">공유 주소</span>
          <span className="addr" title={ctx.address}>{shorten(ctx.address)}</span>
        </div>

        <p className="warn small">
          ※ 승인 시 이 사이트가 본 주소를 조회할 수 있으며, 거래/서명은 매번 별도 동의가 필요합니다.
          연결은 언제든 팝업에서 해제할 수 있습니다.
        </p>

        <div className="actions">
          <button className="btn-ghost" onClick={() => send('reject')}>
            거부
          </button>
          <button className="btn-primary" onClick={() => send('approve')}>
            연결 승인
          </button>
        </div>
      </section>
    </main>
  );
}

function shorten(a: string): string {
  if (!a || a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
