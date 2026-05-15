import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import type { Curve, Signer } from '../types.js';

export interface SoftSignerOptions {
  curve: Curve;
  privateKey: Uint8Array;
}

/**
 * In-memory software signer for secp256k1 (ECDSA) and ed25519 (EdDSA).
 *
 * Curve semantics:
 *   - secp256k1 — input is the 32-byte private scalar `d`. `sign()` runs
 *     ECDSA with `lowS:true` (BIP-146) and emits a 65-byte
 *     `r(32) || s(32) || recovery(1)` blob (raw recovery, 0|1). Adapters that
 *     need EVM-style v=27|28 normalize at applySignatures.
 *   - ed25519 — input is the 32-byte EdDSA *seed* per RFC 8032 (not the
 *     already-clamped scalar). @noble/curves' Ed25519 implementation applies
 *     SHA-512 to the seed and clamps the lower half internally before
 *     producing the public key and signatures, exactly as RFC 8032 §5.1.5
 *     specifies. Callers must therefore pass the raw 32-byte secret produced
 *     by SLIP-0010 / BIP-32 (Ed25519 derivation in `deriveEd25519`) without
 *     any pre-clamping of their own.
 */
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
    // Ed25519 pubkey derivation: noble hashes(SHA-512) the seed, clamps the
    // lower half, multiplies the base point, encodes 32 bytes. RFC 8032
    // conformant — do not pre-clamp `this.key`.
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
    // Ed25519: noble applies the RFC 8032 clamping & nonce derivation
    // internally. `message` is the raw payload (Ed25519 hashes it as part of
    // the signature equation).
    return ed25519.sign(message, this.key);
  }
}
