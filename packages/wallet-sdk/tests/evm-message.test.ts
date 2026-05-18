// evm-message.test.ts — EIP-191 personal-sign helper coverage.
//
// Cross-checks `signEvmMessage` against viem's reference signer
// (`signMessage`) bit-for-bit. viem is itself test-vector-verified against
// the MetaMask reference and on-chain `ecrecover`, so byte equivalence here
// transitively pins us to the canonical personal-sign output.

import { describe, expect, it } from 'vitest';
import { recoverMessageAddress } from 'viem';
import { privateKeyToAccount, signMessage } from 'viem/accounts';
import { bytesToHex } from '@noble/hashes/utils';
import { signEvmMessage, SoftSigner, Wallet, EvmAdapter, TTL_CHAIN } from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

// Hardhat account #0's well-known private key for the above mnemonic at
// m/44'/60'/0'/0/0. Pinned so this test does not depend on the EVM adapter
// remaining identical — only on the EIP-191 signing path.
const HARDHAT_PRIVKEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('signEvmMessage — EIP-191 personal_sign', () => {
  it('produces a byte-identical signature to viem.signMessage for a UTF-8 string', async () => {
    const account = privateKeyToAccount(HARDHAT_PRIVKEY);
    const privBytes = hexToBytes(HARDHAT_PRIVKEY.slice(2));
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey: privBytes });

    const message = 'Hello byeorin';
    const ours = await signEvmMessage(signer, account.address, message);
    const viemSig = await signMessage({
      message,
      privateKey: HARDHAT_PRIVKEY,
    });
    expect(ours).toBe(viemSig);
  });

  it('produces a byte-identical signature for a raw Uint8Array message', async () => {
    const account = privateKeyToAccount(HARDHAT_PRIVKEY);
    const privBytes = hexToBytes(HARDHAT_PRIVKEY.slice(2));
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey: privBytes });

    const raw = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0xff]);
    const ours = await signEvmMessage(signer, account.address, raw);
    const viemSig = await signMessage({
      message: { raw: `0x${bytesToHex(raw)}` as `0x${string}` },
      privateKey: HARDHAT_PRIVKEY,
    });
    expect(ours).toBe(viemSig);
  });

  it('recovers to the signing address via viem.recoverMessageAddress', async () => {
    const account = privateKeyToAccount(HARDHAT_PRIVKEY);
    const privBytes = hexToBytes(HARDHAT_PRIVKEY.slice(2));
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey: privBytes });

    const message = 'recover-roundtrip';
    const sig = await signEvmMessage(signer, account.address, message);
    const recovered = await recoverMessageAddress({ message, signature: sig });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('emits 65 bytes of hex with v ∈ {27, 28}', async () => {
    const privBytes = hexToBytes(HARDHAT_PRIVKEY.slice(2));
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey: privBytes });
    const sig = await signEvmMessage(signer, '0x0', 'len-check');
    expect(sig.startsWith('0x')).toBe(true);
    // 65 bytes = 130 hex chars (+2 for 0x prefix).
    expect(sig.length).toBe(2 + 130);
    const v = parseInt(sig.slice(-2), 16);
    expect([27, 28]).toContain(v);
  });

  it('works against a Wallet-derived signer (full SDK path)', async () => {
    const ttl = new EvmAdapter({ chain: TTL_CHAIN });
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(ttl);

    const message = 'sdk-path';
    const sig = await signEvmMessage(acc.signer, acc.address, message);
    const recovered = await recoverMessageAddress({ message, signature: sig });
    expect(recovered.toLowerCase()).toBe(acc.address.toLowerCase());
  });

  it('rejects an ed25519 signer with a clear error', async () => {
    const ed = new SoftSigner({
      curve: 'ed25519',
      privateKey: new Uint8Array(32),
    });
    await expect(signEvmMessage(ed, '0x0', 'nope')).rejects.toThrow(
      /requires secp256k1/,
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
