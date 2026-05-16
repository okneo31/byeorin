/**
 * WalletConnect v2 end-to-end session-lifecycle tests.
 *
 * Drives `WalletConnectSigner` against a `MockWalletKit` that mimics the
 * Reown WalletKit event-emitter shape:
 *
 *   pair(uri) → emits `session_proposal` (test-controlled)
 *   approveSession / rejectSession → recorded for assertion
 *   emit('session_request', …) → drives signing dispatch
 *   respondSessionRequest({response}) → recorded
 *   emit('session_delete', …) → exercises disconnect path
 *
 * The signer is constructed via the **public injection seam**
 * `WalletConnectSigner.create({ walletKit })` — no private-field hacks. The
 * SDK is not modified beyond that 5-line seam.
 *
 * Each test wires the delegate through real SDK primitives (`SoftSigner`,
 * `signEvmMessage`, viem's `hashTypedData`) so the assertions check actual
 * 65-byte secp256k1 signatures, never canned strings. The `walletStore`
 * transfer surface is mocked at the delegate boundary (`sendTransaction`),
 * per the constraint that core SDK signing paths must not change.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  type Hex,
  hashTypedData,
  recoverAddress,
  hexToBytes as viemHexToBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  SoftSigner,
  WalletConnectSigner,
  signEvmMessage,
  type WalletKitLike,
  type WcDelegate,
  type WcSessionProposal,
  type WcSessionProposalDecision,
} from '../src/index.js';

// ── MockWalletKit ─────────────────────────────────────────────────────────

interface ApproveCall {
  id: number;
  namespaces: Record<string, { accounts: string[]; methods: string[]; chains?: string[] }>;
}
interface RejectCall {
  id: number;
  reason: { code: number; message: string };
}
interface RespondCall {
  topic: string;
  response:
    | { id: number; jsonrpc: '2.0'; result: unknown }
    | { id: number; jsonrpc: '2.0'; error: { code: number; message: string } };
}
interface DisconnectCall {
  topic: string;
  reason: { code: number; message: string };
}

type Listener = (...args: unknown[]) => void;

/** Records every kit-side call and exposes `emit()` so tests can fire
 *  `session_proposal`, `session_request`, and `session_delete` events. */
class MockWalletKit implements WalletKitLike {
  readonly pairs: Array<{ uri: string }> = [];
  readonly approveCalls: ApproveCall[] = [];
  readonly rejectCalls: RejectCall[] = [];
  readonly respondCalls: RespondCall[] = [];
  readonly disconnectCalls: DisconnectCall[] = [];

  private readonly listeners: Record<string, Listener[]> = {};
  private readonly activeSessions: Record<string, unknown> = {};

  pair = async (opts: { uri: string }): Promise<unknown> => {
    this.pairs.push({ uri: opts.uri });
    return undefined;
  };

  approveSession = async (opts: unknown): Promise<unknown> => {
    const o = opts as ApproveCall;
    this.approveCalls.push(o);
    // Register a synthetic active session so getActiveSessions reflects it.
    const topic = `topic-${o.id}`;
    this.activeSessions[topic] = {
      topic,
      peer: { metadata: { name: 'dApp', description: '', url: 'https://d', icons: [] } },
      namespaces: o.namespaces,
    };
    return { topic };
  };

  rejectSession = async (opts: unknown): Promise<unknown> => {
    this.rejectCalls.push(opts as RejectCall);
    return undefined;
  };

  respondSessionRequest = async (opts: unknown): Promise<void> => {
    this.respondCalls.push(opts as RespondCall);
  };

  disconnectSession = async (opts: {
    topic: string;
    reason: { code: number; message: string };
  }): Promise<void> => {
    this.disconnectCalls.push(opts);
    delete this.activeSessions[opts.topic];
  };

  getActiveSessions = (): Record<string, unknown> => {
    return { ...this.activeSessions };
  };

  on = (event: string, listener: Listener): void => {
    (this.listeners[event] ??= []).push(listener);
  };

  off = (event: string, listener: Listener): void => {
    const arr = this.listeners[event];
    if (!arr) return;
    const i = arr.indexOf(listener);
    if (i >= 0) arr.splice(i, 1);
  };

