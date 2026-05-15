// hdkey.test.ts — SLIP-0010 (Ed25519) conformance against published vectors.
//
// Source of test vectors:
//   https://github.com/satoshilabs/slips/blob/master/slip-0010.md
//   "Test vectors for ed25519"
//
// Why this exists:
//   Our `deriveEd25519` is a hand-rolled SLIP-0010 implementation (we don't
//   depend on a SLIP-0010 npm package). A regression in the master derivation
//   (HMAC key "ed25519 seed") or in the hardened child step (0x00 || k || ser32(i))
//   would silently change every derived Solana / Aptos / Sui / TON address.
//   Pinning two upstream vectors catches that immediately.

import { describe, expect, it } from 'vitest';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { deriveEd25519 } from '../src/crypto/hdkey.js';

interface VectorStep {
  /** Derivation path applied to the master seed. */
  path: string;
  /** Expected 32-byte master/derived private key (SLIP-0010 `k`). */
  expectedPrivKeyHex: string;
  /** Expected 32-byte raw Ed25519 public key (without the 0x00 prefix used
   *  in the SLIP-0010 "public key" column). */
  expectedPubKeyHex: string;
}

interface Vector {
  label: string;
  seedHex: string;
  steps: VectorStep[];
}

// Vectors copy/pasted from SLIP-0010. "public key" in the spec is prefixed
// with 0x00 (33 bytes total) to fit BIP-32-style storage; we strip that byte
// to compare to noble's 32-byte raw Ed25519 pubkey.
const VECTORS: Vector[] = [
  {
    label: 'Test vector 1 for ed25519',
    seedHex: '000102030405060708090a0b0c0d0e0f',
    steps: [
      {
        path: "m/0'",
        expectedPrivKeyHex:
          '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
        expectedPubKeyHex:
          '8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c',
      },
      {
        path: "m/0'/1'",
        expectedPrivKeyHex:
          'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
        expectedPubKeyHex:
          '1932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187',
      },
    ],
  },
  {
    label: 'Test vector 2 for ed25519',
    seedHex:
      'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542',
    steps: [
      {
        path: "m/0'",
        expectedPrivKeyHex:
          '1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635',
        expectedPubKeyHex:
          '86fab68dcb57aa196c77c5f264f215a112c22a912c10d123b0d03c3c28ef1037',
      },
      {
        path: "m/0'/2147483647'",
        expectedPrivKeyHex:
          'ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4',
        expectedPubKeyHex:
          '5ba3b9ac6e90e83effcd25ac4e58a1365a9e35a3d3ae5eb07b9e4d90bcf7506d',
      },
    ],
  },
];

describe('deriveEd25519 — SLIP-0010 conformance', () => {
  for (const v of VECTORS) {
    describe(v.label, () => {
      for (const step of v.steps) {
        it(`derives ${step.path}`, () => {
          const seed = hexToBytes(v.seedHex);
          const derived = deriveEd25519(seed, step.path);
          expect(bytesToHex(derived.privateKey)).toBe(step.expectedPrivKeyHex);
          // Noble's Ed25519 `getPublicKey` clamps internally per RFC 8032
          // and yields the 32-byte compressed point; SLIP-0010's "public key"
          // column prepends 0x00 to that.
          expect(bytesToHex(derived.publicKey)).toBe(step.expectedPubKeyHex);
        });
      }
    });
  }

  it('rejects non-hardened ed25519 paths (SLIP-0010 forbids them)', () => {
    const seed = hexToBytes('000102030405060708090a0b0c0d0e0f');
    expect(() => deriveEd25519(seed, 'm/0/1')).toThrow(/hardened/);
  });

  it('returns 32-byte private key and 32-byte public key', () => {
    const seed = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const out = deriveEd25519(seed, "m/0'");
    expect(out.privateKey.length).toBe(32);
    expect(out.publicKey.length).toBe(32);
  });
});
