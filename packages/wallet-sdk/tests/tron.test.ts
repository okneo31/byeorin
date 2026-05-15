import { describe, expect, it } from 'vitest';
import { TronAdapter, Wallet } from '../src/index.js';

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
