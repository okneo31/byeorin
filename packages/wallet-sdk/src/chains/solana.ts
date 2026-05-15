import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  type Cluster,
} from '@solana/web3.js';
import { base58 } from '@scure/base';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, TxContext } from './chain.js';

export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet';

export interface SolanaAdapterOptions {
  network?: SolanaNetwork;
  rpcUrl?: string;
}

export interface SolanaUnsignedTx {
  tx: Transaction;
}

export interface SolanaSignedTx {
  raw: Uint8Array;
  signature: string;
}

/**
 * SolanaAdapter — Phantom-compatible HD wallet adapter.
 *
 * Derivation path: m/44'/501'/${index}'/0'  (all hardened — Solana requires it)
 *   The `index` argument (not `account`) drives the sub-key index, matching
 *   Phantom's UX where each derived account differs by index.
 *
 * Lamports caveat: Solana's SystemProgram.transfer takes a JS `number` for
 * lamports. JS `number` is safe up to 2^53-1 ≈ 9.007e15 lamports
 * (≈ 9.007e6 SOL), well beyond any reasonable transfer. We coerce
 * `intent.amount` (bigint) → Number and throw if it would lose precision.
 */
export class SolanaAdapter
  implements ChainAdapter<SolanaUnsignedTx, SolanaSignedTx>
{
  readonly id: string;
  readonly displayName: string;
  readonly curve = 'ed25519' as const;
  readonly coinType = 501;
  readonly network: SolanaNetwork;
  private readonly connection: Connection;

  constructor(opts: SolanaAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet-beta';
    this.id = `solana:${this.network}`;
    this.displayName =
      this.network === 'mainnet-beta'
        ? 'Solana'
        : `Solana ${this.network}`;
    const url =
      opts.rpcUrl ?? clusterApiUrl(this.network as Cluster);
    this.connection = new Connection(url, 'confirmed');
  }

  // Phantom-compatible path. `index` drives sub-key, `account` reserved.
  derivationPath(account = 0, index = 0): string {
    // Use `index` (not `account`) so callers iterating on indices get
    // distinct Phantom-style addresses. `account` is intentionally unused
    // here to stay aligned with Phantom's default derivation scheme.
    void account;
    return `m/44'/501'/${index}'/0'`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    if (pubkey.length !== 32) {
      throw new Error(`solana: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    return base58.encode(pubkey);
  }

  async getBalance(address: Address): Promise<bigint> {
    const lamports = await this.connection.getBalance(new PublicKey(address));
    return BigInt(lamports);
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<SolanaUnsignedTx> {
    const lamports = bigintToSafeNumber(intent.amount, 'solana lamports');
    const fromPubkey = new PublicKey(ctx.sender);
    const toPubkey = new PublicKey(intent.to);

    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey, toPubkey, lamports }),
    );
    tx.feePayer = fromPubkey;
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    return { tx };
  }

  async serializeForSigning(tx: SolanaUnsignedTx): Promise<Uint8Array> {
    // The Ed25519 signature target is the compiled message bytes,
    // not the full serialized transaction.
    return new Uint8Array(tx.tx.serializeMessage());
  }

  async applySignature(
    tx: SolanaUnsignedTx,
    signature: Uint8Array,
  ): Promise<SolanaSignedTx> {
    if (signature.length !== 64) {
      throw new Error(
        `solana: ed25519 signature must be 64 bytes, got ${signature.length}`,
      );
    }
    const feePayer = tx.tx.feePayer;
    if (!feePayer) {
      throw new Error('solana: cannot apply signature without feePayer');
    }
    tx.tx.addSignature(feePayer, Buffer.from(signature));
    const raw = new Uint8Array(tx.tx.serialize());
    return { raw, signature: base58.encode(signature) };
  }

  async broadcast(tx: SolanaSignedTx): Promise<TxHash> {
    return this.connection.sendRawTransaction(tx.raw, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
  }
}

function bigintToSafeNumber(value: bigint, label: string): number {
  if (value < 0n) throw new Error(`${label}: must be >= 0`);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${label}: ${value.toString()} exceeds Number.MAX_SAFE_INTEGER`,
    );
  }
  return Number(value);
}
