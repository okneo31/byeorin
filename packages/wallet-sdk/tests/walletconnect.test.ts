/**
 * WalletConnectSigner — adapter-level routing tests.
 *
 * We do NOT exercise the Reown SDK transport here (relays are network-bound
 * and pull >30 transitive deps). Instead we drive the internal request
 * router by constructing a `WalletConnectSigner` against a tiny fake kit
 * and verify that EVM JSON-RPC methods route into the delegate's signing /
 * transfer / readonly paths exactly as the extension's background.ts does.
 */

import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { WalletConnectSigner, type WcDelegate } from '../src/dapp/index.js';

// ── Test plumbing ─────────────────────────────────────────────────────────

interface Captured {
  responses: unknown[];
}

function makeKit(captured: Captured) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const kit = {
    pair: async () => undefined,
    approveSession: async () => undefined,
    rejectSession: async () => undefined,
    respondSessionRequest: async (opts: { response: unknown }) => {
      captured.responses.push(opts.response);
    },
    disconnectSession: async () => undefined,
    getActiveSessions: () => ({}),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(listener);
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners[event];
      if (!arr) return;
      const i = arr.indexOf(listener);
      if (i >= 0) arr.splice(i, 1);
    },
    emit: (event: string, payload: unknown) => {
      for (const l of listeners[event] ?? []) l(payload);
    },
  };
  return kit;
}

/** Build a WalletConnectSigner with the fake kit (bypassing `create()` so
 *  we don't need the @reown/walletkit package installed). The constructor
 *  is private; we reach in via Object.create + manual call. */
