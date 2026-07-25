import { describe, expect, it } from 'vitest';
import { fromBech32 } from '@cosmjs/encoding';
import { hexToBytes } from '@noble/hashes/utils';
import { mnemonicToAccount } from 'viem/accounts';
import { CosmosAdapter, Wallet } from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

// Public RPC for live tests. Skipped unless NETWORK_TESTS is set so CI stays
// hermetic and we don't depend on third-party uptime.
const COSMOS_HUB_RPC =
  process.env.COSMOS_HUB_RPC ?? 'https://cosmos-rpc.publicnode.com';

const RUN_LIVE = !!process.env.NETWORK_TESTS;

describe('CosmosAdapter — offline', () => {
  const cosmosHub = new CosmosAdapter({
    chainId: 'cosmoshub-4',
    bech32Prefix: 'cosmos',
    rpcUrl: COSMOS_HUB_RPC,
    denom: 'uatom',
  });

  const osmosis = new CosmosAdapter({
    chainId: 'osmosis-1',
    bech32Prefix: 'osmo',
    rpcUrl: 'https://rpc.osmosis.zone',
    denom: 'uosmo',
  });

  it('exposes the right chain identity', () => {
    expect(cosmosHub.id).toBe('cosmos:cosmoshub-4');
    expect(cosmosHub.curve).toBe('secp256k1');
    expect(cosmosHub.coinType).toBe(118);
  });

  it('builds a SLIP-44 derivation path with coinType 118 by default', () => {
    expect(cosmosHub.derivationPath()).toBe("m/44'/118'/0'/0/0");
    expect(cosmosHub.derivationPath(0, 3)).toBe("m/44'/118'/0'/0/3");
  });

  it('honours coinType override (e.g. 60 for Injective)', () => {
    const inj = new CosmosAdapter({
      chainId: 'injective-1',
      bech32Prefix: 'inj',
      rpcUrl: 'http://localhost',
      denom: 'inj',
      coinType: 60,
    });
    expect(inj.coinType).toBe(60);
    expect(inj.derivationPath()).toBe("m/44'/60'/0'/0/0");
  });

  it('derives a cosmos1 address from the known mnemonic', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(cosmosHub);
    expect(acc.derivationPath).toBe("m/44'/118'/0'/0/0");
    expect(acc.address.startsWith('cosmos1')).toBe(true);
    // Deterministic snapshot — must not drift across runs/platforms.
    expect(acc.address).toBe(
      'cosmos15yk64u7zc9g9k2yr2wmzeva5qgwxps6yxj00e7',
    );
  });

  it('derives an osmo1 address that shares raw bytes with cosmos1 (same key)', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const cosmosAcc = w.account(cosmosHub);
    const osmoAcc = w.account(osmosis);

    expect(osmoAcc.address.startsWith('osmo1')).toBe(true);

    const cosmosRaw = fromBech32(cosmosAcc.address);
    const osmoRaw = fromBech32(osmoAcc.address);

    expect(cosmosRaw.prefix).toBe('cosmos');
    expect(osmoRaw.prefix).toBe('osmo');
    // Raw 20-byte address (ripemd160(sha256(pubkey))) must be identical:
    // proves the same key reaches the same account across Cosmos chains.
    expect(Buffer.from(osmoRaw.data).toString('hex')).toBe(
      Buffer.from(cosmosRaw.data).toString('hex'),
    );
  });

  it('pubkeyToAddress accepts compressed, uncompressed, and 64-byte pubkeys', async () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(cosmosHub);
    const compressed = acc.publicKey;
    expect(compressed.length).toBe(33);

    // From compressed.
    expect(cosmosHub.pubkeyToAddress(compressed)).toBe(acc.address);

    // From uncompressed (65, 0x04 prefix).
    const { secp256k1 } = await import('@noble/curves/secp256k1');
    const uncompressed = secp256k1.ProjectivePoint.fromHex(compressed).toRawBytes(false);
    expect(uncompressed.length).toBe(65);
    expect(cosmosHub.pubkeyToAddress(uncompressed)).toBe(acc.address);

    // From 64-byte raw (no 0x04 prefix).
    const raw64 = uncompressed.slice(1);
    expect(raw64.length).toBe(64);
    expect(cosmosHub.pubkeyToAddress(raw64)).toBe(acc.address);
  });

  it('rejects malformed pubkeys', () => {
    expect(() => cosmosHub.pubkeyToAddress(new Uint8Array(10))).toThrow(
      /bad pubkey length/,
    );
  });

  it('signRequests returns a single 32-byte prehashed sha256 digest', async () => {
    // We can build a SignDoc-shaped tx directly; we don't need a live RPC here.
    // Synthesise minimal bodyBytes / authInfoBytes / signDoc via private path:
    // simpler — just smoke-test the hash size via a forged unsigned tx.
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(cosmosHub);

    // Forge a SignDoc-like object: makeSignBytes only reads the four fields.
    const forged = {
      signDoc: {
        bodyBytes: new Uint8Array([1, 2, 3]),
        authInfoBytes: new Uint8Array([4, 5, 6]),
        chainId: 'cosmoshub-4',
        accountNumber: 0n,
      } as unknown as Parameters<typeof cosmosHub.signRequests>[0]['signDoc'],
      bodyBytes: new Uint8Array([1, 2, 3]),
      authInfoBytes: new Uint8Array([4, 5, 6]),
      chainId: 'cosmoshub-4',
      accountNumber: 0,
      signerInfo: { pubKey: acc.publicKey, address: acc.address },
    };

    const requests = await cosmosHub.signRequests(forged);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.message).toBeInstanceOf(Uint8Array);
    expect(requests[0]!.message.length).toBe(32);
    expect(requests[0]!.prehashed).toBe(true);
  });

  it('applySignatures builds a TxRaw and uppercase-hex sha256 hash', async () => {
    const fakeUnsigned = {
      signDoc: {} as unknown as Parameters<
        typeof cosmosHub.applySignatures
      >[0]['signDoc'],
      bodyBytes: new Uint8Array([10, 20, 30]),
      authInfoBytes: new Uint8Array([40, 50, 60]),
      chainId: 'cosmoshub-4',
      accountNumber: 0,
      signerInfo: { pubKey: new Uint8Array(33), address: 'cosmos1...' },
    };
    // 65-byte signature: 64-byte compact + 1 recovery byte (which we strip).
    const sig = new Uint8Array(65);
    // Use a valid low-S signature: r=1, s=1 is valid for our encoder.
    sig[31] = 1;
    sig[63] = 1;
    sig[64] = 0;

    const signed = await cosmosHub.applySignatures(fakeUnsigned, [sig]);
    expect(signed.txBytes).toBeInstanceOf(Uint8Array);
    expect(signed.txBytes.length).toBeGreaterThan(
      fakeUnsigned.bodyBytes.length + fakeUnsigned.authInfoBytes.length,
    );
    expect(signed.hash).toMatch(/^[0-9A-F]{64}$/);
  });

  it('applySignatures rejects non-64/65-byte signatures', async () => {
    const fakeUnsigned = {
      signDoc: {} as unknown as Parameters<
        typeof cosmosHub.applySignatures
      >[0]['signDoc'],
      bodyBytes: new Uint8Array([1]),
      authInfoBytes: new Uint8Array([2]),
      chainId: 'cosmoshub-4',
      accountNumber: 0,
      signerInfo: { pubKey: new Uint8Array(33), address: 'cosmos1...' },
    };
    await expect(
      cosmosHub.applySignatures(fakeUnsigned, [new Uint8Array(32)]),
    ).rejects.toThrow(/signature must be 64 or 65 bytes/);
  });
});

