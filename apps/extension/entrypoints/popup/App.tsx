import { useCallback, useEffect, useState } from 'react';
import { createMnemonic, type HwAppName } from '@nodong/wallet-sdk';
import {
  connectHardware,
  disconnectHardware,
  getHwAccount,
  subscribeHwState,
  walletStore,
  type HwAccountState,
} from '../../src/lib/wallet-service.js';
import {
  listApprovedOrigins,
  revokeOrigin,
  type Origin,
} from '../../src/lib/origins.js';
import {
  listActiveGrants,
  revokeAllForOrigin,
  revokeGrant,
  type GrantMethod,
  type GrantRecord,
} from '../../src/lib/grants.js';

// 메서드별 사람이 읽는 라벨 — grants UI 용. confirm/App 의 METHOD_LABEL 과 의도적으로
// 별도(서로 다른 entrypoint 간 import 비용을 회피).
const METHOD_LABEL: Record<GrantMethod, string> = {
  personal_sign: '메시지 서명',
  eth_sendTransaction: '트랜잭션 전송',
  eth_signTypedData_v4: 'EIP-712 서명',
};

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
  // HW(하드웨어) 월릿 상태 — 소프트 월릿과 독립적으로 존재할 수 있다.
  const [hw, setHw] = useState<HwAccountState | null>(getHwAccount());
  const [hwBusy, setHwBusy] = useState<boolean>(false);

  // HW 상태 변경 구독 — connect/disconnect 시 자동 반영.
  useEffect(() => subscribeHwState(setHw), []);

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

  // 하드웨어 월릿 연결.
  //
  // v0.4 결정: 기본 앱은 Solana. Cosmos 도 같은 진입점에서 선택 가능하지만 UI 가
  // 단출해야 하므로 일단 Solana 만 첫 클릭 흐름으로 둔다. (사용자가 향후 Cosmos 를
  // 쓰려면 별도 토글이 필요 — TODO v0.5 chain-picker.)
  //
  // WebHID 사용자 흐름:
  //   1) 본 버튼은 *user gesture* 안에서 호출돼야 한다 (브라우저 보안 정책).
  //   2) navigator.hid.requestDevice({filters:[{vendorId: 0x2c97}]}) → Ledger
  //      Nano X/S+ 디바이스 선택 다이얼로그.
  //   3) 권한이 부여되면 같은 출처에서는 이후 자동 연결.
  //   4) 디바이스에서 Solana(또는 Cosmos) 앱이 *열려 있어야* 함.
  //   5) 디바이스 화면에 주소 확인 프롬프트 → 사용자가 양쪽 버튼으로 승인.
  async function handleHwConnect(appName: HwAppName = 'solana'): Promise<void> {
    setError(null);
    setHwBusy(true);
    try {
      await connectHardware(appName);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setHwBusy(false);
    }
  }

  async function handleHwDisconnect(): Promise<void> {
    setHwBusy(true);
    try {
      await disconnectHardware();
    } finally {
      setHwBusy(false);
    }
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
            <HwConnectPanel
              hw={hw}
              busy={hwBusy}
              onConnect={handleHwConnect}
              onDisconnect={handleHwDisconnect}
            />
          </section>
          <ConnectedSites />
        </>
      ) : mode === 'home' ? (
        <>
          <section className="card">
            <p>지갑이 없습니다.</p>
            <button className="btn-primary" onClick={handleCreate}>
              새 지갑 만들기
            </button>
            <button className="btn-ghost" onClick={() => setMode('restore')}>
              니모닉으로 복구
            </button>
            <HwConnectPanel
              hw={hw}
              busy={hwBusy}
              onConnect={handleHwConnect}
              onDisconnect={handleHwDisconnect}
            />
          </section>
        </>
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

// 하드웨어 월릿(Ledger) 연결 패널.
//
// v0.4 범위: Solana / Cosmos 만 지원. TTL(EVM) 은 Ledger Eth 앱이 digest 가 아닌
// 전체 raw tx 를 요구하므로, 우리 Wallet 의 sign-digest 루프와 호환되지 않는다 —
// v0.5 에서 Wallet 에 signTransaction 콜백을 추가한 뒤 활성화한다.
function HwConnectPanel({
  hw,
  busy,
  onConnect,
  onDisconnect,
}: {
  hw: HwAccountState | null;
  busy: boolean;
  onConnect: (appName: HwAppName) => void;
  onDisconnect: () => void;
}) {
  if (hw) {
    return (
      <div className="hw-panel" style={{ marginTop: 12 }}>
        <p className="muted small">하드웨어 월릿 · {hw.appName.toUpperCase()}</p>
        <p className="addr" title={hw.address}>{shortenAddress(hw.address)}</p>
        <p className="muted small">경로: {hw.derivationPath}</p>
        <button
          className="btn-ghost btn-sm"
          onClick={onDisconnect}
          disabled={busy}
        >
          하드웨어 분리
        </button>
      </div>
    );
  }
  return (
    <div className="hw-panel" style={{ marginTop: 12 }}>
      <button
        className="btn-ghost"
        onClick={() => onConnect('solana')}
        disabled={busy}
        title="Ledger Nano 를 USB 로 연결한 후 클릭"
      >
        {busy ? '연결 중…' : '하드웨어 월릿 연결 (Solana)'}
      </button>
      <button
        className="btn-ghost btn-sm"
        onClick={() => onConnect('cosmos')}
        disabled={busy}
        style={{ marginTop: 4 }}
      >
        {busy ? '연결 중…' : 'Cosmos 로 연결'}
      </button>
      <p className="muted small" style={{ marginTop: 4 }}>
        ※ TTL(EVM) 하드웨어 서명은 v0.5 예정입니다.
      </p>
    </div>
  );
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
    // origin 연결 해제 시 해당 origin 의 모든 method-grant 도 함께 제거.
    // 연결이 끊긴 상태에서 grant 만 살아남으면, 재연결 직후 사용자 의도와 다른 자동승인이
    // 일어날 수 있다 — 안전 우선.
    await revokeAllForOrigin(origin);
    await revokeOrigin(origin);
    refresh();
  }

  return (
    <>
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
      <ActiveGrants />
    </>
  );
}

