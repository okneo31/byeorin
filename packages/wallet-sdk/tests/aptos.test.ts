import { describe, expect, it } from 'vitest';
import { AptosAdapter, Wallet } from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

// Aptos addresses: 0x + 64 hex chars (32 bytes).
const APTOS_ADDR_RE = /^0x[0-9a-f]{64}$/;

describe('AptosAdapter (offline)', () => {
  const aptos = new AptosAdapter({ network: 'mainnet' });

  it('declares Petra-compatible identity', () => {
    expect(aptos.id).toBe('aptos:mainnet');
    expect(aptos.curve).toBe('ed25519');
    expect(aptos.coinType).toBe(637);
  });

  it("uses Petra path m/44'/637'/${account}'/0'/${index}'", () => {
    expect(aptos.derivationPath(0, 0)).toBe("m/44'/637'/0'/0'/0'");
    expect(aptos.derivationPath(1, 2)).toBe("m/44'/637'/1'/0'/2'");
  });

  it('derives a deterministic hex address from the known mnemonic', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(aptos);
    expect(acc.derivationPath).toBe("m/44'/637'/0'/0'/0'");
    expect(acc.address).toMatch(APTOS_ADDR_RE);
    // Snapshot pins exact address — regression in path/curve/sha3-256
    // auth-key derivation is caught immediately.
    expect(acc.address).toMatchInlineSnapshot(`"0xbfef909638ef90885158fdab9f56e216fd811fe25b32ead0bc2a272d66522bb0"`);
  });

  it('exposes a 32-byte Ed25519 pubkey for the derived account', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(aptos);
    expect(acc.publicKey.length).toBe(32);
  });

  it('produces distinct addresses across testnet/devnet networks (same derivation though)', () => {
    const testnet = new AptosAdapter({ network: 'testnet' });
    const devnet = new AptosAdapter({ network: 'devnet' });
    expect(testnet.id).toBe('aptos:testnet');
    expect(devnet.id).toBe('aptos:devnet');
    // Same key, same derivation → same on-chain address across networks.
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    expect(w.account(testnet).address).toBe(w.account(devnet).address);
  });
});

describe.skip('AptosAdapter (live testnet API)', () => {
  it('fetches APT balance for a known testnet address', async () => {
    const adapter = new AptosAdapter({ network: 'testnet' });
    // Aptos root address (always exists, balance 0 on testnet).
    const bal = await adapter.getBalance('0x1');
    expect(typeof bal).toBe('bigint');
    expect(bal >= 0n).toBe(true);
  });
});
