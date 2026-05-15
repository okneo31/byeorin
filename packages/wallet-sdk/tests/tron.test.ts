import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as TronWebNs from 'tronweb';
import { SoftSigner, TronAdapter, Wallet } from '../src/index.js';
import type { TronUnsignedTx } from '../src/chains/tron.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tronUtils: any =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (TronWebNs as any).utils ?? (TronWebNs as any).default?.utils;

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

// Tron base58check addresses are 34 chars and start with 'T'.
const TRON_ADDR_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

describe('TronAdapter (offline)', () => {
  const tron = new TronAdapter({ network: 'mainnet' });

  it('declares correct identity', () => {
    expect(tron.id).toBe('tron:mainnet');
    expect(tron.curve).toBe('secp256k1');
    expect(tron.coinType).toBe(195);
  });

  it("uses BIP44 path m/44'/195'/${account}'/0/${index}", () => {
    expect(tron.derivationPath(0, 0)).toBe("m/44'/195'/0'/0/0");
    expect(tron.derivationPath(1, 2)).toBe("m/44'/195'/1'/0/2");
  });

  it("derives a T-prefixed base58check address from the known mnemonic", () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(tron);
    expect(acc.derivationPath).toBe("m/44'/195'/0'/0/0");
    expect(acc.address).toMatch(TRON_ADDR_RE);
    // Snapshot — pins the exact address so any regression in derivation
    // (path/curve/encoding/0x41 prefix) is caught immediately.
    expect(acc.address).toMatchInlineSnapshot(
      `"TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6"`,
    );
  });
});