// 활성(만료되지 않은) 자동 승인 grant 목록 + 개별 취소 버튼.
// grants 는 chrome.storage.session 에 들어 있으므로 잠금/재시작 시 자동 정리되지만,
// 사용자가 명시적으로 즉시 끊고 싶을 수 있다.
function ActiveGrants() {
  const [grants, setGrants] = useState<GrantRecord[] | null>(null);

  const refresh = useCallback(() => {
    listActiveGrants().then(setGrants);
  }, []);

  useEffect(() => {
    refresh();
    // session storage 변화에 반응. 다른 popup 인스턴스(또는 background 의 addGrant)에서
    // 추가/삭제되어도 즉시 반영.
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ): void => {
      if (area === 'session' && 'nd:method-grants' in changes) refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  async function handleRevoke(
    origin: string,
    method: GrantMethod,
    address: string,
  ): Promise<void> {
    await revokeGrant(origin, method, address);
    refresh();
  }

  return (
    <section className="card">
      <h3 className="section-title">자동 승인 (1시간)</h3>
      {grants === null ? (
        <p className="muted small">불러오는 중…</p>
      ) : grants.length === 0 ? (
        <p className="muted small">활성화된 자동 승인이 없습니다.</p>
      ) : (
        <ul className="origin-list">
          {grants.map((g) => {
            const remainMin = Math.max(
              0,
              Math.ceil((g.expiresAt - Date.now()) / 60_000),
            );
            return (
              <li
                key={`${g.origin}::${g.method}::${g.address}`}
                className="origin-row"
              >
                <div className="grant-info">
                  <span className="origin-text" title={g.origin}>{g.origin}</span>
                  <span className="muted small">
                    {METHOD_LABEL[g.method]} · {remainMin}분 남음
                  </span>
                </div>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    void handleRevoke(g.origin, g.method, g.address);
                  }}
                >
                  취소
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