describe('CosmosAdapter — Injective (Ethermint, evmAddressing)', () => {
  const injective = new CosmosAdapter({
    chainId: 'injective-1',
    bech32Prefix: 'inj',
    rpcUrl: 'http://localhost',
    denom: 'inj',
    coinType: 60,
    evmAddressing: true,
  });

  it('exposes the right Injective chain identity', () => {
    expect(injective.id).toBe('cosmos:injective-1');
    expect(injective.coinType).toBe(60);
    expect(injective.bech32Prefix).toBe('inj');
    expect(injective.evmAddressing).toBe(true);
    expect(injective.derivationPath()).toBe("m/44'/60'/0'/0/0");
  });

  it('derives an inj1 address whose 20-byte payload equals the EVM address', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(injective);

    // Bech32 sanity.
    expect(acc.address.startsWith('inj1')).toBe(true);
    expect(acc.address.length).toBe(42);

    const decoded = fromBech32(acc.address);
    expect(decoded.prefix).toBe('inj');
    expect(decoded.data.length).toBe(20);

    // Compute the EVM-equivalent 0x.. address from the SAME mnemonic at the
    // SAME path via viem — the trailing 20 bytes must match the bech32 payload.
    // This is the Injective ↔ EVM key-compat property.
    const evmAccount = mnemonicToAccount(KNOWN_MNEMONIC, {
      path: "m/44'/60'/0'/0/0",
    });
    const evmHex = evmAccount.address.toLowerCase().replace(/^0x/, '');
    expect(evmHex.length).toBe(40);
    const evmBytes = hexToBytes(evmHex);

    expect(Buffer.from(decoded.data).toString('hex')).toBe(
      Buffer.from(evmBytes).toString('hex'),
    );
  });

  it('differs from a classic Cosmos-style derivation for the same key', () => {
    // Same prefix, same key, but ethermint vs classic must yield different
    // 20-byte payloads (keccak vs ripemd160(sha256)).
    const injClassic = new CosmosAdapter({
      chainId: 'injective-1',
      bech32Prefix: 'inj',
      rpcUrl: 'http://localhost',
      denom: 'inj',
      coinType: 60,
      // evmAddressing omitted -> defaults to false
    });
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const injAcc = w.account(injective);
    const classicAcc = w.account(injClassic);

    expect(injAcc.address).not.toBe(classicAcc.address);
    const a = fromBech32(injAcc.address).data;
    const b = fromBech32(classicAcc.address).data;
    expect(Buffer.from(a).toString('hex')).not.toBe(
      Buffer.from(b).toString('hex'),
    );
  });
});

