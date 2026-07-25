import { describe, expect, it } from 'vitest';
import {
  EvmAdapter,
  TTL_CHAIN,
  accountFromPrivateKey,
  privateKeyToHex,
} from '../src/index.js';

// Hardhat 의 첫 번째 default account 키 — 공개적으로 알려진 테스트 시드.
// 동일 주소: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
const HARDHAT_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HARDHAT_ADDR_0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

describe('accountFromPrivateKey', () => {
  const ttl = new EvmAdapter({ chain: TTL_CHAIN });

  it('derives the canonical Hardhat address from its first private key', () => {
    const acc = accountFromPrivateKey(HARDHAT_KEY_0, ttl);
    expect(acc.address.toLowerCase()).toBe(HARDHAT_ADDR_0);
    // raw-import 의 sentinel — derivationPath 가 빈 문자열.
    expect(acc.derivationPath).toBe('');
    expect(acc.publicKey.length).toBe(65); // uncompressed
  });

  it('accepts hex without 0x prefix', () => {
    const noPrefix = HARDHAT_KEY_0.slice(2);
    const acc = accountFromPrivateKey(noPrefix, ttl);
    expect(acc.address.toLowerCase()).toBe(HARDHAT_ADDR_0);
  });

  it('accepts uppercase hex', () => {
    const upper = HARDHAT_KEY_0.toUpperCase();
    const acc = accountFromPrivateKey(upper, ttl);
    expect(acc.address.toLowerCase()).toBe(HARDHAT_ADDR_0);
  });

  it('accepts Uint8Array', () => {
    const bytes = new Uint8Array(32);
    const hex = HARDHAT_KEY_0.slice(2);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const acc = accountFromPrivateKey(bytes, ttl);
    expect(acc.address.toLowerCase()).toBe(HARDHAT_ADDR_0);
  });

  it('rejects hex of wrong length', () => {
    expect(() => accountFromPrivateKey('0xdead', ttl)).toThrow(/64 chars/);
  });

  it('rejects non-hex characters', () => {
    const bad = '0x' + 'z'.repeat(64);
    expect(() => accountFromPrivateKey(bad, ttl)).toThrow(/non-hex/);
  });

  it('rejects zero key (out of secp256k1 range)', () => {
    const zero = '0x' + '00'.repeat(32);
    expect(() => accountFromPrivateKey(zero, ttl)).toThrow(/out of secp256k1/);
  });

  it('rejects key >= secp256k1 order', () => {
    // n = curve order
    const n = '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141';
    expect(() => accountFromPrivateKey(n, ttl)).toThrow(/out of secp256k1/);
  });

  it('produces a signer that can sign 32-byte digests', async () => {
    const acc = accountFromPrivateKey(HARDHAT_KEY_0, ttl);
    const digest = new Uint8Array(32);
    for (let i = 0; i < 32; i++) digest[i] = i;
    const sig = await acc.signer.sign(digest);
    // secp256k1 SoftSigner 의 시그너 출력 — r(32) + s(32) + recovery(1) = 65바이트
    expect(sig.length).toBe(65);
    expect(sig[64]).toBeGreaterThanOrEqual(0);
    expect(sig[64]).toBeLessThanOrEqual(1);
  });

  it('produces same address for the same key (deterministic)', () => {
    const a1 = accountFromPrivateKey(HARDHAT_KEY_0, ttl);
    const a2 = accountFromPrivateKey(HARDHAT_KEY_0, ttl);
    expect(a1.address).toBe(a2.address);
  });
});

describe('privateKeyToHex', () => {
  it('serializes 32 bytes as 0x-prefixed hex', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    const hex = privateKeyToHex(bytes);
    expect(hex).toBe('0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
  });

  it('rejects non-32-byte input', () => {
    expect(() => privateKeyToHex(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});
