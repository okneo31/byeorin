// address-vectors.test.ts — published / cross-implementation address vectors.
//
// Each chain adapter has an inline snapshot pinning its derivation, but those
// snapshots only catch *changes*, not initial mis-implementation. This file
// cross-validates derivations against an *independent* reference per chain
// (different vendor's library implementing the same standard). If any
// adapter's address differs from the reference for the same mnemonic + path,
// the test fails.
//
// References used:
//   - Aptos:  @aptos-labs/ts-sdk Account.fromDerivationPath
//   - Solana: @solana/web3.js Keypair.fromSeed (paired with our SLIP-0010
//             derivation — itself verified in hdkey.test.ts)
//   - Cosmos: @cosmjs/proto-signing DirectSecp256k1HdWallet.fromMnemonic

import { describe, expect, it } from 'vitest';
import { Account } from '@aptos-labs/ts-sdk';
import { Keypair } from '@solana/web3.js';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import {
  AptosAdapter,
  CosmosAdapter,
  SolanaAdapter,
  Wallet,
  deriveEd25519,
  mnemonicToSeed,
} from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

describe('Aptos — cross-check vs @aptos-labs/ts-sdk Account.fromDerivationPath', () => {
  const aptos = new AptosAdapter({ network: 'mainnet' });
  const path = "m/44'/637'/0'/0'/0'";

  it('derives the same authentication-key address from the same mnemonic + path', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const ours = w.account(aptos);

    const ref = Account.fromDerivationPath({
      path,
      mnemonic: KNOWN_MNEMONIC,
    });
    // ts-sdk's AccountAddress.toString() returns the same 0x..64-hex form.
    const refAddress = ref.accountAddress.toString();
    expect(ours.derivationPath).toBe(path);
    expect(ours.address).toBe(refAddress);
  });
});

describe('Solana — cross-check vs @solana/web3.js Keypair.fromSeed', () => {
  const sol = new SolanaAdapter({ network: 'mainnet-beta' });
  const path = "m/44'/501'/0'/0'";

  it('derives the same base58 address from the same mnemonic + path', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const ours = w.account(sol);

    // Re-derive via Solana's reference path: SLIP-0010 ed25519 child key →
    // 32-byte seed → Keypair.fromSeed. SLIP-0010 itself is independently
    // verified in hdkey.test.ts. This cross-check pins the pubkey → base58
    // address step against Solana's own implementation.
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const derived = deriveEd25519(seed, path);
    const kp = Keypair.fromSeed(derived.privateKey);
    expect(ours.derivationPath).toBe(path);
    expect(ours.address).toBe(kp.publicKey.toBase58());
  });
});

describe('Cosmos — cross-check vs @cosmjs/proto-signing DirectSecp256k1HdWallet', () => {
  const cosmosHub = new CosmosAdapter({
    chainId: 'cosmoshub-4',
    bech32Prefix: 'cosmos',
    rpcUrl: 'http://localhost',
    denom: 'uatom',
  });
  const path = "m/44'/118'/0'/0/0";

  it('derives the same cosmos1 address as cosmjs HD wallet from the same mnemonic + default path', async () => {
    // cosmjs's default `hdPaths` is exactly the Cosmos Hub path
    // `m/44'/118'/0'/0/0` — so we don't need stringToPath (which lives in
    // @cosmjs/crypto, not a direct dep of this package).
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const ours = w.account(cosmosHub);

    const refWallet = await DirectSecp256k1HdWallet.fromMnemonic(KNOWN_MNEMONIC, {
      prefix: 'cosmos',
    });
    const [refAccount] = await refWallet.getAccounts();
    expect(ours.derivationPath).toBe(path);
    expect(ours.address).toBe(refAccount!.address);
  });

  it('also matches cosmjs for an osmo1 derivation (different bech32 HRP, same key + default path)', async () => {
    // Osmosis also uses SLIP-44 coinType 118 (it's not coinType-isolated from
    // Cosmos Hub), so the default cosmjs path works for it too.
    const osmosis = new CosmosAdapter({
      chainId: 'osmosis-1',
      bech32Prefix: 'osmo',
      rpcUrl: 'http://localhost',
      denom: 'uosmo',
    });
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const ours = w.account(osmosis);

    const refWallet = await DirectSecp256k1HdWallet.fromMnemonic(KNOWN_MNEMONIC, {
      prefix: 'osmo',
    });
    const [refAccount] = await refWallet.getAccounts();
    expect(ours.address).toBe(refAccount!.address);
  });
});
