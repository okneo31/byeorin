// SIGNATURE FORMAT VERIFIED 2026-05-16:
// TronWeb v6 expects r(32)||s(32)||(recovery+27) — i.e. EVM-style v.
// SoftSigner emits raw `recovery` (0|1), so applySignatures must add 27
// before writing the last byte. Cross-checked against
// `tronweb/utils/crypto.signTransaction` (which calls ECKeySign:
// `r.padStart(64,'0') + s.padStart(64,'0') + byte2hexStr(recovery + 27)`).
// See tests/tron.test.ts "signature matches TronWeb's own signer".
import { toUncompressedSecp256k1 } from '../crypto/secp.js';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

// TronWeb v6 ships dual ESM/CJS but its types are loose.
// Use a typed dynamic import via createRequire-style namespace import
// and unwrap `.default` if present (CJS interop quirk).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as TronWebNs from 'tronweb';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TronWebMod: any = (TronWebNs as any).TronWeb ?? (TronWebNs as any).default?.TronWeb ?? (TronWebNs as any).default ?? TronWebNs;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tronUtils: any = (TronWebNs as any).utils ?? (TronWebNs as any).default?.utils;

export type TronNetwork = 'mainnet' | 'shasta' | 'nile';

export interface TronAdapterOptions {
  network?: TronNetwork;
  fullHost?: string;
}

// TronWeb's transaction shape is loose. Keep it as `any` and document.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TronUnsignedTx { tx: any }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TronSignedTx { tx: any; txid: string }

const DEFAULT_HOST: Record<TronNetwork, string> = {
  mainnet: 'https://api.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
};

/**
 * TronAdapter — Tron mainnet/shasta/nile.
 *
 * Address derivation mirrors Ethereum's keccak trick but prepends 0x41
 * and base58check-encodes the result (21-byte raw → 25-byte with checksum).
 *
 * Sun caveat: 1 TRX = 1e6 SUN. TronWeb's `sendTrx` accepts a JS `number`
 * (safe up to ~9e15 SUN ≈ 9e9 TRX). We coerce bigint → Number and throw
 * if it would lose precision.
 */
export class TronAdapter
  implements ChainAdapter<TronUnsignedTx, TronSignedTx>
{
  readonly id: string;
  readonly displayName: string;
  readonly curve = 'secp256k1' as const;
  readonly coinType = 195;
  readonly network: TronNetwork;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tron: any;

  constructor(opts: TronAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.id = `tron:${this.network}`;
    this.displayName =
      this.network === 'mainnet' ? 'TRON' : `TRON ${this.network}`;
    const host = opts.fullHost ?? DEFAULT_HOST[this.network];
    if (!TronWebMod) {
      throw new Error('tron: TronWeb module unavailable');
    }
    this.tron = new TronWebMod({ fullHost: host });
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    const uncompressed = toUncompressedSecp256k1(pubkey);
    // computeAddress takes either 65-byte (with 0x04) or 64-byte (no prefix)
    // and returns 21 bytes: [0x41, ...keccak256(pub[1:])[-20:]].
    const addressBytes: number[] = tronUtils.crypto.computeAddress(
      Array.from(uncompressed),
    );
    return tronUtils.crypto.getBase58CheckAddress(addressBytes);
  }

  async getBalance(address: Address): Promise<bigint> {
    const sun = await this.tron.trx.getBalance(address);
    return BigInt(sun);
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<TronUnsignedTx> {
    const sun = bigintToSafeNumber(intent.amount, 'tron sun');
    const tx = await this.tron.transactionBuilder.sendTrx(
      intent.to,
      sun,
      ctx.sender,
    );
    return { tx };
  }

  async signRequests(tx: TronUnsignedTx): Promise<SignRequest[]> {
    // The signing target is sha256(raw_data_hex), which Tron precomputes
    // and exposes as `txID`. Convert hex → bytes.
    const txid: string = tx.tx.txID;
    if (typeof txid !== 'string' || txid.length !== 64) {
      throw new Error('tron: malformed unsigned tx (missing/bad txID)');
    }
    return [{ message: hexToBytes(txid), prehashed: true }];
  }

  async applySignatures(
    tx: TronUnsignedTx,
    signatures: Uint8Array[],
  ): Promise<TronSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`tron: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 65) {
      throw new Error(
        `tron: secp256k1 signature must be 65 bytes (r||s||v), got ${signature.length}`,
      );
    }
    // SoftSigner emits the last byte as raw recovery (0 or 1).
    // TronWeb's reference signer encodes the last byte as (recovery + 27)
    // — see ECKeySign in tronweb/utils/crypto.js. Normalize here so a
    // raw `recovery >= 2` is rejected and a `27/28` byte from a hardware
    // signer that already encoded `v` is left untouched.
    const recoveryRaw = signature[64] as number;
    let v: number;
    if (recoveryRaw === 0 || recoveryRaw === 1) {
      v = recoveryRaw + 27;
    } else if (recoveryRaw === 27 || recoveryRaw === 28) {
      v = recoveryRaw;
    } else {
      throw new Error(
        `tron: signature recovery byte must be 0|1|27|28, got ${recoveryRaw}`,
      );
    }
    const normalized = new Uint8Array(signature);
    normalized[64] = v;
    const hex = bytesToHex(normalized);
    tx.tx.signature = [hex];
    return { tx: tx.tx, txid: tx.tx.txID };
  }

  async broadcast(tx: TronSignedTx): Promise<TxHash> {
    await this.tron.trx.sendRawTransaction(tx.tx);
    return tx.txid;
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

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error('tron: bad hex length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += (b[i] as number).toString(16).padStart(2, '0');
  }
  return s;
}