function makeSigner(kit: ReturnType<typeof makeKit>): WalletConnectSigner {
  const proto = Object.getPrototypeOf(new (class extends WalletConnectSigner {
    constructor() {
      // @ts-expect-error — sneak past private ctor; safe in tests.
      super(
        {
          pair: async () => undefined,
          approveSession: async () => undefined,
          rejectSession: async () => undefined,
          respondSessionRequest: async () => undefined,
          disconnectSession: async () => undefined,
          getActiveSessions: () => ({}),
          on: () => undefined,
          off: () => undefined,
        },
        { name: 't', description: 't', url: 'https://t', icons: [] },
        7777,
      );
    }
  })());
  // Now build a real one with the *captured* kit.
  const instance = Object.create(proto) as WalletConnectSigner;
  // @ts-expect-error — wiring private fields for the test.
  instance.kit = kit;
  // @ts-expect-error
  instance.metadata = { name: 't', description: 't', url: 'https://t', icons: [] };
  // @ts-expect-error
  instance.chainId = 7777;
  // @ts-expect-error
  instance.delegate = null;
  // @ts-expect-error
  instance.proposalHandler = null;
  // @ts-expect-error
  instance.requestHandler = null;

  // Re-attach listeners as the real ctor would.
  kit.on('session_proposal', (event: unknown) => {
    // @ts-expect-error — calling private method.
    void instance.handleSessionProposal(event);
  });
  kit.on('session_request', (event: unknown) => {
    // @ts-expect-error
    void instance.handleSessionRequest(event);
  });

  return instance;
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ── Test delegate ─────────────────────────────────────────────────────────

function makeDelegate(overrides: Partial<WcDelegate> = {}): WcDelegate & {
  personalSignCalls: Array<{ message: string; address: string }>;
  signTypedCalls: Array<{ typedData: unknown; address: string }>;
  sendTxCalls: Array<unknown>;
} {
  const personalSignCalls: Array<{ message: string; address: string }> = [];
  const signTypedCalls: Array<{ typedData: unknown; address: string }> = [];
  const sendTxCalls: Array<unknown> = [];
  const base: WcDelegate = {
    getActiveEvmAddress: async () => '0x1111111111111111111111111111111111111111',
    personalSign: async (msg, addr) => {
      personalSignCalls.push({ message: msg, address: addr });
      return '0xdeadbeef' as `0x${string}`;
    },
    signTypedData: async (td, addr) => {
      signTypedCalls.push({ typedData: td, address: addr });
      return '0xcafebabe' as `0x${string}`;
    },
    sendTransaction: async (tx) => {
      sendTxCalls.push(tx);
      return '0x' + 'a'.repeat(64);
    },
    publicClient: () =>
      ({
        getBlockNumber: async () => 12345n,
        getBalance: async () => 100n,
        call: async () => ({ data: '0xabcd' }),
        estimateGas: async () => 21000n,
        getTransaction: async () => null,
        getTransactionReceipt: async () => null,
      }) as unknown as PublicClient,
    chainId: () => 7777,
  };
  return Object.assign({ ...base, ...overrides }, {
    personalSignCalls,
    signTypedCalls,
    sendTxCalls,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('WalletConnectSigner — request router', () => {
  it('routes personal_sign with [message, address] params into delegate.personalSign', async () => {
    const captured: Captured = { responses: [] };
    const kit = makeKit(captured);
    const signer = makeSigner(kit);
    const delegate = makeDelegate();
    signer.bindDelegate(delegate);

    kit.emit('session_request', {
      id: 1,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: {
          method: 'personal_sign',
          params: ['0x48656c6c6f', '0x1111111111111111111111111111111111111111'],
        },
      },
    });
    await flush();

    expect(delegate.personalSignCalls).toHaveLength(1);
    expect(delegate.personalSignCalls[0]?.message).toBe('0x48656c6c6f');
    expect(captured.responses[0]).toMatchObject({
      id: 1,
      jsonrpc: '2.0',
      result: '0xdeadbeef',
    });
  });

  it('routes eth_signTypedData_v4 into delegate.signTypedData', async () => {
    const captured: Captured = { responses: [] };
    const kit = makeKit(captured);
    const signer = makeSigner(kit);
    signer.bindDelegate(makeDelegate());

    const typed = {
      domain: { name: 'X', chainId: 7777 },
      types: { Mail: [{ name: 'to', type: 'address' }] },
      primaryType: 'Mail',
      message: { to: '0x2222222222222222222222222222222222222222' },
    };
    kit.emit('session_request', {
      id: 2,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: {
          method: 'eth_signTypedData_v4',
          params: ['0x1111111111111111111111111111111111111111', JSON.stringify(typed)],
        },
      },
    });
    await flush();

    expect(captured.responses[0]).toMatchObject({
      id: 2,
      result: '0xcafebabe',
    });
  });

  it('routes eth_signTypedData_v3 into the same delegate as v4 (with deprecation note)', async () => {
    const captured: Captured = { responses: [] };
    const kit = makeKit(captured);
    const signer = makeSigner(kit);
    const delegate = makeDelegate();
    signer.bindDelegate(delegate);

    const original = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      kit.emit('session_request', {
        id: 3,
        topic: 'topic-1',
        params: {
          chainId: 'eip155:7777',
          request: {
            method: 'eth_signTypedData_v3',
            params: ['0x1111111111111111111111111111111111111111', '{"primaryType":"M","types":{},"message":{}}'],
          },
        },
      });
      await flush();
    } finally {
      console.warn = original;
    }

    expect(delegate.signTypedCalls).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
    expect(captured.responses[0]).toMatchObject({ id: 3, result: '0xcafebabe' });
  });

  it('passes eth_sendTransaction through with the correct from default', async () => {
    const captured: Captured = { responses: [] };
    const kit = makeKit(captured);
    const signer = makeSigner(kit);
    const delegate = makeDelegate();
    signer.bindDelegate(delegate);

    kit.emit('session_request', {
      id: 4,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: {
          method: 'eth_sendTransaction',
          params: [{ to: '0x2222222222222222222222222222222222222222', value: '0x1' }],
        },
      },
    });
    await flush();

    expect(delegate.sendTxCalls).toHaveLength(1);
    expect((delegate.sendTxCalls[0] as { from: string }).from).toBe(
      '0x1111111111111111111111111111111111111111',
    );
    expect(captured.responses[0]).toMatchObject({ id: 4 });
  });

  it('eth_blockNumber returns hex via the public client', async () => {
    const captured: Captured = { responses: [] };
    const kit = makeKit(captured);
    const signer = makeSigner(kit);
    signer.bindDelegate(makeDelegate());

    kit.emit('session_request', {
      id: 5,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: { method: 'eth_blockNumber', params: [] },
      },
    });
    await flush();

    expect(captured.responses[0]).toMatchObject({
      id: 5,
      result: '0x' + (12345).toString(16),
    });
  });

  it('eth_getBalance forwards address and returns hex', async () => {
    const captured: Captured = { responses: [] };
    const kit = makeKit(captured);
    const signer = makeSigner(kit);
    signer.bindDelegate(makeDelegate());

    kit.emit('session_request', {
      id: 6,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: {
          method: 'eth_getBalance',
          params: ['0x1111111111111111111111111111111111111111', 'latest'],
        },
      },
    });
    await flush();

    expect(captured.responses[0]).toMatchObject({ id: 6, result: '0x' + (100).toString(16) });
  });

  it('eth_chainId returns the wallet active chain', async () => {
    const captured: Captured = { responses: [] };
    const kit = makeKit(captured);
    const signer = makeSigner(kit);
    signer.bindDelegate(makeDelegate());

    kit.emit('session_request', {
      id: 7,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: { method: 'eth_chainId', params: [] },
      },
    });
    await flush();

    expect(captured.responses[0]).toMatchObject({ id: 7, result: '0x' + (7777).toString(16) });
  });

  it('wallet_watchAsset returns true (accept)', async () => {
    const captured: Captured = { responses: [] };
    const kit = makeKit(captured);
    const signer = makeSigner(kit);
    signer.bindDelegate(makeDelegate());

    kit.emit('session_request', {
      id: 8,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: {
          method: 'wallet_watchAsset',
          params: { type: 'ERC20', options: { address: '0x3333333333333333333333333333333333333333' } },
        },
      },
    });
    await flush();

    expect(captured.responses[0]).toMatchObject({ id: 8, result: true });
  });

  it('returns a JSON-RPC error envelope for unsupported methods', async () => {
    const captured: Captured = { responses: [] };
    const kit = makeKit(captured);
    const signer = makeSigner(kit);
    signer.bindDelegate(makeDelegate());

    kit.emit('session_request', {
      id: 9,
      topic: 'topic-1',
      params: {
        chainId: 'eip155:7777',
        request: { method: 'eth_subscribe', params: [] },
      },
    });
    await flush();

    expect(captured.responses[0]).toMatchObject({
      id: 9,
      error: { code: -32000, message: expect.stringMatching(/Method not supported/) },
    });
  });
});