describe('TronAdapter signature format (offline)', () => {
  // Deterministic 32-byte private key (fixed seed, not a wallet anyone uses).
  // sha256("nodong-tron-sig-test-seed") — chosen for reproducibility.
  const seedLabel = 'nodong-tron-sig-test-seed';
  const privateKey = sha256(new TextEncoder().encode(seedLabel));
  const privateKeyHex = bytesToHex(privateKey);

  // A deterministic, non-network "raw_data_hex" payload. Tron's signing
  // contract is sha256(raw_data_hex) -> txID, and both TronWeb's reference
  // signer and our adapter sign exactly that digest. The semantic content
  // of raw_data_hex is irrelevant to the signature path being verified.
  const rawDataHex =
    '0a02487b2208cafebabedeadbeef40a8d8c4f6f02e5a65080112610a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412300a1541a614f803b6fd780986a42c78ec9c7f77e6ded13c121541cd09cce0d2658c8d20cd0e6e4f0d6e9c44d3f5e0a18809691f4b78201';
  const rawDataBytes = hexToBytes(rawDataHex);
  // txID is sha256(raw_data_hex_bytes), per Tron protocol & TronWeb.
  const txID = bytesToHex(sha256(rawDataBytes));

  it('test fixture is a valid secp256k1 private key', () => {
    // Pins seed → key validity. If a future seed change produces an
    // invalid scalar (≥ N), this fails first with a clear message.
    expect(privateKey.length).toBe(32);
    expect(secp256k1.utils.isValidPrivateKey(privateKey)).toBe(true);
  });

  it("signature matches TronWeb's own signer", async () => {
    // --- Reference path: TronWeb's utils.crypto.signTransaction ---
    const refTx: { txID: string; raw_data_hex: string; signature?: string[] } =
      { txID, raw_data_hex: rawDataHex };
    const signedRef = tronUtils.crypto.signTransaction(privateKeyHex, refTx);
    expect(Array.isArray(signedRef.signature)).toBe(true);
    expect(signedRef.signature.length).toBe(1);
    const refSigHex: string = signedRef.signature[0];
    expect(refSigHex).toHaveLength(130); // 65 bytes hex

    // Reference txID is preserved (sanity).
    expect(signedRef.txID).toBe(txID);

    // The last byte must be 27 or 28 (EVM-style v), as TronWeb's
    // ECKeySign produces `recovery + 27`.
    const refV = parseInt(refSigHex.slice(128, 130), 16);
    expect([27, 28]).toContain(refV);

    // --- Our path: TronAdapter.signRequests + SoftSigner + applySignatures ---
    const adapter = new TronAdapter({ network: 'mainnet' });
    const ourTx: TronUnsignedTx = {
      tx: { txID, raw_data_hex: rawDataHex },
    };
    const reqs = await adapter.signRequests(ourTx);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.prehashed).toBe(true);
    // The signing target must be the txID bytes.
    expect(bytesToHex(reqs[0]!.message)).toBe(txID);

    const signer = new SoftSigner({ curve: 'secp256k1', privateKey });
    const rawSig = await signer.sign(reqs[0]!.message);
    expect(rawSig.length).toBe(65);
    // SoftSigner emits raw recovery (0|1) — pre-normalization.
    expect([0, 1]).toContain(rawSig[64]);

    const signedOurs = await adapter.applySignatures(ourTx, [rawSig]);
    expect(Array.isArray(signedOurs.tx.signature)).toBe(true);
    expect(signedOurs.tx.signature.length).toBe(1);
    const ourSigHex: string = signedOurs.tx.signature[0];

    // --- Byte-for-byte equivalence ---
    // TronWeb's ECKeySign produces lowercase r||s but uppercase v
    // (via byte2hexStr → '0123456789ABCDEF'); ours is all-lowercase.
    // Tron's hex parser is case-insensitive, so the *bytes* must match
    // exactly even if the lowercased hex strings only match after
    // normalization. Assert both.
    expect(ourSigHex.toLowerCase()).toBe(refSigHex.toLowerCase());
    expect(hexToBytes(ourSigHex)).toEqual(hexToBytes(refSigHex));
    expect(signedOurs.txid).toBe(signedRef.txID);

    // Also assert the recovery normalization: our last byte is v=27|28,
    // not the raw 0|1 SoftSigner emitted.
    const ourV = parseInt(ourSigHex.slice(128, 130), 16);
    expect(ourV).toBe(rawSig[64]! + 27);
    expect([27, 28]).toContain(ourV);
  });

  it('applySignatures passes through a pre-encoded v=27/28 untouched', async () => {
    // Hardware signers may already return r||s||(recovery+27).
    // Verify the normalization in applySignatures is idempotent.
    const adapter = new TronAdapter({ network: 'mainnet' });
    const ourTx: TronUnsignedTx = {
      tx: { txID, raw_data_hex: rawDataHex },
    };
    const reqs = await adapter.signRequests(ourTx);
    const rawSig = await new SoftSigner({
      curve: 'secp256k1',
      privateKey,
    }).sign(reqs[0]!.message);
    const preEncoded = new Uint8Array(rawSig);
    preEncoded[64] = rawSig[64]! + 27; // already in EVM form

    const signedOurs = await adapter.applySignatures(ourTx, [preEncoded]);
    const hex: string = signedOurs.tx.signature[0];
    // Last byte must still be preEncoded[64] — NOT preEncoded[64] + 27.
    expect(parseInt(hex.slice(128, 130), 16)).toBe(preEncoded[64]);
  });

  it('applySignatures rejects a malformed recovery byte', async () => {
    const adapter = new TronAdapter({ network: 'mainnet' });
    const ourTx: TronUnsignedTx = {
      tx: { txID, raw_data_hex: rawDataHex },
    };
    const bogus = new Uint8Array(65);
    bogus[64] = 99; // not 0|1|27|28
    await expect(adapter.applySignatures(ourTx, [bogus])).rejects.toThrow(
      /recovery byte/,
    );
  });

  // Boundary check: only 0|1|27|28 are accepted. Anything else — including
  // the values just adjacent to the accepted ranges — must throw cleanly.
  it.each([
    { label: '2 (off-by-one above 0|1)', byte: 2 },
    { label: '26 (one below 27)', byte: 26 },
    { label: '29 (one above 28)', byte: 29 },
    { label: '255 (max u8)', byte: 255 },
  ])('applySignatures rejects recovery byte $label', async ({ byte }) => {
    const adapter = new TronAdapter({ network: 'mainnet' });
    const ourTx: TronUnsignedTx = {
      tx: { txID, raw_data_hex: rawDataHex },
    };
    const reqs = await adapter.signRequests(ourTx);
    const goodSig = await new SoftSigner({
      curve: 'secp256k1',
      privateKey,
    }).sign(reqs[0]!.message);
    // Splice a bogus recovery byte onto otherwise-valid r||s.
    const tampered = new Uint8Array(goodSig);
    tampered[64] = byte;
    await expect(adapter.applySignatures(ourTx, [tampered])).rejects.toThrow(
      /recovery byte/,
    );
  });
});

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
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

describe.skip('TronAdapter (live shasta testnet RPC)', () => {
  it('fetches balance for a known testnet address', async () => {
    const adapter = new TronAdapter({ network: 'shasta' });
    const bal = await adapter.getBalance(
      'TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6',
    );
    expect(typeof bal).toBe('bigint');
    expect(bal >= 0n).toBe(true);
  });
});
