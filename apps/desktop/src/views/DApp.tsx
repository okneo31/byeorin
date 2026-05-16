import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Input } from '@nodong/design-system';
import {
  WalletConnectSigner,
  signEvmMessage,
  type WcDelegate,
  type WcSession,
  type WcSessionProposal,
} from '@nodong/wallet-sdk';
import { hashTypedData, hexToBytes, bytesToHex, type Hex } from 'viem';
import { walletStore } from '../wallet-store.js';

interface Props {
  unlocked: boolean;
  onGoWallet: () => void;
}

// Reown projectId — every dApp/wallet needs one. We surface an env var so
// production builds can inject the real id, while dev falls back to a clearly
// labelled placeholder. The user-visible error message references the env
// var so an engineer hitting a broken pair() flow learns what to set.
//
// vite injects VITE_-prefixed env vars at build time (see vite.config.ts).
const PROJECT_ID =
  (import.meta.env.VITE_WC_PROJECT_ID as string | undefined) ??
  '__nodong_dev_placeholder__';

const WC_METADATA = {
  name: '노동자의 지갑 (Desktop)',
  description: 'TTL 생태계 멀티체인 월릿',
  url: 'https://ttl1.top',
  // Mutable array on purpose — Reown's metadata.icons is typed as
  // `string[]`, so `as const` would force a readonly mismatch.
  icons: ['https://ttl1.top/icon.png'],
};

type ProposalView = {
  proposal: WcSessionProposal;
  decide: (approve: boolean) => void;
};

