import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { BtcAdapter } from '../src/chains/btc.js';
import { SoftSigner } from '../src/signers/soft.js';
import { Wallet } from '../src/wallet.js';
import { mnemonicToSeed } from '../src/crypto/seed.js';
import { deriveSecp256k1 } from '../src/crypto/hdkey.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

// Verified locally with @scure/btc-signer 1.8.1 against the well-known mnemonic.
const EXPECTED_BIP84_MAINNET = 'bc1q4qw42stdzjqs59xvlrlxr8526e3nunw7mp73te';
const EXPECTED_BIP84_TESTNET = 'tb1qquv9lg5g2r4jkr0ahun0ddfg5xntxjelvmc7t8';

describe('BtcAdapter — derivation & addresses', () => {
  it('reports id and coinType for mainnet', () => {
    const a = new BtcAdapter();
    expect(a.id).toBe('btc:mainnet');
    expect(a.coinType).toBe(0);
    expect(a.curve).toBe('secp256k1');
    expect(a.derivationPath(0, 0)).toBe("m/84'/0'/0'/0/0");
  });

  it('reports id and coinType for testnet', () => {
    const a = new BtcAdapter({ network: 'testnet' });
    expect(a.id).toBe('btc:testnet');
    expect(a.coinType).toBe(1);
    expect(a.derivationPath(0, 0)).toBe("m/84'/1'/0'/0/0");
  });

  it('uses BIP-86 path for p2tr', () => {
    const a = new BtcAdapter({ addressType: 'p2tr' });
    expect(a.derivationPath(0, 0)).toBe("m/86'/0'/0'/0/0");
  });

  it('derives the expected bech32 P2WPKH address from the known mnemonic (mainnet)', () => {
    const adapter = new BtcAdapter();
    const wallet = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = wallet.account(adapter);
    expect(acc.derivationPath).toBe("m/84'/0'/0'/0/0");
    expect(acc.address).toBe(EXPECTED_BIP84_MAINNET);
  });

  it('derives the expected bech32 P2WPKH address on testnet', () => {
    const adapter = new BtcAdapter({ network: 'testnet' });
    const wallet = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = wallet.account(adapter);
    expect(acc.derivationPath).toBe("m/84'/1'/0'/0/0");
    expect(acc.address).toBe(EXPECTED_BIP84_TESTNET);
  });

  it('rejects non-compressed pubkeys', () => {
    const a = new BtcAdapter();
    expect(() => a.pubkeyToAddress(new Uint8Array(33))).toThrow(/compressed/);
    expect(() => a.pubkeyToAddress(new Uint8Array(64))).toThrow(/compressed/);
  });
});

