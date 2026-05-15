import { secp256k1 } from '@noble/curves/secp256k1';

/**
 * Normalize any valid secp256k1 pubkey form (33-byte compressed,
 * 64-byte uncompressed without 0x04 prefix, or 65-byte uncompressed)
 * into the canonical 33-byte compressed form.
 */
export function toCompressedSecp256k1(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)) return pubkey;
  if (pubkey.length === 65 && pubkey[0] === 0x04) {
    return secp256k1.ProjectivePoint.fromHex(pubkey).toRawBytes(true);
  }
  if (pubkey.length === 64) {
    const padded = new Uint8Array(65);
    padded[0] = 0x04;
    padded.set(pubkey, 1);
    return secp256k1.ProjectivePoint.fromHex(padded).toRawBytes(true);
  }
  throw new Error(`secp256k1: bad pubkey length=${pubkey.length}`);
}

/**
 * Normalize any valid secp256k1 pubkey form into the canonical 65-byte
 * uncompressed form (with 0x04 prefix).
 */
export function toUncompressedSecp256k1(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length === 65 && pubkey[0] === 0x04) return pubkey;
  if (pubkey.length === 64) {
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(pubkey, 1);
    return out;
  }
  if (pubkey.length === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)) {
    return secp256k1.ProjectivePoint.fromHex(pubkey).toRawBytes(false);
  }
  throw new Error(`secp256k1: bad pubkey length=${pubkey.length}`);
}
