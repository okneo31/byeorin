import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import type { Curve, Signer } from '../types.js';

export interface SoftSignerOptions {
  curve: Curve;
  privateKey: Uint8Array;
}

export class SoftSigner implements Signer {
  readonly curve: Curve;
  private readonly key: Uint8Array;

  constructor(opts: SoftSignerOptions) {
    if (opts.privateKey.length !== 32) {
      throw new Error(`signer: privateKey must be 32 bytes, got ${opts.privateKey.length}`);
    }
    this.curve = opts.curve;
    this.key = new Uint8Array(opts.privateKey);
  }

  async publicKey(): Promise<Uint8Array> {
    if (this.curve === 'secp256k1') return secp256k1.getPublicKey(this.key, false);
    return ed25519.getPublicKey(this.key);
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    if (this.curve === 'secp256k1') {
      const sig = secp256k1.sign(message, this.key, { lowS: true });
      const out = new Uint8Array(65);
      out.set(sig.toCompactRawBytes(), 0);
      out[64] = sig.recovery ?? 0;
      return out;
    }
    return ed25519.sign(message, this.key);
  }
}
