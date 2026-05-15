import {
  Client,
  deriveAddress,
  encode,
  encodeForSigning,
  hashes,
} from 'xrpl';
import type { Payment } from 'xrpl';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type XrpNetwork = 'mainnet' | 'testnet';

export interface XrpAdapterOptions {
  network?: XrpNetwork;
  wsUrl?: string;
}

export interface XrpUnsignedTx {
  tx: Payment;
}

export interface XrpSignedTx {
  txBlob: string;
  hash: string;
}

const DEFAULT_WS_URL: Record<XrpNetwork, string> = {
  mainnet: 'wss://xrplcluster.com',
  testnet: 'wss://s.altnet.rippletest.net:51233',
};

export class XrpAdapter implements ChainAdapter<XrpUnsignedTx, XrpSignedTx> {
  readonly curve = 'secp256k1' as const;
  readonly coinType = 144;
  readonly id: string;
  readonly displayName = 'XRP Ledger';
  readonly network: XrpNetwork;
  readonly wsUrl: string;

  private _client: Client | null = null;

  constructor(opts: XrpAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.wsUrl = opts.wsUrl ?? DEFAULT_WS_URL[this.network];
    this.id = `xrp:${this.network}`;
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    const compressed = toCompressedSecp256k1(pubkey);
    return deriveAddress(bytesToHex(compressed).toUpperCase());
  }

  async getBalance(address: Address): Promise<bigint> {
    const client = await this.client();
    try {
      const xrp = await client.getXrpBalance(address);
      // getXrpBalance returns a decimal XRP number (string-parsed to JS number).
      // Convert to drops (1 XRP = 1_000_000 drops) without floating-point loss.
      return xrpToDrops(xrp);
    } catch (err: unknown) {
      if (isActNotFound(err)) return 0n;
      throw err;
    }
  }

  async buildTransfer(intent: TransferIntent, ctx: TxContext): Promise<XrpUnsignedTx> {
    if (intent.amount < 0n) throw new Error('xrp: amount must be >= 0');
    const client = await this.client();
    const pubkey = await ctx.signer.publicKey();
    const compressed = toCompressedSecp256k1(pubkey);
    const base: Payment = {
      TransactionType: 'Payment',
      Account: ctx.sender,
      Destination: intent.to,
      Amount: intent.amount.toString(),
      // XRPL serializes SigningPubKey into both the signing pre-image and the
      // final tx blob, so it must be present before encodeForSigning.
      SigningPubKey: bytesToHex(compressed).toUpperCase(),
    };
    const tx = await client.autofill(base);
    return { tx };
  }

  async signRequests(tx: XrpUnsignedTx): Promise<SignRequest[]> {
    // XRPL ECDSA-secp256k1 signs `SHA512(encodeForSigning)[:32]` (the "half"
    // SHA-512 used by rippled). Our SoftSigner does NOT prehash, so this
    // method must return the 32-byte digest, not the raw signing pre-image.
    const hex = encodeForSigning(tx.tx);
    const pre = hexToBytes(hex);
    return [{ message: sha512(pre).slice(0, 32), prehashed: true }];
  }

  async applySignatures(tx: XrpUnsignedTx, signatures: Uint8Array[]): Promise<XrpSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`xrp: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 65) {
      throw new Error(`xrp: signature must be 65 bytes (r||s||recovery), got ${signature.length}`);
    }
    const signerPubKey = tx.tx.SigningPubKey;
    if (!signerPubKey) {
      throw new Error('xrp: SigningPubKey missing from tx; set it before applySignatures');
    }
    const r = bytesToBigInt(signature.subarray(0, 32));
    const s = bytesToBigInt(signature.subarray(32, 64));
    const sig = new secp256k1.Signature(r, s);
    const normalized = sig.hasHighS() ? sig.normalizeS() : sig;
    const der = normalized.toDERRawBytes();

    const signedTx: Payment = {
      ...tx.tx,
      TxnSignature: bytesToHex(der).toUpperCase(),
    };
    const txBlob = encode(signedTx);
    const hash = hashes.hashSignedTx(txBlob);
    return { txBlob, hash };
  }

  async broadcast(tx: XrpSignedTx): Promise<TxHash> {
    const client = await this.client();
    const res = await client.submitAndWait(tx.txBlob);
    // Prefer the on-chain tx hash when present, else our locally-computed hash.
    const result = res.result as { hash?: string };
    return result.hash ?? tx.hash;
  }

  /**
   * Returns a connected xrpl Client. Cached for reuse across calls.
   */
  async client(): Promise<Client> {
    if (this._client && this._client.isConnected()) return this._client;
    if (!this._client) this._client = new Client(this.wsUrl);
    if (!this._client.isConnected()) await this._client.connect();
    return this._client;
  }

  /**
   * Disconnect and release the underlying WebSocket client.
   * Safe to call multiple times.
   */
  async close(): Promise<void> {
    if (!this._client) return;
    if (this._client.isConnected()) {
      await this._client.disconnect();
    }
    this._client = null;
  }

  /**
   * Helper for callers that need to set the SigningPubKey on a built tx
   * before calling signRequests. The XRPL serialization includes
   * SigningPubKey, so it must be present in both signing and final blobs.
   */
  attachSigningPubKey(tx: XrpUnsignedTx, pubkey: Uint8Array): XrpUnsignedTx {
    const compressed = toCompressedSecp256k1(pubkey);
    return {
      tx: { ...tx.tx, SigningPubKey: bytesToHex(compressed).toUpperCase() },
    };
  }
}

function toCompressedSecp256k1(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)) {
    return pubkey;
  }
  if (pubkey.length === 65 && pubkey[0] === 0x04) {
    return secp256k1.ProjectivePoint.fromHex(pubkey).toRawBytes(true);
  }
  if (pubkey.length === 64) {
    const padded = new Uint8Array(65);
    padded[0] = 0x04;
    padded.set(pubkey, 1);
    return secp256k1.ProjectivePoint.fromHex(padded).toRawBytes(true);
  }
  throw new Error(`xrp: bad pubkey length=${pubkey.length}`);
}

function xrpToDrops(xrp: number): bigint {
  if (!Number.isFinite(xrp)) throw new Error(`xrp: non-finite balance ${xrp}`);
  if (xrp < 0) throw new Error(`xrp: negative balance ${xrp}`);
  if (xrp === 0) return 0n;
  if (xrp >= 1e15) throw new Error(`xrp: balance ${xrp} exceeds safe range`);
  // Use a string to avoid binary floating-point rounding for typical balances.
  const s = xrp.toFixed(6);
  if (s.includes('e') || s.includes('E')) {
    throw new Error(`xrp: unexpected scientific notation in toFixed result: ${s}`);
  }
  const [whole = '0', frac = ''] = s.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

function isActNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { data?: { error?: string }; message?: string };
  if (e.data?.error === 'actNotFound') return true;
  if (typeof e.message === 'string' && e.message.includes('actNotFound')) return true;
  return false;
}