export function DApp({ unlocked, onGoWallet }: Props) {
  const [signer, setSigner] = useState<WalletConnectSigner | null>(null);
  const [signerError, setSignerError] = useState<string | null>(null);
  const [uri, setUri] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WcSession[]>([]);
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const initRef = useRef(false);

  // One-time signer init. We delay until unlocked so the delegate has a
  // working wallet — pairing while locked would just queue requests that
  // can't be served.
  useEffect(() => {
    if (initRef.current || !unlocked) return;
    initRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const s = await WalletConnectSigner.create({
          projectId: PROJECT_ID,
          metadata: WC_METADATA,
          chainId: 7777,
        });
        if (cancelled) return;
        bindDelegate(s);
        s.onSessionProposal((p) => {
          // Park the proposal in UI state; resolve when the user clicks.
          return new Promise((resolve) => {
            setProposal({
              proposal: p,
              decide: async (approve) => {
                setProposal(null);
                if (!approve) {
                  resolve({ approved: [] });
                  return;
                }
                const account = await walletStore.getAccount();
                resolve({ approved: [`eip155:7777:${account.address}`] });
                // Refresh active session list after the dApp finishes its
                // approval round-trip.
                setTimeout(() => void refreshSessions(s), 500);
              },
            });
          });
        });
        setSigner(s);
        void refreshSessions(s);
      } catch (err) {
        if (cancelled) return;
        setSignerError(
          err instanceof Error ? err.message : '초기화 실패: ' + String(err),
        );
        // Re-arm so a future unlock retries.
        initRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unlocked]);

  const refreshSessions = useCallback(async (s: WalletConnectSigner) => {
    try {
      const list = await s.activeSessions();
      setSessions(list);
    } catch {
      // ignore — refresh is best-effort
    }
  }, []);

  const onPair = async () => {
    setPairError(null);
    if (!signer) {
      setPairError('지갑이 준비되지 않았습니다. 잠금을 해제해 주세요.');
      return;
    }
    const trimmed = uri.trim();
    if (!trimmed.startsWith('wc:')) {
      setPairError('wc: 로 시작하는 페어링 URI 를 붙여 넣어 주세요.');
      return;
    }
    setPairing(true);
    try {
      await signer.pair(trimmed);
      setUri('');
      // Sessions land asynchronously via the proposal handler — refresh
      // a moment later for the optimistic case where pair succeeded fast.
      setTimeout(() => void refreshSessions(signer), 1500);
    } catch (err) {
      setPairError(err instanceof Error ? err.message : String(err));
    } finally {
      setPairing(false);
    }
  };

  const onDisconnect = async (topic: string) => {
    if (!signer) return;
    try {
      await signer.disconnect(topic);
    } catch {
      // best-effort — the dApp may already have torn the session down
    }
    await refreshSessions(signer);
  };

  if (!unlocked) {
    return (
      <div className="nd-view">
        <header className="nd-view__header">
          <h1 className="nd-h1">dApp 연결</h1>
          <p className="nd-lead">먼저 지갑을 열거나 복원해 주세요.</p>
        </header>
        <Card as="section">
          <Button variant="primary" className="nd-button--block" onClick={onGoWallet}>
            지갑으로 이동
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">dApp 연결 (WalletConnect)</h1>
        <p className="nd-lead">
          dApp 에서 표시되는 wc: URI 를 아래에 붙여넣고 페어링을 시작합니다.
        </p>
      </header>

      {PROJECT_ID === '__nodong_dev_placeholder__' && (
        <Card as="section" style={{ marginBottom: 16 }}>
          <p className="nd-warn" style={{ margin: 0 }}>
            ⚠ Reown projectId 가 설정되지 않았습니다. <code>VITE_WC_PROJECT_ID</code>
            환경 변수를 설정하지 않으면 일부 dApp 페어링이 실패할 수 있습니다.
          </p>
        </Card>
      )}

      {signerError && (
        <Card as="section" style={{ marginBottom: 16 }}>
          <div className="nd-error">초기화 실패: {signerError}</div>
        </Card>
      )}

      <Card as="section">
        <Input
          id="wc-uri"
          label="페어링 URI"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder="wc:..."
          autoComplete="off"
          spellCheck={false}
          mono
        />
        {pairError && <div className="nd-error">{pairError}</div>}
        <div style={{ marginTop: 12 }}>
          <Button
            variant="primary"
            className="nd-button--block"
            onClick={onPair}
            loading={pairing}
            disabled={pairing || !signer}
          >
            {pairing ? '페어링 중…' : '페어링'}
          </Button>
        </div>
      </Card>

      {proposal && (
        <Card as="section" style={{ marginTop: 16 }}>
          <div className="nd-label">연결 요청</div>
          <p>
            <strong>{proposal.proposal.proposer.metadata.name}</strong> 가 본 지갑에
            연결을 요청합니다.
          </p>
          <p className="nd-muted">{proposal.proposal.proposer.metadata.url}</p>
          <p className="nd-muted small">
            요청 메서드: {proposal.proposal.requiredMethods.join(', ') || '(없음)'}
          </p>
          <div className="nd-row" style={{ marginTop: 12 }}>
            <Button variant="ghost" onClick={() => proposal.decide(false)}>
              거부
            </Button>
            <Button variant="primary" onClick={() => proposal.decide(true)}>
              승인
            </Button>
          </div>
        </Card>
      )}

      <Card as="section" style={{ marginTop: 16 }}>
        <div className="nd-label">활성 세션</div>
        {sessions.length === 0 ? (
          <p className="nd-muted">아직 연결된 dApp 이 없습니다.</p>
        ) : (
          <ul className="nd-wc-list">
            {sessions.map((s) => (
              <li key={s.topic} className="nd-wc-row">
                <div className="nd-wc-row__main">
                  <div className="nd-wc-row__title">{s.peer.name}</div>
                  <div className="nd-wc-row__sub">{s.peer.url}</div>
                  <div className="nd-wc-row__topic" title={s.topic}>
                    topic: {s.topic.slice(0, 12)}…
                  </div>
                </div>
                <Button variant="ghost" onClick={() => onDisconnect(s.topic)}>
                  연결 해제
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * Wire the SDK delegate into the desktop walletStore. The same code paths the
 * extension's background.ts uses (signEvmMessage / walletStore.transfer /
 * EvmAdapter.client) handle EVM JSON-RPC traffic — see
 * `wallet-sdk/src/dapp/walletconnect.ts::WcDelegate`.
 */
function bindDelegate(signer: WalletConnectSigner): void {
  const delegate: WcDelegate = {
    getActiveEvmAddress: async () => {
      const acc = await walletStore.getAccount();
      return acc.address;
    },
    personalSign: async (message: Hex, _address: string) => {
      const acc = await walletStore.getAccount();
      // signEvmMessage accepts UTF-8 string OR raw bytes. Reown forwards the
      // dApp's raw hex as-is, so decode to bytes before signing.
      return signEvmMessage(acc.signer, acc.address, hexToBytes(message));
    },
    signTypedData: async (typedData: unknown, _address: string) => {
      const acc = await walletStore.getAccount();
      const td = typedData as {
        domain?: unknown;
        types?: unknown;
        primaryType?: string;
        message?: unknown;
      };
      // viem.hashTypedData accepts both v3 and v4 typed-data shapes; we
      // pass through and rely on its validator.
      const digest = hashTypedData({
        domain: td.domain ?? {},
        types: td.types as Parameters<typeof hashTypedData>[0]['types'],
        primaryType: td.primaryType ?? '',
        message: td.message as Record<string, unknown>,
      } as Parameters<typeof hashTypedData>[0]);
      const sig = await acc.signer.sign(hexToBytes(digest));
      if (sig.length !== 65) throw new Error('signature length');
      const recovery = sig[64]!;
      const v = recovery <= 1 ? recovery + 27 : recovery;
      const out = new Uint8Array(65);
      out.set(sig.subarray(0, 64), 0);
      out[64] = v;
      return bytesToHex(out);
    },
    sendTransaction: async (tx) => {
      const valueWei = tx.value ? BigInt(tx.value) : 0n;
      const intent =
        tx.data && tx.data !== '0x'
          ? { to: tx.to, amount: valueWei, data: tx.data as Hex }
          : { to: tx.to, amount: valueWei };
      return walletStore.transfer(intent);
    },
    publicClient: () => {
      // EvmAdapter.client is private — TS narrows the intersection to `never`
      // when we try to widen it. We reach in via `unknown` cast so the WC
      // adapter can use the viem PublicClient for read-only RPC passthrough.
      // Other (non-EVM) default adapters fall through to `null`, at which
      // point the WC adapter emits a friendly error.
      const a = walletStore.getDefaultAdapter() as unknown as {
        client?: unknown;
      };
      return (a.client as ReturnType<WcDelegate['publicClient']>) ?? null;
    },
    chainId: () => 7777,
  };
  signer.bindDelegate(delegate);
}
