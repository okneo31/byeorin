import { describe, expect, it } from 'vitest';
import { SolanaAdapter, Wallet } from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

// Base58 alphabet (Bitcoin / Solana variant — no 0, O, I, l).
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

describe('SolanaAdapter (offline)', () => {
  const sol = new SolanaAdapter({ network: 'mainnet-beta' });

  it('declares Phantom-compatible identity', () => {
    expect(sol.id).toBe('solana:mainnet-beta');
    expect(sol.curve).toBe('ed25519');
    expect(sol.coinType).toBe(501);
  });

  it("uses Phantom path m/44'/501'/${index}'/0'", () => {
    expect(sol.derivationPath(0, 0)).toBe("m/44'/501'/0'/0'");
    expect(sol.derivationPath(0, 3)).toBe("m/44'/501'/3'/0'");
  });

  it('derives a deterministic base58 address from the known mnemonic', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(sol);
    expect(acc.derivationPath).toBe("m/44'/501'/0'/0'");
    expect(acc.address).toMatch(BASE58_RE);
    expect(acc.address.length).toBeGreaterThanOrEqual(32);
    expect(acc.address.length).toBeLessThanOrEqual(44);
    // Snapshot — pins the exact address so any regression in derivation
    // (path/curve/encoding) is caught immediately.
    expect(acc.address).toMatchInlineSnapshot(
      `"oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96"`,
    );
  });
});

describe.skip('SolanaAdapter (live devnet RPC)', () => {
  it('fetches balance for a known devnet address', async () => {
    const adapter = new SolanaAdapter({ network: 'devnet' });
    // Solana faucet/test address (well-known).
    const bal = await adapter.getBalance(
      '4Nd1mY5jY4n6cZqJZGz8sQjg7gVgZ8wK9Vy3kqM1Y5Xv',
    );
    expect(typeof bal).toBe('bigint');
    expect(bal >= 0n).toBe(true);
  });
});
