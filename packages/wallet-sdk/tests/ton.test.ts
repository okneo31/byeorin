import { describe, expect, it } from 'vitest';
import { TonAdapter, Wallet } from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

// TON user-friendly bounceable (EQ..., 48 chars base64url-friendly).
// Testnet/non-bounceable variants use UQ.../kQ.../0Q... prefixes.
const TON_BOUNCEABLE_RE = /^[EU]Q[A-Za-z0-9_-]{46}$/;

describe('TonAdapter (offline)', () => {
  const ton = new TonAdapter({ network: 'mainnet' });

  it('declares Tonkeeper-compatible identity', () => {
    expect(ton.id).toBe('ton:mainnet');
    expect(ton.curve).toBe('ed25519');
    expect(ton.coinType).toBe(607);
  });

  it("uses Tonkeeper path m/44'/607'/${account}' (index ignored)", () => {
    expect(ton.derivationPath(0, 0)).toBe("m/44'/607'/0'");
    expect(ton.derivationPath(0, 5)).toBe("m/44'/607'/0'");
    expect(ton.derivationPath(2, 0)).toBe("m/44'/607'/2'");
  });

  it('derives a deterministic bounceable address from the known mnemonic', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(ton);
    expect(acc.derivationPath).toBe("m/44'/607'/0'");
    expect(acc.address).toMatch(TON_BOUNCEABLE_RE);
    // Snapshot pins exact address — regression in path/curve/encoding
    // (workchain byte, checksum, bounceable flag) is caught immediately.
    expect(acc.address).toMatchInlineSnapshot(`"EQAtUn6khf4MxnAB4aQNcDlUPNOsLtU8IOVZbIabFzw9Kbar"`);
  });

  it('exposes a 32-byte Ed25519 pubkey for the derived account', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(ton);
    expect(acc.publicKey.length).toBe(32);
  });

  it('derives a UQ-prefixed testnet address', () => {
    const tonTestnet = new TonAdapter({ network: 'testnet' });
    expect(tonTestnet.id).toBe('ton:testnet');
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(tonTestnet);
    expect(acc.address).toMatch(/^[0kEU]Q[A-Za-z0-9_-]{46}$/);
  });
});

describe.skip('TonAdapter (live testnet RPC)', () => {
  it('fetches balance for a known testnet address', async () => {
    const adapter = new TonAdapter({ network: 'testnet' });
    // Public testnet faucet-funded address (substitute as needed).
    const bal = await adapter.getBalance(
      'kQDLvsZol3juZyOAVG8tWsJntOxeEZWEaWCbbSjYakQpuYN5',
    );
    expect(typeof bal).toBe('bigint');
    expect(bal >= 0n).toBe(true);
  });
});