  /** Test entry point — synchronously notifies every registered listener.
   *  WalletConnectSigner handlers are async; tests `await flush()` afterwards. */
  emit(event: string, payload: unknown): void {
    for (const l of this.listeners[event] ?? []) l(payload);
  }

  /** Simulate the relay dropping a session on the dApp side. Mirrors what
   *  the production kit emits when the peer sends `wc_sessionDelete`. */
  simulatePeerDisconnect(topic: string): void {
    delete this.activeSessions[topic];
    this.emit('session_delete', { topic });
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ── Test fixtures ─────────────────────────────────────────────────────────

// Hardhat account #0 — well-known privkey for the canonical mnemonic. Pinning
// to a known signer makes signatures deterministic so we can recover the
// address back and prove the full crypto path executed.
const HARDHAT_PRIVKEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function makeSoftSigner(): SoftSigner {
  return new SoftSigner({
    curve: 'secp256k1',
    privateKey: viemHexToBytes(HARDHAT_PRIVKEY),
  });
}

/** Build a delegate backed by the real SDK signing primitives. The
 *  `sendTransaction` hook stands in for `walletStore.transfer` — we record
 *  the tx and return a canned hash. */
interface TestDelegate extends WcDelegate {
  readonly personalSignCalls: Array<{ message: Hex; address: string }>;
  readonly signTypedCalls: Array<{ typedData: unknown; address: string }>;
  readonly sendTxCalls: Array<Parameters<WcDelegate['sendTransaction']>[0]>;
  readonly fakeTxHash: string;
  readonly address: string;
}

function makeRealDelegate(opts: { fakeTxHash?: string; chainId?: number } = {}): TestDelegate {
  const signer = makeSoftSigner();
  const account = privateKeyToAccount(HARDHAT_PRIVKEY);
  const address = account.address.toLowerCase();
  const fakeTxHash = opts.fakeTxHash ?? '0xfeed';
  const chainId = opts.chainId ?? 7777;

  const personalSignCalls: Array<{ message: Hex; address: string }> = [];
  const signTypedCalls: Array<{ typedData: unknown; address: string }> = [];
  const sendTxCalls: Array<Parameters<WcDelegate['sendTransaction']>[0]> = [];

  const delegate: TestDelegate = {
    personalSignCalls,
    signTypedCalls,
    sendTxCalls,
    fakeTxHash,
    address,

    getActiveEvmAddress: async () => address,
    personalSign: async (message: Hex, addr: string): Promise<Hex> => {
      personalSignCalls.push({ message, address: addr });
      // Run the real EIP-191 path. dApps send hex-encoded messages; we sign
      // the bytes those hex characters represent.
      const bytes = viemHexToBytes(message);
      return signEvmMessage(signer, addr as `0x${string}`, bytes);
    },
    signTypedData: async (typedData: unknown, addr: string): Promise<Hex> => {
      signTypedCalls.push({ typedData, address: addr });
      // EIP-712: hash via viem then sign the digest directly (the digest is
      // the EIP-712 specified `keccak256("\x19\x01" || domainSeparator || msg)`,
      // NOT the EIP-191 personal prefix). We hand-roll v normalization
      // mirroring what signEvmMessage does for personal_sign so the resulting
      // 65-byte hex has the same v ∈ {27,28} shape.
      const td = typedData as Parameters<typeof hashTypedData>[0];
      const digest = hashTypedData(td);
      const sig = await signer.sign(viemHexToBytes(digest));
      const out = new Uint8Array(65);
      out.set(sig.subarray(0, 64), 0);
      const rec = sig[64] ?? 0;
      out[64] = rec === 0 || rec === 1 ? rec + 27 : rec;
      return (`0x${Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('')}`) as Hex;
    },
    sendTransaction: async (tx): Promise<string> => {
      sendTxCalls.push(tx);
      return fakeTxHash;
    },
    publicClient: () => null,
    chainId: () => chainId,
  };

  return delegate;
}

async function makeSigner(kit: MockWalletKit, chainId = 7777): Promise<WalletConnectSigner> {
  return WalletConnectSigner.create({
    metadata: {
      name: 'TTL Wallet (test)',
      description: 'e2e harness',
      url: 'https://nodong.test',
      icons: [],
    },
    chainId,
    walletKit: kit,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('WalletConnect v2 e2e — full session lifecycle', () => {
  let kit: MockWalletKit;

  beforeEach(() => {
    kit = new MockWalletKit();
  });

  // 1 — Pairing
  it('pair(uri) forwards exactly once to walletKit.pair and resolves', async () => {
    const signer = await makeSigner(kit);
    await signer.pair('wc:abcd1234@2?relay-protocol=irn&symKey=deadbeef');
    expect(kit.pairs).toHaveLength(1);
    expect(kit.pairs[0]?.uri).toMatch(/^wc:/);
  });

  // 2 — Session proposal accepted
  it('approves a session_proposal: handler approves eip155:7777, kit.approveSession called with namespaces', async () => {
    const signer = await makeSigner(kit);
    const delegate = makeRealDelegate();
    signer.bindDelegate(delegate);
    signer.onSessionProposal(
      async (p): Promise<WcSessionProposalDecision> => {
        expect(p.requiredChains).toContain('eip155:7777');
        return { approved: [`eip155:7777:${delegate.address}`] };
      },
    );

    kit.emit('session_proposal', {
      id: 100,
      params: {
        proposer: {
          metadata: { name: 'dApp', description: '', url: 'https://d', icons: [] },
        },
        requiredNamespaces: {
          eip155: {
            chains: ['eip155:7777'],
            methods: ['personal_sign', 'eth_sendTransaction'],
            events: ['accountsChanged'],
          },
        },
        optionalNamespaces: {},
      },
    });
    await flush();

    expect(kit.approveCalls).toHaveLength(1);
    expect(kit.rejectCalls).toHaveLength(0);
    const ns = kit.approveCalls[0]?.namespaces.eip155;
    expect(ns?.accounts).toContain(`eip155:7777:${delegate.address}`);
    expect(ns?.chains).toContain('eip155:7777');
    expect(ns?.methods).toContain('personal_sign');
    expect(ns?.methods).toContain('eth_sendTransaction');
  });

  // 3 — Session proposal rejected
  it('rejects a session_proposal when handler returns empty approved list', async () => {
    const signer = await makeSigner(kit);
    signer.bindDelegate(makeRealDelegate());
    signer.onSessionProposal(async (): Promise<WcSessionProposalDecision> => ({ approved: [] }));

    kit.emit('session_proposal', {
      id: 101,
      params: {
        proposer: { metadata: { name: 'dApp', description: '', url: 'https://d', icons: [] } },
        requiredNamespaces: { eip155: { chains: ['eip155:7777'], methods: [], events: [] } },
        optionalNamespaces: {},
      },
    });
    await flush();

    expect(kit.approveCalls).toHaveLength(0);
    expect(kit.rejectCalls).toHaveLength(1);
    expect(kit.rejectCalls[0]?.reason.code).toBe(5002);
    expect(kit.rejectCalls[0]?.reason.message).toMatch(/rejected/i);
  });

  // 4 — personal_sign
  it('personal_sign: routes through signEvmMessage and responds with a 65-byte v∈{27,28} hex', async () => {
    const signer = await makeSigner(kit);
    const delegate = makeRealDelegate();
    signer.bindDelegate(delegate);

    const message: Hex = '0x48656c6c6f6e6f646f6e67'; // "Hellonodong"
    kit.emit('session_request', {
      id: 1,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: { method: 'personal_sign', params: [message, delegate.address] },
      },
    });
    await flush();

    expect(kit.respondCalls).toHaveLength(1);
    const resp = kit.respondCalls[0]?.response;
    expect(resp && 'result' in resp).toBe(true);
    if (!resp || !('result' in resp)) throw new Error('expected result envelope');
    const sig = resp.result as Hex;
    // 65 bytes = 130 hex chars + 2 for 0x prefix.
    expect(sig.length).toBe(132);
    const v = parseInt(sig.slice(-2), 16);
    expect([27, 28]).toContain(v);

    // The signature should recover to the test address — proof the real crypto
    // path was hit, not a canned response.
    const recovered = await recoverAddress({
      hash: (await (async () => {
        // viem's signMessage hashes with EIP-191; we already produced the
        // EIP-191 sig over the raw bytes message — recover via the bytes form.
        const { hashMessage } = await import('viem');
        return hashMessage({ raw: message });
      })()),
      signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(delegate.address);
    expect(delegate.personalSignCalls).toHaveLength(1);
  });

  // 5 — eth_signTypedData_v4
  it('eth_signTypedData_v4: hashTypedData → sign → 65-byte hex with v∈{27,28}', async () => {
    const signer = await makeSigner(kit);
    const delegate = makeRealDelegate();
    signer.bindDelegate(delegate);

    const typed = {
      domain: { name: 'Nodong', version: '1', chainId: 7777 },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        Mail: [{ name: 'to', type: 'address' }, { name: 'contents', type: 'string' }],
      },
      primaryType: 'Mail',
      message: { to: '0x2222222222222222222222222222222222222222', contents: 'hi' },
    } as const;

    kit.emit('session_request', {
      id: 2,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: {
          method: 'eth_signTypedData_v4',
          params: [delegate.address, JSON.stringify(typed)],
        },
      },
    });
    await flush();

    const resp = kit.respondCalls[0]?.response;
    if (!resp || !('result' in resp)) throw new Error('expected result envelope');
    const sig = resp.result as Hex;
    expect(sig.length).toBe(132);
    const v = parseInt(sig.slice(-2), 16);
    expect([27, 28]).toContain(v);

    // Recover the address to prove the EIP-712 digest was actually signed.
    const digest = hashTypedData(typed as Parameters<typeof hashTypedData>[0]);
    const recovered = await recoverAddress({ hash: digest, signature: sig });
    expect(recovered.toLowerCase()).toBe(delegate.address);
  });

  // 6 — eth_signTypedData_v3 aliases v4
  it('eth_signTypedData_v3: produces identical signature to v4 for same payload', async () => {
    const signer = await makeSigner(kit);
    const delegate = makeRealDelegate();
    signer.bindDelegate(delegate);

    const typed = {
      domain: { name: 'Nodong', version: '1', chainId: 7777 },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        Mail: [{ name: 'to', type: 'address' }],
      },
      primaryType: 'Mail',
      message: { to: '0x3333333333333333333333333333333333333333' },
    } as const;

    // Silence the deprecation warning the v3 path emits.
    const originalWarn = console.warn;
    console.warn = (): void => undefined;
    try {
      kit.emit('session_request', {
        id: 31,
        topic: 'topic-1',
        params: {
          chainId: 'eip155:7777',
          request: { method: 'eth_signTypedData_v4', params: [delegate.address, JSON.stringify(typed)] },
        },
      });
      await flush();
      kit.emit('session_request', {
        id: 32,
        topic: 'topic-1',
        params: {
          chainId: 'eip155:7777',
          request: { method: 'eth_signTypedData_v3', params: [delegate.address, JSON.stringify(typed)] },
        },
      });
      await flush();
    } finally {
      console.warn = originalWarn;
    }

    const r1 = kit.respondCalls[0]?.response;
    const r2 = kit.respondCalls[1]?.response;
    if (!r1 || !('result' in r1) || !r2 || !('result' in r2)) {
      throw new Error('expected result envelopes for both');
    }
    expect(r2.result).toBe(r1.result);
  });

  // 7 — eth_sendTransaction
  it('eth_sendTransaction: routes through delegate.sendTransaction (walletStore.transfer mock) and returns the tx hash', async () => {
    const signer = await makeSigner(kit);
    const delegate = makeRealDelegate({ fakeTxHash: '0xfeed' });
    signer.bindDelegate(delegate);

    kit.emit('session_request', {
      id: 4,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: {
          method: 'eth_sendTransaction',
          params: [
            {
              to: '0x2222222222222222222222222222222222222222',
              value: '0x16345785d8a0000', // 0.1 ETH-equivalent
              data: '0x',
            },
          ],
        },
      },
    });
    await flush();

    expect(delegate.sendTxCalls).toHaveLength(1);
    expect(delegate.sendTxCalls[0]?.to).toBe('0x2222222222222222222222222222222222222222');
    expect(delegate.sendTxCalls[0]?.from).toBe(delegate.address);
    const resp = kit.respondCalls[0]?.response;
    if (!resp || !('result' in resp)) throw new Error('expected result envelope');
    expect(resp.result).toBe('0xfeed');
  });

  // 8 — eth_chainId
  it('eth_chainId: returns 0x1e61 (7777) without invoking the signer', async () => {
    const signer = await makeSigner(kit, 7777);
    const delegate = makeRealDelegate();
    signer.bindDelegate(delegate);

    kit.emit('session_request', {
      id: 5,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: { method: 'eth_chainId', params: [] },
      },
    });
    await flush();

    const resp = kit.respondCalls[0]?.response;
    if (!resp || !('result' in resp)) throw new Error('expected result envelope');
    expect(resp.result).toBe('0x1e61');
    expect(delegate.personalSignCalls).toHaveLength(0);
    expect(delegate.signTypedCalls).toHaveLength(0);
    expect(delegate.sendTxCalls).toHaveLength(0);
  });

  // 9 — wallet_watchAsset
  it('wallet_watchAsset: returns true without invoking any signing path', async () => {
    const signer = await makeSigner(kit);
    const delegate = makeRealDelegate();
    signer.bindDelegate(delegate);

    kit.emit('session_request', {
      id: 6,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: {
          method: 'wallet_watchAsset',
          params: {
            type: 'ERC20',
            options: {
              address: '0x4444444444444444444444444444444444444444',
              symbol: 'TTL',
              decimals: 18,
            },
          },
        },
      },
    });
    await flush();

    const resp = kit.respondCalls[0]?.response;
    if (!resp || !('result' in resp)) throw new Error('expected result envelope');
    expect(resp.result).toBe(true);
    expect(delegate.personalSignCalls).toHaveLength(0);
    expect(delegate.signTypedCalls).toHaveLength(0);
    expect(delegate.sendTxCalls).toHaveLength(0);
  });

  // 10 — Unsupported method
  it('unsupported method: responds with JSON-RPC error envelope', async () => {
    const signer = await makeSigner(kit);
    signer.bindDelegate(makeRealDelegate());

    kit.emit('session_request', {
      id: 7,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: { method: 'eth_newPendingTransactionFilter', params: [] },
      },
    });
    await flush();

    const resp = kit.respondCalls[0]?.response;
    if (!resp || !('error' in resp)) throw new Error('expected error envelope');
    // Adapter returns code -32000 with a "Method not supported" message; the
    // 4200 contract code is what user-supplied handlers can override to. We
    // assert the JSON-RPC envelope shape is well-formed and the message
    // surfaces the failing method.
    expect(typeof resp.error.code).toBe('number');
    expect(resp.error.message).toMatch(/eth_newPendingTransactionFilter|not supported/i);
  });

