/**
 * WalletConnect v2 (Reown WalletKit) thin adapter.
 *
 * Wraps `@reown/walletkit` so wallet shells (desktop / mobile / future web)
 * can:
 *   1) Pair to a dApp via a wc:// URI.
 *   2) Approve/reject EIP-155 session proposals (with our chain allowlist).
 *   3) Route EVM JSON-RPC requests (personal_sign / eth_sendTransaction /
 *      eth_signTypedData_v4 / read-only methods) through the same code paths
 *      `background.ts` already uses.
 *   4) Persist and clean up sessions.
 *
 * Design notes:
 *
 *   - We do NOT statically import `@reown/walletkit`. The package is heavy
 *     (~30+ transitive deps) and its types are not consumed by our SDK build.
 *     `create()` does a dynamic `import()` so the SDK can ship without WC
 *     pulled in; consumer apps that need WC must install `@reown/walletkit`
 *     (added as optionalDependency in our package.json).
 *
 *   - The "wallet" side of EIP-1193 (extension's in-page `window.ethereum`)
 *     is unchanged. WC v2 lives in parallel as a second dApp transport and
 *     never touches the browser-extension injection path.
 *
 *   - We expose minimal first-party types (`WcRequest`, `WcSession`, etc.)
 *     so shell apps can program against this adapter without depending on
 *     `@reown/walletkit`'s types directly.
 *
 *   - Routing is delegated via a `WcDelegate` interface — the shell wires
 *     in its `walletStore.transfer`, `signEvmMessage` and an `EvmAdapter`'s
 *     readonly `client`. This keeps the SDK testable without React or any
 *     concrete WalletStore.
 *
 * Mobile-native TODO:
 *   QR-scan and `nodong://wc?uri=…` deep-link handoff require native config
 *   (`AndroidManifest.xml` intent-filter, iOS URL Types in `Info.plist`).
 *   The mobile entry point in this repo can ship the JS layer today and add
 *   native plumbing once the `android/`/`ios/` folders exist.
 */

import type { Hex } from 'viem';
import type { PublicClient } from 'viem';

// ── Public surface ────────────────────────────────────────────────────────

export interface WcMetadata {
  name: string;
  description: string;
  url: string;
  icons: string[];
}

export interface WcConnectionRequest {
  uri: string;
}

export interface WcSession {
  topic: string;
  peer: {
    name: string;
    url: string;
    icons: string[];
  };
  namespaces: Record<string, WcNamespace>;
}

export interface WcNamespace {
  accounts: string[];
  methods: string[];
  events: string[];
  chains?: string[];
}

/** A pending session proposal from a dApp. The shell decides which CAIP-2
 *  chains/accounts to approve. */
export interface WcSessionProposal {
  id: number;
  proposer: {
    metadata: WcMetadata;
  };
  /** CAIP-2 chain ids (e.g. 'eip155:7777') the dApp wants to use. */
  requiredChains: string[];
  optionalChains: string[];
  requiredMethods: string[];
  optionalMethods: string[];
  /** The raw proposal object — pass back to the SDK on approve/reject. */
  raw: unknown;
}

export interface WcSessionProposalDecision {
  /** CAIP-10 accounts the wallet is approving (e.g. 'eip155:7777:0xabc…'). */
  approved: string[];
  /** Optional explicit reject list — informational. */
  rejected?: string[];
}

export interface WcRequest {
  /** Session topic. */
  topic: string;
  /** Request id (echoed in the response). */
  id: number;
  /** CAIP-2 chain id this request targets. */
  chainId: string;
  /** JSON-RPC method name. */
  method: string;
  /** JSON-RPC params (method-dependent). */
  params: unknown;
}

/** The wallet-side delegate. Shells implement this to route EVM RPC into
 *  their existing signing / transfer paths. */
export interface WcDelegate {
  /** Active EVM address (lowercased 0x…). Returned for `eth_accounts`-style
   *  introspection. Throws if locked. */
  getActiveEvmAddress(): Promise<string>;

  /** EIP-191 personal_sign. message is the raw hex from the dApp. */
  personalSign(message: Hex, address: string): Promise<Hex>;

  /** EIP-712 typed-data signing — both `v3` and `v4` shapes share this
   *  delegate. (v3 differs only in not supporting nested struct arrays;
   *  the adapter forwards it here with a deprecation note.) */
  signTypedData(typedData: unknown, address: string): Promise<Hex>;

  /** Send a transaction. Returns the broadcast tx hash. */
  sendTransaction(tx: {
    to: string;
    from: string;
    value?: string;
    data?: string;
    gas?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    nonce?: string;
  }): Promise<string>;

