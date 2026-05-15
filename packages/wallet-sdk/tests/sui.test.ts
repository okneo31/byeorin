import { describe, expect, it } from 'vitest';
import { SuiAdapter, Wallet } from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

// Sui addresses: 0x + 64 hex chars (32 bytes).
const SUI_ADDR_RE = /^0x[0-9a-f]{64}$/;

describe('SuiAdapter (offline)', () => {
  const sui = new SuiAdapter({ network: 'mainnet' });

  it('declares Sui Wallet–compatible identity', () => {
    expect(sui.id).toBe('sui:mainnet');
    expect(sui.curve).toBe('ed25519');
    expect(sui.coinType).toBe(784);
  });

  it("uses Sui path m/44'/784'/${account}'/0'/${index}'", () => {
    expect(sui.derivationPath(0, 0)).toBe("m/44'/784'/0'/0'/0'");
    expect(sui.derivationPath(1, 2)).toBe("m/44'/784'/1'/0'/2'");
  });

  it('derives a deterministic 0x-hex address from the known mnemonic', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(sui);
    expect(acc.derivationPath).toBe("m/44'/784'/0'/0'/0'");
    expect(acc.address).toMatch(SUI_ADDR_RE);
    // Snapshot pins exact address — regression in path/curve/blake2b256
    // address derivation (flag byte, dkLen=32) is caught immediately.
    expect(acc.address).toMatchInlineSnapshot(`"0xc88ef07b9b8b2fc3b7daad9478f4e1337f01792e2eab9c3794494e610636026e"`);
  });

  it('exposes a 32-byte Ed25519 pubkey for the derived account', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(sui);
    expect(acc.publicKey.length).toBe(32);
  });

  it('produces same address across testnet/devnet (key-only derivation)', () => {
    const testnet = new SuiAdapter({ network: 'testnet' });
    const devnet = new SuiAdapter({ network: 'devnet' });
    expect(testnet.id).toBe('sui:testnet');
    expect(devnet.id).toBe('sui:devnet');
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    expect(w.account(testnet).address).toBe(w.account(devnet).address);
  });
});

describe.skip('SuiAdapter (live testnet RPC)', () => {
  it('fetches SUI balance for a known testnet address', async () => {
    const adapter = new SuiAdapter({ network: 'testnet' });
    const bal = await adapter.getBalance(
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(typeof bal).toBe('bigint');
    expect(bal >= 0n).toBe(true);
  });
});
