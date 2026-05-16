import { useEffect, useState } from 'react';
import { useT } from '@nodong/i18n/react';
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
  | { kind: 'error'; messageKey: string }
  | { kind: 'submitted'; decision: 'approve' | 'reject' };

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

export function App() {
  const t = useT();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const requestId = getRequestIdFromUrl();
    const nonce = getNonceFromUrl();
    // 보안: nonce 가 없으면 dApp 이 직접 popup URL 을 연 시나리오. 친절한 안내 메시지.
    if (!requestId || !nonce) {
      setState({ kind: 'error', messageKey: 'connect.error.no_context' });
      return;
    }
    const msg: BackgroundMessage = { type: 'connect-context-get', requestId, nonce };
    chrome.runtime.sendMessage(msg, (ctx: ConnectContext | null) => {
      if (chrome.runtime.lastError) {
        setState({ kind: 'error', messageKey: 'connect.error.context_lookup_failed' });
        return;
      }
      if (!ctx) {
        // background 슬롯이 없거나 만료된 상태 — 또는 nonce 불일치(우회 시도).
        // 보안상 폴백으로 URL 의 origin 만 신뢰해 표시하지 않는다(스푸핑 방지).
        setState({ kind: 'error', messageKey: 'connect.error.expired' });
        return;
      }
      setState({ kind: 'ready', ctx });
    });
  }, []);

  function send(decision: 'approve' | 'reject'): void {
    const requestId = getRequestIdFromUrl();
    const nonce = getNonceFromUrl();
    if (!requestId || !nonce) return;
    const msg: BackgroundMessage = { type: 'connect-result', requestId, nonce, decision };
    chrome.runtime.sendMessage(msg, () => {
      setState({ kind: 'submitted', decision });
      // background 가 popup window 를 닫지만, 안전망으로 자체 close.
      setTimeout(() => window.close(), 200);
    });
  }

  if (state.kind === 'loading') {
    return (
      <main className="connect">
        <header className="brand">{t('brand.name')}</header>
        <p className="muted">{t('common.loading_ellipsis')}</p>
      </main>
    );
  }

  if (state.kind === 'error') {
    return (
      <main className="connect">
        <header className="brand">{t('brand.name')}</header>
        <section className="card">
          <h2>{t('connect.error_title')}</h2>
          <p className="error small">{t(state.messageKey)}</p>
          <button className="btn-ghost" onClick={() => window.close()}>
            {t('connect.close_window')}
          </button>
        </section>
      </main>
    );
  }

  if (state.kind === 'submitted') {
    return (
      <main className="connect">
        <header className="brand">{t('brand.name')}</header>
        <section className="card">
          <p>{state.decision === 'approve' ? t('connect.approved') : t('connect.rejected')}</p>
          <p className="muted small">{t('connect.closing_soon')}</p>
        </section>
      </main>
    );
  }

  const { ctx } = state;
  return (
    <main className="connect">
      <header className="brand">{t('brand.name')}</header>
      <section className="card">
        <h2>{t('connect.request_title')}</h2>
        <p className="muted small">{t('connect.request_lead')}</p>

        <div className="row">
          <span className="label">{t('connect.label.site')}</span>
          <span className="origin" title={ctx.origin}>{ctx.origin}</span>
        </div>

        <div className="row">
          <span className="label">{t('connect.label.shared_address')}</span>
          <span className="addr" title={ctx.address}>{shorten(ctx.address)}</span>
        </div>

        <p className="warn small">{t('connect.warn_post_approve')}</p>

        <div className="actions">
          <button className="btn-ghost" onClick={() => send('reject')}>
            {t('connect.reject')}
          </button>
          <button className="btn-primary" onClick={() => send('approve')}>
            {t('connect.approve')}
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
