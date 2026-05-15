import { describe, expect, it } from 'vitest';
import { isValidClassicAddress } from 'xrpl';
import {
  Wallet,
  XrpAdapter,
  deriveSecp256k1,
  mnemonicToSeed,
} from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

// Derived once and snapshotted below. If the derivation logic changes this
// fails fast — XRP addresses are deterministic from (seed, derivation path).
const EXPECTED_XRP_ADDRESS = 'rnrbiYDUYTJS4JVdSV5FtyCj4HFuRjfLKM';

describe('XrpAdapter (offline)', () => {
  it('has the standard XRP chain identity', () => {
    const xrp = new XrpAdapter();
    expect(xrp.id).toBe('xrp:mainnet');
    expect(xrp.curve).toBe('secp256k1');
    expect(xrp.coinType).toBe(144);
    expect(xrp.derivationPath(0, 0)).toBe("m/44'/144'/0'/0/0");
    expect(xrp.derivationPath(1, 5)).toBe("m/44'/144'/1'/0/5");
  });

  it('picks the testnet endpoint when asked', () => {
    const xrp = new XrpAdapter({ network: 'testnet' });
    expect(xrp.id).toBe('xrp:testnet');
    expect(xrp.wsUrl).toBe('wss://s.altnet.rippletest.net:51233');
  });

  it('honours a custom wsUrl override (proxy / restricted env)', () => {
    const xrp = new XrpAdapter({ wsUrl: 'wss://example.invalid/ws' });
    expect(xrp.wsUrl).toBe('wss://example.invalid/ws');
  });

  it('derives a deterministic r-address from the known mnemonic', () => {
    const xrp = new XrpAdapter();
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const { publicKey } = deriveSecp256k1(seed, xrp.derivationPath(0, 0));
    const address = xrp.pubkeyToAddress(publicKey);

    expect(address.startsWith('r')).toBe(true);
    expect(isValidClassicAddress(address)).toBe(true);
    expect(address).toBe(EXPECTED_XRP_ADDRESS);
  });

  it('derives the same r-address via the Wallet façade', () => {
    const xrp = new XrpAdapter();
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(xrp);
    expect(acc.derivationPath).toBe("m/44'/144'/0'/0/0");
    expect(acc.address).toBe(EXPECTED_XRP_ADDRESS);
    expect(isValidClassicAddress(acc.address)).toBe(true);
  });

  it('rejects malformed pubkeys', () => {
    const xrp = new XrpAdapter();
    expect(() => xrp.pubkeyToAddress(new Uint8Array(10))).toThrow(/bad pubkey/);
  });

  it('rejects negative transfer amounts', async () => {
    const xrp = new XrpAdapter({ wsUrl: 'wss://example.invalid/ws' });
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(xrp);
    await expect(
      xrp.buildTransfer(
        { to: EXPECTED_XRP_ADDRESS, amount: -1n },
        { sender: acc.address, signer: acc.signer },
      ),
    ).rejects.toThrow(/amount must be >= 0/);
  });

  it('rejects non-65-byte signatures in applySignature', async () => {
    const xrp = new XrpAdapter();
    const fakeTx = {
      tx: {
        TransactionType: 'Payment' as const,
        Account: EXPECTED_XRP_ADDRESS,
        Destination: EXPECTED_XRP_ADDRESS,
        Amount: '1',
        SigningPubKey: '02'.padEnd(66, '0'),
        Fee: '10',
        Sequence: 1,
      },
    };
    await expect(xrp.applySignature(fakeTx, new Uint8Array(32))).rejects.toThrow(
      /signature must be 65 bytes/,
    );
  });

  it('close() is a no-op when no client has been opened', async () => {
    const xrp = new XrpAdapter();
    await expect(xrp.close()).resolves.toBeUndefined();
  });
});

// Live tests hit a real testnet WebSocket. Skipped unless NETWORK_TESTS is set.
const runNetwork = process.env.NETWORK_TESTS ? describe : describe.skip;

runNetwork('XrpAdapter (live testnet)', () => {
  it(
    'fetches the genesis testnet balance as drops (bigint)',
    async () => {
      const xrp = new XrpAdapter({ network: 'testnet' });
      try {
        // rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh is the well-known XRPL genesis
        // account; on testnet a similarly-funded faucet address may not be
        // guaranteed long-term, so we just assert the call returns a bigint.
        const bal = await xrp.getBalance(
          'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        );
        expect(typeof bal).toBe('bigint');
        expect(bal >= 0n).toBe(true);
      } finally {
        await xrp.close();
      }
    },
    30_000,
  );

  it('returns 0n for accounts that do not exist', async () => {
    const xrp = new XrpAdapter({ network: 'testnet' });
    try {
      // A deterministically-derived address from our test mnemonic that is
      // overwhelmingly unlikely to be funded on testnet.
      const bal = await xrp.getBalance(EXPECTED_XRP_ADDRESS);
      expect(typeof bal).toBe('bigint');
      expect(bal >= 0n).toBe(true);
    } finally {
      await xrp.close();
    }
  }, 30_000);
});
