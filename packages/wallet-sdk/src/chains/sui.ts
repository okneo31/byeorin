import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { messageWithIntent } from '@mysten/sui/cryptography';
import { blake2b } from '@noble/hashes/blake2b';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, TxContext } from './chain.js';

export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet';

export interface SuiAdapterOptions {
  network?: SuiNetwork;
  url?: string;
}

export interface SuiUnsignedTx {
  /** Built TransactionData bytes (BCS, no intent prefix, no signature). */
  txBytes: Uint8Array;
  /** Sender's 32-byte Ed25519 pubkey for the final signature blob. */
  pubkey: Uint8Array;
}

export interface SuiSignedTx {
  txBytes: Uint8Array;
  /** Base64 string of (flag(1) || sig(64) || pubkey(32)) — Sui's serialized signature. */
  signature: string;
}

const SUI_ED25519_FLAG = 0x00;

/**
 * SuiAdapter — Sui Wallet (formerly Sui Wallet/Slush) compatible HD adapter.
 *
 * Curve: Ed25519. Path: m/44'/784'/${account}'/0'/${index}' (Sui standard).
 *
 * Address = first 32 bytes of blake2b256(0x00 || pubkey32). The 0x00 is the
 * Ed25519 scheme flag. Sui addresses are 0x-prefixed 64-hex-char strings.
 *
 * Signing target: blake2b256( messageWithIntent('TransactionData', txBytes) ).
 * The intent message prefixes 3 bytes (scope, version, app) before the actual
 * BCS-encoded TransactionData. The 32-byte blake2b256 digest is the Ed25519
 * signing message — Sui's verifier reapplies the same intent hash on-chain.
 */
export class SuiAdapter implements ChainAdapter<SuiUnsignedTx, SuiSignedTx> {
  readonly curve = 'ed25519' as const;
  readonly coinType = 784;
  readonly id: string;
  readonly displayName: string;
  readonly network: SuiNetwork;
  private readonly client: SuiClient;

  constructor(opts: SuiAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.id = `sui:${this.network}`;
    this.displayName =
      this.network === 'mainnet' ? 'Sui' : `Sui ${this.network}`;
    const url = opts.url ?? getFullnodeUrl(this.network);
    this.client = new SuiClient({ url });
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0'/${index}'`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    if (pubkey.length !== 32) {
      throw new Error(`sui: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    // Sui address: blake2b256(flag || pubkey)[..32], 0x-hex encoded.
    const tmp = new Uint8Array(33);
    tmp[0] = SUI_ED25519_FLAG;
    tmp.set(pubkey, 1);
    const digest = blake2b(tmp, { dkLen: 32 });
    return '0x' + bytesToHex(digest);
  }

  async getBalance(address: Address): Promise<bigint> {
    // Default SUI coinType — equivalent to '0x2::sui::SUI'.
    const res = await this.client.getBalance({ owner: address });
    return BigInt(res.totalBalance);
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<SuiUnsignedTx> {
    const pubkey = await ctx.signer.publicKey();
    if (pubkey.length !== 32) {
      throw new Error(`sui: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    const tx = new Transaction();
    // Split `amount` MIST off the gas coin, then transfer the split coin to
    // the recipient. setSender is required for `tx.build()` to populate the
    // sender field in TransactionData.
    const [coin] = tx.splitCoins(tx.gas, [intent.amount]);
    tx.transferObjects([coin], intent.to);
    tx.setSender(ctx.sender);
    const txBytes = await tx.build({ client: this.client });
    return { txBytes, pubkey };
  }

  async serializeForSigning(tx: SuiUnsignedTx): Promise<Uint8Array> {
    // Wrap TransactionData with Sui's IntentMessage(scope='TransactionData',
    // version=V0, app=Sui), then blake2b256-hash for the Ed25519 message.
    const intentMsg = messageWithIntent('TransactionData', tx.txBytes);
    return blake2b(intentMsg, { dkLen: 32 });
  }

  async applySignature(
    tx: SuiUnsignedTx,
    signature: Uint8Array,
  ): Promise<SuiSignedTx> {
    if (signature.length !== 64) {
      throw new Error(
        `sui: ed25519 signature must be 64 bytes, got ${signature.length}`,
      );
    }
    // Sui's serialized signature: flag(1) || sig(64) || pubkey(32), base64.
    const blob = new Uint8Array(1 + 64 + 32);
    blob[0] = SUI_ED25519_FLAG;
    blob.set(signature, 1);
    blob.set(tx.pubkey, 1 + 64);
    return { txBytes: tx.txBytes, signature: bytesToBase64(blob) };
  }

  async broadcast(tx: SuiSignedTx): Promise<TxHash> {
    const res = await this.client.executeTransactionBlock({
      transactionBlock: tx.txBytes,
      signature: [tx.signature],
    });
    return res.digest;
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += (b[i] as number).toString(16).padStart(2, '0');
  }
  return s;
}

function bytesToBase64(b: Uint8Array): string {
  // Node Buffer is available in our target runtime; fall back to btoa
  // when running in a browser-like env without Buffer.
  if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] as number);
  return btoa(s);
}