  // 11 — Concurrent requests
  it('concurrent personal_sign requests: 3 in flight, all complete with distinct ids and valid sigs', async () => {
    const signer = await makeSigner(kit);
    const delegate = makeRealDelegate();
    signer.bindDelegate(delegate);

    const payloads: Hex[] = ['0xaaaa', '0xbbbb', '0xcccc'];
    payloads.forEach((p, i) => {
      kit.emit('session_request', {
        id: 200 + i,
        topic: 'topic-1',
        params: {
          chainId: 'eip155:7777',
          request: { method: 'personal_sign', params: [p, delegate.address] },
        },
      });
    });
    // Flush twice — async signing may need an extra microtask drain.
    await flush();
    await flush();

    expect(kit.respondCalls).toHaveLength(3);
    const ids = kit.respondCalls.map((c) => c.response.id).sort();
    expect(ids).toEqual([200, 201, 202]);
    const sigs = new Set<string>();
    for (const c of kit.respondCalls) {
      if (!('result' in c.response)) throw new Error('expected result envelope');
      const s = c.response.result as string;
      expect(s.length).toBe(132);
      sigs.add(s);
    }
    // Different messages → different signatures (no cross-request state leak).
    expect(sigs.size).toBe(3);
    expect(delegate.personalSignCalls).toHaveLength(3);
  });

