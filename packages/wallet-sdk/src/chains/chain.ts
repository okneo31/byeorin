import type { Address, Curve, Signer, TransferIntent, TxHash } from '../types.js';

export interface TxContext {
  signer: Signer;
  sender: Address;
}

/**
 * A single signing request emitted by a ChainAdapter for some unsigned tx.
 *
 * Most chains emit exactly one request per tx. Bitcoin (and other UTXO chains)
 * emit one request per input.
 */
export interface SignRequest {
  /** Bytes the Signer must sign. */
  message: Uint8Array;
  /**
   * If true, `message` is already a 32-byte digest — the signer signs as-is
   * (secp256k1 convention). If false, `message` is the raw signing payload —
   * the curve's signer hashes internally (Ed25519 convention).
   *
   * This is informational for hardware signers that need to display the right
   * hashing semantics to the user; SoftSigner is agnostic and signs whatever
   * bytes it's given.
   */
  prehashed: boolean;
}

export interface ChainAdapter<TUnsigned = unknown, TSigned = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly curve: Curve;
  readonly coinType: number;

  derivationPath(account?: number, index?: number): string;
  pubkeyToAddress(pubkey: Uint8Array): Address;

  getBalance(address: Address): Promise<bigint>;
  buildTransfer(intent: TransferIntent, ctx: TxContext): Promise<TUnsigned>;

  /**
   * Returns 1+ sign requests. Single-signature chains (EVM, Cosmos, XRP, Tron,
   * TON, Aptos, Sui, Solana) return exactly one. BTC returns one per input.
   */
  signRequests(tx: TUnsigned): Promise<SignRequest[]>;

  /**
   * Apply N signatures in the same order `signRequests` returned them.
   * `signatures.length` must equal `(await signRequests(tx)).length`.
   */
  applySignatures(tx: TUnsigned, signatures: Uint8Array[]): Promise<TSigned>;

  broadcast(tx: TSigned): Promise<TxHash>;
}