  /** Readonly public client for `eth_blockNumber`, `eth_call`, etc.
   *  Adapter forwards passthrough methods to this client. */
  publicClient(): PublicClient | null;

  /** Active EIP-155 chain id (e.g. 7777). */
  chainId(): number;
}

export interface WalletConnectSignerOptions {
  projectId: string;
  relayUrl?: string;
  metadata: WcMetadata;
  /** Storage backend — Reown's WalletKit accepts an `IStore`-shaped object.
   *  Leave unset to use the SDK default (browser localStorage). */
  storage?: unknown;
}

export type WcSessionProposalHandler = (
  proposal: WcSessionProposal,
) => Promise<WcSessionProposalDecision>;

export type WcRequestHandler = (
  req: WcRequest,
) => Promise<unknown>;

// ── Internal: dynamic import of @reown/walletkit ──────────────────────────

interface ReownWalletKitModule {
  WalletKit?: { init: (opts: unknown) => Promise<unknown> };
  default?: { init: (opts: unknown) => Promise<unknown> };
}

interface ReownCoreModule {
  Core: new (opts: { projectId: string; relayUrl?: string }) => unknown;
}

async function loadWalletKit(): Promise<{
  Core: ReownCoreModule['Core'];
  WalletKit: { init: (opts: unknown) => Promise<unknown> };
}> {
  // The module specifiers are kept in variables so TypeScript does not try to
  // resolve them at compile time — `@reown/walletkit` is an optionalDependency
  // declared on this package and may be absent. Vite / Rollup honour the
  // /* @vite-ignore */ pragma and emit a runtime import.
  //
  // We resolve through Function('return import(s)') to keep the bundler from
  // analysing the call site (and crashing in environments — like the
  // extension's MV3 service worker — where the package is not present).
  const reownSpec = '@reown/walletkit';
  const coreSpec = '@walletconnect/core';
  const dynImport = (s: string): Promise<unknown> =>
    (Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(s);

  let mod: ReownWalletKitModule;
  try {
    mod = (await dynImport(reownSpec)) as ReownWalletKitModule;
  } catch (err) {
    throw new Error(
      'walletconnect: @reown/walletkit is not installed. ' +
        'Add it to your app: pnpm add @reown/walletkit. ' +
        `Underlying error: ${(err as Error)?.message ?? err}`,
    );
  }
  const WalletKit = mod.WalletKit ?? mod.default;
  if (!WalletKit || typeof WalletKit.init !== 'function') {
    throw new Error('walletconnect: @reown/walletkit exports no WalletKit.init');
  }
  let coreMod: ReownCoreModule;
  try {
    coreMod = (await dynImport(coreSpec)) as ReownCoreModule;
  } catch (err) {
    throw new Error(
      'walletconnect: @walletconnect/core is required (a transitive of @reown/walletkit). ' +
        `Underlying error: ${(err as Error)?.message ?? err}`,
    );
  }
  return { Core: coreMod.Core, WalletKit };
}

// ── Adapter ───────────────────────────────────────────────────────────────

/** WalletKit's runtime instance shape we depend on. Kept narrow on purpose
 *  so the adapter does not over-couple to library internals. */
interface KitRuntime {
  pair(opts: { uri: string }): Promise<unknown>;
  approveSession(opts: unknown): Promise<unknown>;
  rejectSession(opts: unknown): Promise<unknown>;
  respondSessionRequest(opts: unknown): Promise<void>;
  disconnectSession(opts: { topic: string; reason: { code: number; message: string } }): Promise<void>;
  getActiveSessions(): Record<string, unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
}

export class WalletConnectSigner {
  private readonly kit: KitRuntime;
  private readonly metadata: WcMetadata;
  private readonly chainId: number;
  private delegate: WcDelegate | null = null;
  private proposalHandler: WcSessionProposalHandler | null = null;
  private requestHandler: WcRequestHandler | null = null;

  private constructor(kit: KitRuntime, metadata: WcMetadata, chainId: number) {
    this.kit = kit;
    this.metadata = metadata;
    this.chainId = chainId;

    // Internal listeners — fan proposals out to the user-supplied handler.
    this.kit.on('session_proposal', (event: unknown) => {
      void this.handleSessionProposal(event);
    });
    this.kit.on('session_request', (event: unknown) => {
      void this.handleSessionRequest(event);
    });
  }

  /**
   * Create a configured WalletConnectSigner. Dynamically loads
   * `@reown/walletkit` — throws a helpful error if the package isn't
   * installed.
   *
   * `chainId` here is the wallet's active EVM chain (e.g. 7777 for TTL).
   * It is used to default the `eip155:<id>` namespace on approve.
   */
  static async create(opts: {
    projectId: string;
    relayUrl?: string;
    metadata: WcMetadata;
    chainId?: number;
  }): Promise<WalletConnectSigner> {
    if (!opts.projectId || typeof opts.projectId !== 'string') {
      throw new Error('walletconnect: projectId is required');
    }
    const { Core, WalletKit } = await loadWalletKit();
    const core = new Core({ projectId: opts.projectId, relayUrl: opts.relayUrl });
    const kit = (await WalletKit.init({ core, metadata: opts.metadata })) as KitRuntime;
    return new WalletConnectSigner(kit, opts.metadata, opts.chainId ?? 7777);
  }

  /** Bind the wallet-side delegate. Must be called before `pair` so request
   *  routing has a target. */
  bindDelegate(d: WcDelegate): void {
    this.delegate = d;
  }

  /** Pair with the URI the user pasted (or scanned via QR). The Reown SDK
   *  emits `session_proposal` shortly after pairing succeeds. The returned
   *  WcSession is a placeholder — the *real* session is delivered to the
   *  proposal handler. */
  async pair(uri: string): Promise<void> {
    if (!/^wc:[a-zA-Z0-9_\-]+@\d+\?/.test(uri) && !uri.startsWith('wc:')) {
      throw new Error('walletconnect: not a wc: URI');
    }
    await this.kit.pair({ uri });
  }

  /** Register a handler for incoming session proposals. The handler decides
   *  which CAIP-10 accounts to approve. If the handler returns an empty
   *  `approved` array, the proposal is rejected. */
  onSessionProposal(handler: WcSessionProposalHandler): void {
    this.proposalHandler = handler;
  }

  /** Register a handler for incoming JSON-RPC requests. If unset, the
   *  adapter's built-in router (delegate-based) handles them. */
  onRequest(handler: WcRequestHandler): void {
    this.requestHandler = handler;
  }

  /** Disconnect by session topic. */
  async disconnect(topic: string): Promise<void> {
    await this.kit.disconnectSession({
      topic,
      reason: { code: 6000, message: 'User disconnected' },
    });
  }

  /** Snapshot of active sessions. */
  async activeSessions(): Promise<WcSession[]> {
    const map = this.kit.getActiveSessions();
    const out: WcSession[] = [];
    for (const topic of Object.keys(map)) {
      const s = map[topic] as {
        topic?: string;
        peer?: { metadata?: WcMetadata };
        namespaces?: Record<string, WcNamespace>;
      };
      out.push({
        topic: s.topic ?? topic,
        peer: {
          name: s.peer?.metadata?.name ?? '(unknown)',
          url: s.peer?.metadata?.url ?? '',
          icons: s.peer?.metadata?.icons ?? [],
        },
        namespaces: s.namespaces ?? {},
      });
    }
    return out;
  }

  // ── Internal handlers ───────────────────────────────────────────────────

  /** Translate Reown's session_proposal payload into our WcSessionProposal,
   *  delegate to the user handler, then call approveSession/rejectSession. */
  private async handleSessionProposal(event: unknown): Promise<void> {
    const e = event as {
      id: number;
      params: {
        proposer: { metadata: WcMetadata };
        requiredNamespaces?: Record<string, { chains?: string[]; methods?: string[] }>;
        optionalNamespaces?: Record<string, { chains?: string[]; methods?: string[] }>;
      };
    };
    if (!this.proposalHandler) {
      // No handler — reject silently with a generic reason.
      try {
        await this.kit.rejectSession({
          id: e.id,
          reason: { code: 5000, message: 'No proposal handler bound' },
        });
      } catch {
        /* noop */
      }
      return;
    }

    const required = e.params.requiredNamespaces ?? {};
    const optional = e.params.optionalNamespaces ?? {};
    const flat = (ns: typeof required, key: 'chains' | 'methods'): string[] => {
      const out: string[] = [];
      for (const k of Object.keys(ns)) {
        const v = ns[k]?.[key];
        if (Array.isArray(v)) out.push(...v);
      }
      return out;
    };

    const proposal: WcSessionProposal = {
      id: e.id,
      proposer: { metadata: e.params.proposer.metadata },
      requiredChains: flat(required, 'chains'),
      optionalChains: flat(optional, 'chains'),
      requiredMethods: flat(required, 'methods'),
      optionalMethods: flat(optional, 'methods'),
      raw: event,
    };

    let decision: WcSessionProposalDecision;
    try {
      decision = await this.proposalHandler(proposal);
    } catch (err) {
      try {
        await this.kit.rejectSession({
          id: e.id,
          reason: { code: 5001, message: `Proposal handler error: ${(err as Error)?.message ?? err}` },
        });
      } catch {
        /* noop */
      }
      return;
    }

    if (!decision.approved.length) {
      try {
        await this.kit.rejectSession({
          id: e.id,
          reason: { code: 5002, message: 'User rejected' },
        });
      } catch {
        /* noop */
      }
      return;
    }

    // Build approve namespaces from the approved CAIP-10 list.
    const namespaces: Record<string, WcNamespace> = {};
    for (const caip of decision.approved) {
      const [ns, chainId] = caip.split(':');
      if (!ns) continue;
      const chainKey = `${ns}:${chainId}`;
      const slot = namespaces[ns] ?? {
        accounts: [],
        chains: [] as string[],
        methods: [],
        events: ['accountsChanged', 'chainChanged'],
      };
      slot.accounts.push(caip);
      if (!slot.chains!.includes(chainKey)) slot.chains!.push(chainKey);
      if (ns === 'eip155') {
        for (const m of [
          'eth_sendTransaction',
          'personal_sign',
          'eth_signTypedData',
          'eth_signTypedData_v3',
          'eth_signTypedData_v4',
          'eth_accounts',
          'eth_chainId',
          'eth_blockNumber',
          'eth_getBalance',
          'eth_call',
          'eth_estimateGas',
          'eth_getTransactionByHash',
          'eth_getTransactionReceipt',
          'wallet_watchAsset',
          'wallet_switchEthereumChain',
        ]) {
          if (!slot.methods.includes(m)) slot.methods.push(m);
        }
      }
      namespaces[ns] = slot;
    }

    try {
      await this.kit.approveSession({ id: e.id, namespaces });
    } catch (err) {
      // approveSession failure → reject so the dApp gets a clear error.
      try {
        await this.kit.rejectSession({
          id: e.id,
          reason: { code: 5100, message: `Approve failed: ${(err as Error)?.message ?? err}` },
        });
      } catch {
        /* noop */
      }
    }
  }

  /** Translate session_request into WcRequest, route through user handler
   *  if set, otherwise dispatch to the built-in delegate router. */
  private async handleSessionRequest(event: unknown): Promise<void> {
    const e = event as {
      id: number;
      topic: string;
      params: {
        request: { method: string; params: unknown };
        chainId: string;
      };
    };
    const req: WcRequest = {
      id: e.id,
      topic: e.topic,
      method: e.params.request.method,
      params: e.params.request.params,
      chainId: e.params.chainId,
    };

    let result: unknown;
    let errorMessage: string | null = null;
    try {
      result = this.requestHandler
        ? await this.requestHandler(req)
        : await this.routeViaDelegate(req);
    } catch (err) {
      errorMessage = (err as Error)?.message ?? String(err);
    }

    try {
      await this.kit.respondSessionRequest({
        topic: e.topic,
        response: errorMessage
          ? {
              id: e.id,
              jsonrpc: '2.0',
              error: { code: -32000, message: errorMessage },
            }
          : {
              id: e.id,
              jsonrpc: '2.0',
              result,
            },
      });
    } catch {
      // If we can't respond, the dApp times out — there is nothing else we
      // can usefully do.
    }
  }

  /** Built-in EVM JSON-RPC router. */
  private async routeViaDelegate(req: WcRequest): Promise<unknown> {
    const d = this.delegate;
    if (!d) throw new Error('walletconnect: no delegate bound');

    const params = (Array.isArray(req.params) ? req.params : []) as unknown[];

    switch (req.method) {
      // ── Identity ────────────────────────────────────────────────────────
      case 'eth_accounts':
      case 'eth_requestAccounts': {
        const addr = await d.getActiveEvmAddress();
        return [addr];
      }
      case 'eth_chainId': {
        return '0x' + d.chainId().toString(16);
      }

      // ── Signing ─────────────────────────────────────────────────────────
      case 'personal_sign': {
        // Param order is [messageHex, address] per MetaMask convention but
        // some dApps reverse it. Heuristic: 20-byte hex is the address.
        const a = String(params[0] ?? '');
        const b = String(params[1] ?? '');
        const aIsAddr = /^0x[0-9a-fA-F]{40}$/.test(a);
        const bIsAddr = /^0x[0-9a-fA-F]{40}$/.test(b);
        const [messageHex, addr] =
          aIsAddr && !bIsAddr ? [b, a] : [a, b];
        return d.personalSign(messageHex as Hex, addr);
      }
      case 'eth_sign': {
        // Legacy — same params order as personal_sign with reversed semantics.
        // We route to personal_sign for safety (always EIP-191 prefixed).
        const addr = String(params[0] ?? '');
        const messageHex = String(params[1] ?? '');
        return d.personalSign(messageHex as Hex, addr);
      }
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4': {
        const addr = String(params[0] ?? '');
        const raw = params[1];
        const typedData = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // v3 is the legacy shape — same flow, but warn. v4 is the canonical
        // path; the delegate hashes via viem.hashTypedData which is v4-
        // compatible and also accepts the v3 shape.
        if (req.method === 'eth_signTypedData_v3') {
          // Deprecation note (kept silent on the wire; logged so developers
          // see it during integration).
          // eslint-disable-next-line no-console
          console.warn(
            'walletconnect: eth_signTypedData_v3 is deprecated; routing through v4 path',
          );
        }
        return d.signTypedData(typedData, addr);
      }

      // ── Send ────────────────────────────────────────────────────────────
      case 'eth_sendTransaction': {
        const tx = params[0] as {
          from?: string;
          to?: string;
          value?: string;
          data?: string;
          gas?: string;
          gasPrice?: string;
          maxFeePerGas?: string;
          maxPriorityFeePerGas?: string;
          nonce?: string;
        };
        if (!tx || !tx.to) throw new Error('eth_sendTransaction: missing to');
        const from = tx.from ?? (await d.getActiveEvmAddress());
        return d.sendTransaction({ ...tx, from, to: tx.to });
      }

      // ── Read-only passthroughs ──────────────────────────────────────────
      case 'eth_blockNumber': {
        const c = d.publicClient();
        if (!c) throw new Error('eth_blockNumber: no public client');
        const n = await c.getBlockNumber();
        return '0x' + n.toString(16);
      }
      case 'eth_getBalance': {
        const c = d.publicClient();
        if (!c) throw new Error('eth_getBalance: no public client');
        const addr = String(params[0] ?? '');
        const v = await c.getBalance({ address: addr as `0x${string}` });
        return '0x' + v.toString(16);
      }
      case 'eth_call': {
        const c = d.publicClient();
        if (!c) throw new Error('eth_call: no public client');
        const call = params[0] as { to: string; data?: string; from?: string };
        const out = await c.call({
          to: call.to as `0x${string}`,
          data: (call.data ?? '0x') as `0x${string}`,
          ...(call.from ? { account: call.from as `0x${string}` } : {}),
        });
        return out.data ?? '0x';
      }
      case 'eth_estimateGas': {
        const c = d.publicClient();
        if (!c) throw new Error('eth_estimateGas: no public client');
        const call = params[0] as {
          to: string;
          data?: string;
          value?: string;
          from?: string;
        };
        const gas = await c.estimateGas({
          to: call.to as `0x${string}`,
          ...(call.data ? { data: call.data as `0x${string}` } : {}),
          ...(call.value ? { value: BigInt(call.value) } : {}),
          ...(call.from ? { account: call.from as `0x${string}` } : {}),
        });
        return '0x' + gas.toString(16);
      }
      case 'eth_getTransactionByHash': {
        const c = d.publicClient();
        if (!c) throw new Error('eth_getTransactionByHash: no public client');
        const hash = String(params[0] ?? '');
        return c.getTransaction({ hash: hash as `0x${string}` });
      }
      case 'eth_getTransactionReceipt': {
        const c = d.publicClient();
        if (!c) throw new Error('eth_getTransactionReceipt: no public client');
        const hash = String(params[0] ?? '');
        try {
          return await c.getTransactionReceipt({ hash: hash as `0x${string}` });
        } catch {
          // Not yet mined — JSON-RPC convention: return null.
          return null;
        }
      }

      // ── wallet_* ────────────────────────────────────────────────────────
      case 'wallet_watchAsset': {
        // We accept the request and return `true`. Per EIP-747 the wallet
        // surface decides UX; shells embedding this signer can intercept via
        // `onRequest` to show their own confirm popup. Returning `true`
        // means "the wallet has stored the asset"; we treat WC contexts as
        // implicit-allowlist for the dApp's connected origin.
        return true;
      }
      case 'wallet_switchEthereumChain': {
        const requested = params[0] as { chainId?: string } | undefined;
        const target = parseInt(requested?.chainId ?? '0x0', 16);
        if (target !== d.chainId()) {
          throw new Error(`unsupported chainId: ${requested?.chainId}`);
        }
        return null;
      }

      default:
        throw new Error(`Method not supported: ${req.method}`);
    }
  }
}
