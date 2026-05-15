import { useCallback, useEffect, useState } from 'react';
import { createMnemonic } from '@nodong/wallet-sdk';
import { walletStore } from '../../src/lib/wallet-service.js';
import {
  listApprovedOrigins,
  revokeOrigin,
  type Origin,
} from '../../src/lib/origins.js';

// 노동자의 지갑 — 확장 팝업.
// 셸 수준: 없음 → 생성/복구 → 상태표시 → 로그아웃.
// v0.1: 평문 니모닉을 chrome.storage.session(휘발) 에만 저장 — 모든 라이프사이클은
//       @nodong/shell-core 의 WalletStore 가 담당.
// TODO(v0.2): passphrase + scrypt + AES-GCM keystore 도입.

type Mode = 'home' | 'create' | 'restore';

export function App() {
  const [address, setAddress] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('home');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 부팅 시 chrome.storage.session 으로부터 자동 복원 시도(extension 은 허용).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await walletStore.tryAutoRestore();
      if (walletStore.isUnlocked()) {
        const acc = await walletStore.getAccount();
        if (!cancelled) setAddress(acc.address);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(): Promise<void> {
    setError(null);
    try {
      const mnemonic = createMnemonic(128, 'english');
      await walletStore.unlock(mnemonic);
      const acc = await walletStore.getAccount();
      setAddress(acc.address);
      setMode('home');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleRestore(mnemonic: string): Promise<void> {
    setError(null);
    try {
      await walletStore.unlock(mnemonic);
      const acc = await walletStore.getAccount();
      setAddress(acc.address);
      setMode('home');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleLogout(): Promise<void> {
    await walletStore.lock();
    setAddress(null);
    setMode('home');
  }

  if (loading) {
    return (
      <main className="popup">
        <header className="brand">노동자의 지갑</header>
        <p className="muted">불러오는 중…</p>
      </main>
    );
  }

  return (
    <main className="popup">
      <header className="brand">노동자의 지갑</header>

      {address ? (
        <>
          <section className="card">
            <p className="muted small">TTL · chainId 7777</p>
            <p className="addr" title={address}>{shortenAddress(address)}</p>
            <button className="btn-ghost" onClick={handleLogout}>
              로그아웃
            </button>
            <p className="warn small">
              ※ 본 버전은 니모닉이 세션 메모리에만 저장됩니다. 브라우저 재시작 시 다시 복구가 필요합니다.
            </p>
          </section>
          <ConnectedSites />
        </>
      ) : mode === 'home' ? (
        <section className="card">
          <p>지갑이 없습니다.</p>
          <button className="btn-primary" onClick={handleCreate}>
            새 지갑 만들기
          </button>
          <button className="btn-ghost" onClick={() => setMode('restore')}>
            니모닉으로 복구
          </button>
        </section>
      ) : mode === 'create' ? (
        <CreatePane onConfirm={handleCreate} onCancel={() => setMode('home')} />
      ) : (
        <RestorePane onSubmit={handleRestore} onCancel={() => setMode('home')} />
      )}

      {error ? <p className="error small">{error}</p> : null}
      <footer className="muted small">v0.1 skeleton · 비수탁</footer>
    </main>
  );
}

function CreatePane({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <section className="card">
      <p>새 12단어 니모닉이 생성됩니다.</p>
      <p className="warn small">
        니모닉을 노출하는 별도 화면은 v0.2 에서 제공됩니다. 지금은 셸 수준 검증만 수행합니다.
      </p>
      <button className="btn-primary" onClick={onConfirm}>
        생성
      </button>
      <button className="btn-ghost" onClick={onCancel}>
        취소
      </button>
    </section>
  );
}

function RestorePane({
  onSubmit,
  onCancel,
}: {
  onSubmit: (mnemonic: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <section className="card">
      <label className="muted small" htmlFor="m">
        니모닉 (12 또는 24 단어)
      </label>
      <textarea
        id="m"
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="단어를 공백으로 구분하여 입력"
      />
      <button className="btn-primary" onClick={() => onSubmit(text)}>
        복구
      </button>
      <button className="btn-ghost" onClick={onCancel}>
        취소
      </button>
    </section>
  );
}

function shortenAddress(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// 연결된 사이트(승인된 origin) 목록 + 연결 해제 UI.
// chrome.storage.local('nd:approved-origins') 에서만 origin 문자열을 다룬다.
function ConnectedSites() {
  const [origins, setOrigins] = useState<Origin[] | null>(null);

  const refresh = useCallback(() => {
    listApprovedOrigins().then(setOrigins);
  }, []);

  useEffect(() => {
    refresh();
    // storage 변경 시 자동 새로고침.
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ): void => {
      if (area === 'local' && 'nd:approved-origins' in changes) refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  async function handleRevoke(origin: Origin): Promise<void> {
    await revokeOrigin(origin);
    refresh();
  }

  return (
    <section className="card">
      <h3 className="section-title">연결된 사이트 관리</h3>
      {origins === null ? (
        <p className="muted small">불러오는 중…</p>
      ) : origins.length === 0 ? (
        <p className="muted small">연결된 사이트가 없습니다.</p>
      ) : (
        <ul className="origin-list">
          {origins.map((o) => (
            <li key={o} className="origin-row">
              <span className="origin-text" title={o}>{o}</span>
              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  void handleRevoke(o);
                }}
              >
                연결 해제
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