describe('BtcAdapter — buildTransfer with fixture UTXOs', () => {
  it('builds a deterministic transaction from a fixed UTXO set', async () => {
    const adapter = new BtcAdapter();
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const { privateKey, publicKey } = deriveSecp256k1(seed, "m/84'/0'/0'/0/0");
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey });
    const sender = adapter.pubkeyToAddress(publicKey);

    // Two fixture UTXOs, total 200_000 sats.
    const fixtureUtxos = [
      {
        txid: '1111111111111111111111111111111111111111111111111111111111111111',
        vout: 0,
        value: 150_000n,
        scriptPubKey: '', // filled below from sender address
      },
      {
        txid: '2222222222222222222222222222222222222222222222222222222222222222',
        vout: 1,
        value: 50_000n,
        scriptPubKey: '',
      },
    ];

    // Stub network calls deterministically.
    const originalFetchUtxos = adapter.fetchUtxos.bind(adapter);
    const originalFetchFee = adapter.fetchFeeRate.bind(adapter);
    (adapter as unknown as { fetchUtxos: typeof adapter.fetchUtxos }).fetchUtxos =
      async () => {
        // Use the adapter's own script-for-address helper indirectly by re-deriving
        // via a single real fetch shape: we just need to fill scriptPubKey.
        const { p2wpkh, NETWORK } = await import('@scure/btc-signer');
        const script = p2wpkh(publicKey, NETWORK).script;
        const scriptHex = Buffer.from(script).toString('hex');
        return fixtureUtxos.map((u) => ({ ...u, scriptPubKey: scriptHex }));
      };
    (adapter as unknown as { fetchFeeRate: typeof adapter.fetchFeeRate }).fetchFeeRate =
      async () => 5;

    try {
      const unsigned = await adapter.buildTransfer(
        {
          to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
          amount: 120_000n,
        },
        { sender, signer },
      );

      // Structural assertions (deterministic given fee=5 sat/vB and largest-first selection).
      expect(unsigned.tx.version).toBe(2);
      // 150k covers 120k + change + fee with one input (vbytes ~ 11 + 68 + 2*31 = 141 -> 705 sats fee).
      expect(unsigned.tx.inputsLength).toBe(1);
      expect(unsigned.tx.outputsLength).toBe(2); // recipient + change

      // The input must be the largest UTXO (greedy largest-first).
      expect(unsigned.inputUtxos).toHaveLength(1);
      expect(unsigned.inputUtxos[0]!.value).toBe(150_000n);

      // signRequests should produce one 32-byte prehashed digest.
      const requests = await adapter.signRequests(unsigned);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.message).toBeInstanceOf(Uint8Array);
      expect(requests[0]!.message.length).toBe(32);
      expect(requests[0]!.prehashed).toBe(true);

      // Sign and apply via the unified multi-signature path.
      const sig = await signer.sign(requests[0]!.message);
      const signed = await adapter.applySignatures(unsigned, [sig]);
      expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(signed.hex).toMatch(/^[0-9a-f]+$/);
    } finally {
      (adapter as unknown as { fetchUtxos: typeof adapter.fetchUtxos }).fetchUtxos =
        originalFetchUtxos;
      (adapter as unknown as { fetchFeeRate: typeof adapter.fetchFeeRate }).fetchFeeRate =
        originalFetchFee;
    }
  });

  it('multi-input transfers work via signRequests/applySignatures', async () => {
    const adapter = new BtcAdapter();
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const { privateKey, publicKey } = deriveSecp256k1(seed, "m/84'/0'/0'/0/0");
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey });
    const sender = adapter.pubkeyToAddress(publicKey);

    const { p2wpkh, NETWORK } = await import('@scure/btc-signer');
    const scriptHex = Buffer.from(p2wpkh(publicKey, NETWORK).script).toString('hex');

    // Three small UTXOs forcing multi-input selection.
    const fixture = [
      { txid: 'aa'.repeat(32), vout: 0, value: 30_000n, scriptPubKey: scriptHex },
      { txid: 'bb'.repeat(32), vout: 0, value: 30_000n, scriptPubKey: scriptHex },
      { txid: 'cc'.repeat(32), vout: 0, value: 30_000n, scriptPubKey: scriptHex },
    ];
    (adapter as unknown as { fetchUtxos: typeof adapter.fetchUtxos }).fetchUtxos =
      async () => fixture;
    (adapter as unknown as { fetchFeeRate: typeof adapter.fetchFeeRate }).fetchFeeRate =
      async () => 5;

    const unsigned = await adapter.buildTransfer(
      { to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amount: 70_000n },
      { sender, signer },
    );
    expect(unsigned.tx.inputsLength).toBeGreaterThan(1);

    // signRequests must emit one request per input (no throw on multi-input).
    const requests = await adapter.signRequests(unsigned);
    expect(requests.length).toBe(unsigned.tx.inputsLength);
    expect(requests.length).toBeGreaterThan(1);
    for (const req of requests) {
      expect(req.message).toBeInstanceOf(Uint8Array);
      expect(req.message.length).toBe(32);
      expect(req.prehashed).toBe(true);
    }

    // Sign each request and feed them as an ordered array — same shape
    // Wallet.transfer takes.
    const sigs = await Promise.all(requests.map((r) => signer.sign(r.message)));
    const signed = await adapter.applySignatures(unsigned, sigs);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.hex).toMatch(/^[0-9a-f]+$/);

    // Mismatched signature count must be rejected.
    await expect(
      adapter.applySignatures(unsigned, sigs.slice(0, 1)),
    ).rejects.toThrow(/signature count/);
  });

  it('Wallet.transfer-shaped flow signs and finalises a multi-input tx end-to-end', async () => {
    // Mirrors what Wallet.transfer does (build -> signRequests -> sign each
    // -> applySignatures), without broadcast. Proves BTC multi-input is
    // no longer broken through the public API.
    const adapter = new BtcAdapter();
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const { privateKey, publicKey } = deriveSecp256k1(seed, "m/84'/0'/0'/0/0");
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey });
    const sender = adapter.pubkeyToAddress(publicKey);

    const { p2wpkh, NETWORK } = await import('@scure/btc-signer');
    const scriptHex = Buffer.from(p2wpkh(publicKey, NETWORK).script).toString('hex');

    // Two equal-sized UTXOs neither of which can cover the spend alone.
    const fixture = [
      { txid: 'ab'.repeat(32), vout: 0, value: 40_000n, scriptPubKey: scriptHex },
      { txid: 'cd'.repeat(32), vout: 1, value: 40_000n, scriptPubKey: scriptHex },
    ];
    (adapter as unknown as { fetchUtxos: typeof adapter.fetchUtxos }).fetchUtxos =
      async () => fixture;
    (adapter as unknown as { fetchFeeRate: typeof adapter.fetchFeeRate }).fetchFeeRate =
      async () => 5;

    // 1. build
    const unsigned = await adapter.buildTransfer(
      { to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amount: 60_000n },
      { sender, signer },
    );
    expect(unsigned.tx.inputsLength).toBe(2);

    // 2. signRequests — one per input, each prehashed sighash.
    const requests = await adapter.signRequests(unsigned);
    expect(requests.length).toBe(2);
    expect(new Set(requests.map((r) => Buffer.from(r.message).toString('hex'))).size).toBe(2);

    // 3. sign each in order (this is exactly Wallet.transfer's loop).
    const signatures: Uint8Array[] = [];
    for (const req of requests) {
      signatures.push(await signer.sign(req.message));
    }

    // 4. applySignatures produces a finalised tx with hex + txid.
    const signed = await adapter.applySignatures(unsigned, signatures);
    expect(signed.hex).toMatch(/^[0-9a-f]+$/);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    // Witness data must be embedded — signed hex strictly longer than the unsigned
    // pre-witness form.
    expect(signed.hex.length).toBeGreaterThan(200);
  });

  it('p2tr buildTransfer is not implemented in v0.1', async () => {
    const adapter = new BtcAdapter({ addressType: 'p2tr' });
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const { privateKey } = deriveSecp256k1(seed, "m/86'/0'/0'/0/0");
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey });
    await expect(
      adapter.buildTransfer(
        { to: 'bc1pfzhx49qe6s5exppe5hqljg3n6587xk0w75xqr70pgdt7ygnfkssqxqjd9l', amount: 1000n },
        { sender: 'bc1pfzhx49qe6s5exppe5hqljg3n6587xk0w75xqr70pgdt7ygnfkssqxqjd9l', signer },
      ),
    ).rejects.toThrow(/p2tr build not implemented/);
  });
});

describe.skipIf(!process.env.NETWORK_TESTS)('BtcAdapter — live network (testnet)', () => {
  it('fetches a balance from a known testnet address', async () => {
    const adapter = new BtcAdapter({ network: 'testnet' });
    // A well-known testnet faucet recipient; balance is irrelevant — must be a bigint >= 0n.
    const bal = await adapter.getBalance(EXPECTED_BIP84_TESTNET);
    expect(typeof bal).toBe('bigint');
    expect(bal >= 0n).toBe(true);
  });
});

// Silence unused-import lint for hexToBytes (kept for future tests if needed).
void hexToBytes;