describe('CosmosAdapter — customMsgTypes & buildTx', () => {
  // A minimal GeneratedType: encodes/decodes a single proto-bytes field.
  // Used only to prove the Registry is layered correctly — we do not need a
  // real ZION message here (M2 covers that).
  const FAKE_TYPE_URL = '/zion.test.v1.MsgPing';
  const fakeGenerated = {
    encode(value: { payload: Uint8Array }) {
      // Pretend wire-format: just return the payload. Registry only needs
      // an object with `.encode(value).finish()`.
      return {
        finish: () => value.payload,
      };
    },
    decode(_bytes: Uint8Array) {
      return { payload: new Uint8Array() };
    },
    fromPartial(p: { payload: Uint8Array }) {
      return { payload: p.payload };
    },
  } as unknown as Parameters<
    InstanceType<typeof CosmosAdapter>['registry']['register']
  >[1];

  it('customMsgTypes registers extra types in the registry', () => {
    const adapter = new CosmosAdapter({
      chainId: 'zion',
      bech32Prefix: 'zion',
      rpcUrl: 'http://localhost',
      denom: 'utrg',
      customMsgTypes: [[FAKE_TYPE_URL, fakeGenerated]],
    });
    // Registry.lookupType returns undefined for unknown type URLs.
    expect(adapter.registry.lookupType(FAKE_TYPE_URL)).toBe(fakeGenerated);
    // defaultRegistryTypes still present.
    expect(
      adapter.registry.lookupType('/cosmos.bank.v1beta1.MsgSend'),
    ).toBeDefined();
  });

  it('omitting customMsgTypes leaves the registry at defaults only', () => {
    const adapter = new CosmosAdapter({
      chainId: 'cosmoshub-4',
      bech32Prefix: 'cosmos',
      rpcUrl: 'http://localhost',
      denom: 'uatom',
    });
    expect(adapter.registry.lookupType(FAKE_TYPE_URL)).toBeUndefined();
    expect(
      adapter.registry.lookupType('/cosmos.bank.v1beta1.MsgSend'),
    ).toBeDefined();
  });

  it('buildTx rejects empty message arrays (no degenerate tx)', async () => {
    const adapter = new CosmosAdapter({
      chainId: 'cosmoshub-4',
      bech32Prefix: 'cosmos',
      rpcUrl: 'http://localhost',
      denom: 'uatom',
    });
    // We don't need a working signer here — the empty-message guard fires
    // before any account lookup or signer call.
    const stubCtx = {
      sender: 'cosmos1...',
      signer: {
        publicKey: async () => new Uint8Array(33),
      },
    } as unknown as Parameters<typeof adapter.buildTx>[1];
    await expect(adapter.buildTx([], stubCtx)).rejects.toThrow(
      /requires at least one message/,
    );
  });
});

describe.skipIf(!RUN_LIVE)('CosmosAdapter — live RPC', () => {
  it('fetches a balance from a live Cosmos Hub RPC', async () => {
    const adapter = new CosmosAdapter({
      chainId: 'cosmoshub-4',
      bech32Prefix: 'cosmos',
      rpcUrl: COSMOS_HUB_RPC,
      denom: 'uatom',
    });
    // Cosmos Hub community pool / a known account — pick the well-known
    // address derived from the test mnemonic. The balance might be 0 — we
    // just want a successful BigInt response.
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(adapter);
    const bal = await adapter.getBalance(acc.address);
    expect(typeof bal).toBe('bigint');
    expect(bal >= 0n).toBe(true);
  });
});