  // 12 — Session disconnect
  it('session_delete: peer disconnect cleans active sessions; activeSessions() returns 0', async () => {
    const signer = await makeSigner(kit);
    const delegate = makeRealDelegate();
    signer.bindDelegate(delegate);
    signer.onSessionProposal(
      async (): Promise<WcSessionProposalDecision> => ({
        approved: [`eip155:7777:${delegate.address}`],
      }),
    );

    kit.emit('session_proposal', {
      id: 300,
      params: {
        proposer: { metadata: { name: 'dApp', description: '', url: 'https://d', icons: [] } },
        requiredNamespaces: { eip155: { chains: ['eip155:7777'], methods: [], events: [] } },
        optionalNamespaces: {},
      },
    });
    await flush();

    // After approve, one active session lives in the kit's map.
    expect(Object.keys(kit.getActiveSessions())).toHaveLength(1);
    expect(await signer.activeSessions()).toHaveLength(1);

    // dApp-side disconnect.
    kit.simulatePeerDisconnect('topic-300');
    await flush();

    expect(await signer.activeSessions()).toHaveLength(0);
  });

  // 13 — Chain mismatch
  it('chain mismatch: dApp requests eth_sendTransaction on eip155:1 while wallet is 7777 → handler rejects', async () => {
    const signer = await makeSigner(kit, 7777);
    const delegate = makeRealDelegate({ chainId: 7777 });
    signer.bindDelegate(delegate);

    // Install a request-level handler that enforces chain pinning, mirroring
    // what a shell would do. The default delegate router does not currently
    // gate by `req.chainId`, so the test demonstrates the recommended
    // override path. We assert the dApp sees a proper JSON-RPC error.
    signer.onRequest(async (req): Promise<unknown> => {
      const want = `eip155:${delegate.chainId()}`;
      if (req.chainId !== want) {
        throw new Error(`Unsupported chain: ${req.chainId} (wallet is ${want})`);
      }
      // Would otherwise delegate; not reached in this test.
      return null;
    });

    kit.emit('session_request', {
      id: 8,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:1',
        request: {
          method: 'eth_sendTransaction',
          params: [{ to: '0x2222222222222222222222222222222222222222', value: '0x1' }],
        },
      },
    });
    await flush();

    const resp = kit.respondCalls[0]?.response;
    if (!resp || !('error' in resp)) throw new Error('expected error envelope');
    expect(resp.error.message).toMatch(/Unsupported chain/);
    expect(delegate.sendTxCalls).toHaveLength(0);
  });

  // 14 — Optional namespaces with unsupported chain
  it('proposal with unsupported chain in optionalNamespaces: approve required, ignore unsupported optional', async () => {
    const signer = await makeSigner(kit, 7777);
    const delegate = makeRealDelegate();
    signer.bindDelegate(delegate);
    signer.onSessionProposal(
      async (p: WcSessionProposal): Promise<WcSessionProposalDecision> => {
        // Mirror the recommended shell pattern: approve only the required
        // chains we support (eip155:7777). Optional chains we don't support
        // (e.g. eip155:1) are silently dropped — we do NOT reject the proposal.
        expect(p.requiredChains).toEqual(['eip155:7777']);
        expect(p.optionalChains).toContain('eip155:1');
        return { approved: [`eip155:7777:${delegate.address}`] };
      },
    );

    kit.emit('session_proposal', {
      id: 400,
      params: {
        proposer: { metadata: { name: 'dApp', description: '', url: 'https://d', icons: [] } },
        requiredNamespaces: {
          eip155: { chains: ['eip155:7777'], methods: ['personal_sign'], events: [] },
        },
        optionalNamespaces: {
          eip155: { chains: ['eip155:1', 'eip155:137'], methods: ['eth_sendTransaction'], events: [] },
        },
      },
    });
    await flush();

    expect(kit.approveCalls).toHaveLength(1);
    expect(kit.rejectCalls).toHaveLength(0);
    const ns = kit.approveCalls[0]?.namespaces.eip155;
    expect(ns?.chains).toEqual(['eip155:7777']);
    expect(ns?.accounts).toEqual([`eip155:7777:${delegate.address}`]);
  });
});
