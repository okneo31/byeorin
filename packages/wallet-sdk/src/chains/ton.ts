import {
  Address as TonAddress,
  Cell,
  WalletContractV4,
  TonClient,
  beginCell,
  external,
  internal,
  storeMessage,
  storeMessageRelaxed,
  SendMode,
  type MessageRelaxed,
} from '@ton/ton';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, TxContext } from './chain.js';

export type TonNetwork = 'mainnet' | 'testnet';

export interface TonAdapterOptions {
  network?: TonNetwork;
  endpoint?: string;
  apiKey?: string;
  /** Default valid_until window in seconds for outgoing external messages (default 60s). */
  timeoutSeconds?: number;
}

export interface TonUnsignedTx {
  /** Builder cell that's hashed and signed (walletId | timeout | seqno | action). */
  signingMessage: Cell;
  /** 32-byte Ed25519 pubkey (also used to address-resolve the V4 wallet). */
  pubkey: Uint8Array;
  /** seqno used when building the signing message (informational). */
  seqno: number;
}

export interface TonSignedTx {
  /** Base64-encoded BOC of the external message ready for `client.sendFile`. */
  boc: string;
  /** Hex-encoded external message hash (informational; TON has no canonical "tx hash"). */
  hash: string;
}

const DEFAULT_ENDPOINT: Record<TonNetwork, string> = {
  mainnet: 'https://toncenter.com/api/v2/jsonRPC',
  testnet: 'https://testnet.toncenter.com/api/v2/jsonRPC',
};

/**
 * TonAdapter — Tonkeeper-style v4r2 HD wallet adapter.
 *
 * Curve: Ed25519. Derivation path: m/44'/607'/${account}' (Tonkeeper convention).
 * The `index` arg is intentionally ignored — TON wallets typically expose a
 * single primary key per BIP44 account; sub-account UX is handled via
 * separate `account` values.
 *
 * Address encoding: Wallet V4 code+data → 32-byte hash, then base64url-friendly
 * user-friendly form (bounceable EQ.../UQ... + workchain byte + checksum).
 *
 * Signing target: hash() of the internal "signingMessage" Cell, which is the
 * v4 wallet's signed body: `walletId(32) | timeout(32 | 0xff*32) | seqno(32) |
 * extendedAction`. We mirror what `@ton/ton`'s `createWalletTransferV4` builds
 * but expose the unsigned cell so an external signer (SoftSigner/HW) can sign.
 */
export class TonAdapter implements ChainAdapter<TonUnsignedTx, TonSignedTx> {
  readonly curve = 'ed25519' as const;
  readonly coinType = 607;
  readonly id: string;
  readonly displayName: string;
  readonly network: TonNetwork;
  private readonly client: TonClient;
  private readonly timeoutSeconds: number;

  constructor(opts: TonAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.id = `ton:${this.network}`;
    this.displayName =
      this.network === 'mainnet' ? 'TON' : `TON ${this.network}`;
    const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT[this.network];
    this.client = new TonClient({ endpoint, apiKey: opts.apiKey });
    this.timeoutSeconds = opts.timeoutSeconds ?? 60;
  }

  derivationPath(account = 0, index = 0): string {
    // `index` is intentionally ignored — TON has a single primary key per
    // BIP44 account. Use distinct `account` values for distinct wallets.
    void index;
    return `m/44'/${this.coinType}'/${account}'`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    if (pubkey.length !== 32) {
      throw new Error(`ton: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: Buffer.from(pubkey),
    });
    return wallet.address.toString({
      bounceable: true,
      testOnly: this.network === 'testnet',
      urlSafe: true,
    });
  }

  async getBalance(address: Address): Promise<bigint> {
    const parsed = TonAddress.parse(address);
    const sun = await this.client.getBalance(parsed);
    return BigInt(sun);
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<TonUnsignedTx> {
    const pubkey = await ctx.signer.publicKey();
    if (pubkey.length !== 32) {
      throw new Error(`ton: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: Buffer.from(pubkey),
    });

    // Read seqno from chain; 0 means the wallet is not yet deployed and the
    // signing message uses 32 high bits instead of a unix timeout.
    let seqno = 0;
    try {
      const opened = this.client.open(wallet);
      seqno = await opened.getSeqno();
    } catch {
      seqno = 0;
    }

    const message: MessageRelaxed = internal({
      to: TonAddress.parse(intent.to),
      value: intent.amount,
      bounce: false,
      body: intent.memo ? beginCell().storeUint(0, 32).storeStringTail(intent.memo).endCell() : undefined,
    });

    // Mirror createWalletTransferV4 layout exactly so signature verification
    // against on-chain wallet code matches byte-for-byte.
    const signingBuilder = beginCell().storeUint(wallet.walletId, 32);
    if (seqno === 0) {
      for (let i = 0; i < 32; i++) signingBuilder.storeBit(1);
    } else {
      signingBuilder.storeUint(
        Math.floor(Date.now() / 1000) + this.timeoutSeconds,
        32,
      );
    }
    signingBuilder.storeUint(seqno, 32);
    // Inline v4 "sendMsg" extended-action layout (see @ton/ton
    // WalletContractV4Actions.storeExtendedAction): action_op(0) :: u8,
    // then for each message: sendMode :: u8, ref(messageRelaxed).
    const sendMode = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;
    signingBuilder.storeUint(0, 8); // op = 'sendMsg'
    signingBuilder.storeUint(sendMode, 8);
    signingBuilder.storeRef(beginCell().store(storeMessageRelaxed(message)));
    const signingMessage = signingBuilder.endCell();

    return { signingMessage, pubkey, seqno };
  }

  async serializeForSigning(tx: TonUnsignedTx): Promise<Uint8Array> {
    // TON signs the 32-byte Cell representation hash (sha256 over Cell repr).
    return new Uint8Array(tx.signingMessage.hash());
  }

  async applySignature(
    tx: TonUnsignedTx,
    signature: Uint8Array,
  ): Promise<TonSignedTx> {
    if (signature.length !== 64) {
      throw new Error(
        `ton: ed25519 signature must be 64 bytes, got ${signature.length}`,
      );
    }
    // Body = signature(64B) || signingMessage cell. v4 uses front-packed sig.
    const body = beginCell()
      .storeBuffer(Buffer.from(signature))
      .storeSlice(tx.signingMessage.beginParse())
      .endCell();

    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: Buffer.from(tx.pubkey),
    });

    // Attach stateInit only on first deploy (seqno === 0). Otherwise omit so
    // the external message stays small. This mirrors @ton/ton's provider.external.
    const ext = external({
      to: wallet.address,
      init: tx.seqno === 0 ? wallet.init : undefined,
      body,
    });
    const finalCell = beginCell().store(storeMessage(ext)).endCell();
    const boc = finalCell.toBoc().toString('base64');
    const hash = finalCell.hash().toString('hex');
    return { boc, hash };
  }

  async broadcast(tx: TonSignedTx): Promise<TxHash> {
    await this.client.sendFile(Buffer.from(tx.boc, 'base64'));
    return tx.hash;
  }
}

