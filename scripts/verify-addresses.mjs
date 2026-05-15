#!/usr/bin/env node
/**
 * Independent verification of cross-chain addresses derived by
 * `@nodong/wallet-sdk` from the standard test mnemonic:
 *   "test test test test test test test test test test test junk"
 *
 * For each chain we compute the address three ways:
 *   1. `expected` — the value claimed in the verification spec.
 *   2. `independent` — derived using the canonical upstream library's own
 *      helper, importing from wallet-sdk's node_modules so we use the
 *      already-installed versions (createRequire pinned to that package).
 *   3. `our_sdk`   — derived by instantiating the wallet-sdk's adapter
 *      freshly and calling `pubkeyToAddress` on the key derived by
 *      `Wallet#account`.
 *
 * Exit 0 iff all three agree on every row; exit 1 otherwise.
 *
 * NOTE: BTC and Solana have no fully-independent JS implementation already
 * installed (the adapter uses `@scure/btc-signer` and our own SLIP-0010
 * ed25519 derivation respectively). For those rows we re-implement the
 * canonical scheme by hand against `@noble/hashes` + `@scure/btc-signer`
 * primitives, calling them differently than the adapter does, so a bug
 * in the adapter wouldn't be masked by a shared helper.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = dirname(__dirname);

// Resolve every upstream lib from inside the wallet-sdk package so pnpm's
// flat-store layout doesn't get in our way.
const requireFromSdk = createRequire(
  join(REPO_ROOT, 'packages', 'wallet-sdk', 'package.json'),
);
// Resolve `ethers` from the repo root (it's added as a root devDep so we get
// a *different* implementation than viem's bundled hd-wallet code).
const requireFromRoot = createRequire(join(REPO_ROOT, 'package.json'));

const MNEMONIC = 'test test test test test test test test test test test junk';

/* ------------------------------------------------------------------ */
/* Claimed addresses to cross-check                                    */
/* ------------------------------------------------------------------ */
const CLAIMS = [
  {
    chain: 'TTL/EVM',
    path: "m/44'/60'/0'/0/0",
    expected: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    // Hardhat account #0 — well-known constant.
    independent: deriveEvmIndependent,
    ourSdk: deriveEvmOurSdk,
  },
  {
    chain: 'BTC p2wpkh',
    path: "m/84'/0'/0'/0/0",
    expected: 'bc1q4qw42stdzjqs59xvlrlxr8526e3nunw7mp73te',
    independent: deriveBtcIndependent,
    ourSdk: deriveBtcOurSdk,
  },
  {
    chain: 'XRP',
    path: "m/44'/144'/0'/0/0",
    expected: 'rnrbiYDUYTJS4JVdSV5FtyCj4HFuRjfLKM',
    independent: deriveXrpIndependent,
    ourSdk: deriveXrpOurSdk,
  },
  {
    chain: 'Cosmos Hub',
    path: "m/44'/118'/0'/0/0",
    expected: 'cosmos15yk64u7zc9g9k2yr2wmzeva5qgwxps6yxj00e7',
    independent: () => deriveCosmosIndependent('cosmos'),
    ourSdk: () => deriveCosmosOurSdk('cosmos'),
  },
  {
    chain: 'Osmosis',
    path: "m/44'/118'/0'/0/0",
    expected: 'osmo15yk64u7zc9g9k2yr2wmzeva5qgwxps6ywful0v',
    independent: () => deriveCosmosIndependent('osmo'),
    ourSdk: () => deriveCosmosOurSdk('osmo'),
  },
  {
    chain: 'Solana',
    path: "m/44'/501'/0'/0'",
    expected: 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96',
    independent: deriveSolanaIndependent,
    ourSdk: deriveSolanaOurSdk,
  },
  {
    chain: 'TRON',
    path: "m/44'/195'/0'/0/0",
    expected: 'TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6',
    independent: deriveTronIndependent,
    ourSdk: deriveTronOurSdk,
  },
  {
    chain: 'TON v4 bounceable',
    path: "m/44'/607'/0'",
    expected: 'EQAtUn6khf4MxnAB4aQNcDlUPNOsLtU8IOVZbIabFzw9Kbar',
    independent: deriveTonIndependent,
    ourSdk: deriveTonOurSdk,
  },
  {
    chain: 'Aptos',
    path: "m/44'/637'/0'/0'/0'",
    expected: '0xbfef909638ef90885158fdab9f56e216fd811fe25b32ead0bc2a272d66522bb0',
    independent: deriveAptosIndependent,
    ourSdk: deriveAptosOurSdk,
  },
  {
    chain: 'Sui',
    path: "m/44'/784'/0'/0'/0'",
    expected: '0xc88ef07b9b8b2fc3b7daad9478f4e1337f01792e2eab9c3794494e610636026e',
    independent: deriveSuiIndependent,
    ourSdk: deriveSuiOurSdk,
  },
];

/* ------------------------------------------------------------------ */
/* Shared SDK loading                                                   */
/* ------------------------------------------------------------------ */

async function loadSdk() {
  const url = new URL(
    'file://' +
      join(REPO_ROOT, 'packages', 'wallet-sdk', 'dist', 'index.js').replace(/\\/g, '/'),
  );
  return await import(url.href);
}

/* ------------------------------------------------------------------ */
/* EVM                                                                  */
/* ------------------------------------------------------------------ */

async function deriveEvmIndependent() {
  // ethers v6 has its own HDNodeWallet that derives from a BIP-39 phrase
  // independently of viem / our SDK.
  let ethers;
  try {
    ethers = requireFromRoot('ethers');
  } catch {
    // Fallback: use viem's mnemonicToAccount (different code path than our
    // adapter, which only consumes a raw pubkey).
    const { mnemonicToAccount } = requireFromSdk('viem/accounts');
    const acc = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
    return acc.address.toLowerCase();
  }
  const wallet = ethers.HDNodeWallet.fromPhrase(
    MNEMONIC,
    undefined,
    "m/44'/60'/0'/0/0",
  );
  return wallet.address.toLowerCase();
}

async function deriveEvmOurSdk() {
  const sdk = await loadSdk();
  const wallet = sdk.Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const adapter = new sdk.EvmAdapter({
    chain: sdk.TTL_CHAIN,
    rpcUrl: 'http://localhost:0', // never used for address derivation
  });
  const acc = wallet.account(adapter, 0, 0);
  return acc.address.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* BTC p2wpkh                                                           */
/* ------------------------------------------------------------------ */

async function deriveBtcIndependent() {
  // No second BTC library is installed, so we recompute the canonical
  // BIP-84 derivation using *different entry points* than the adapter:
  //   - The adapter calls `p2wpkh(pubkey, NETWORK).address`.
  //   - Here we re-derive the seed via @scure/bip39, the HD chain via
  //     @scure/bip32 HDKey.derive, and then format the bech32 address
  //     by hand from witness program v0 (HASH160(pubkey)).
  const { mnemonicToSeedSync } = requireFromSdk('@scure/bip39');
  const { HDKey } = requireFromSdk('@scure/bip32');
  const { sha256 } = requireFromSdk('@noble/hashes/sha256');
  const { ripemd160 } = requireFromSdk('@noble/hashes/ripemd160');
  const { bech32 } = requireFromSdk('@scure/base');

  const seed = mnemonicToSeedSync(MNEMONIC);
  const master = HDKey.fromMasterSeed(seed);
  const node = master.derive("m/84'/0'/0'/0/0");
  if (!node.publicKey) throw new Error('btc: no pubkey');
  const program = ripemd160(sha256(node.publicKey)); // HASH160
  // BIP-173 bech32 with HRP 'bc', witness version 0.
  const words = [0, ...bech32.toWords(program)];
  return bech32.encode('bc', words, 90);
}

async function deriveBtcOurSdk() {
  const sdk = await loadSdk();
  const wallet = sdk.Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const adapter = new sdk.BtcAdapter({ network: 'mainnet' });
  const acc = wallet.account(adapter, 0, 0);
  return acc.address;
}

/* ------------------------------------------------------------------ */
/* XRP                                                                  */
/* ------------------------------------------------------------------ */

async function deriveXrpIndependent() {
  const { Wallet } = requireFromSdk('xrpl');
  const w = Wallet.fromMnemonic(MNEMONIC, {
    derivationPath: "m/44'/144'/0'/0/0",
    mnemonicEncoding: 'bip39',
  });
  return w.classicAddress;
}

async function deriveXrpOurSdk() {
  const sdk = await loadSdk();
  const wallet = sdk.Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const adapter = new sdk.XrpAdapter({ network: 'mainnet' });
  const acc = wallet.account(adapter, 0, 0);
  return acc.address;
}

/* ------------------------------------------------------------------ */
/* Cosmos / Osmosis                                                     */
/* ------------------------------------------------------------------ */

async function deriveCosmosIndependent(prefix) {
  const { DirectSecp256k1HdWallet, makeCosmoshubPath } = requireFromSdk(
    '@cosmjs/proto-signing',
  );
  const w = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
    prefix,
    hdPaths: [makeCosmoshubPath(0)],
  });
  const accounts = await w.getAccounts();
  return accounts[0].address;
}

async function deriveCosmosOurSdk(prefix) {
  const sdk = await loadSdk();
  const wallet = sdk.Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const adapter = new sdk.CosmosAdapter({
    chainId: prefix === 'cosmos' ? 'cosmoshub-4' : 'osmosis-1',
    bech32Prefix: prefix,
    rpcUrl: 'http://localhost:0',
    denom: prefix === 'cosmos' ? 'uatom' : 'uosmo',
  });
  const acc = wallet.account(adapter, 0, 0);
  return acc.address;
}

/* ------------------------------------------------------------------ */
/* Solana                                                               */
/* ------------------------------------------------------------------ */

/**
 * Inline SLIP-0010 ed25519 derivation. Same spec the adapter implements
 * but written from scratch against @noble/hashes/hmac+sha512 to give us
 * a true second source. Compared to `deriveEd25519` in crypto/hdkey.ts,
 * this version uses an Uint8Array index serializer split across separate
 * stmts and a different concatenation pattern — so a refactor bug in
 * either implementation would surface here.
 */
function slip10Ed25519DerivePrivkey(seed, path) {
  const { hmac } = requireFromSdk('@noble/hashes/hmac');
  const { sha512 } = requireFromSdk('@noble/hashes/sha512');
  const KEY = new TextEncoder().encode('ed25519 seed');
  const I0 = hmac(sha512, KEY, seed);
  let kL = I0.slice(0, 32);
  let cc = I0.slice(32);

  const segs = path.replace(/^m\//, '').split('/');
  for (const s of segs) {
    if (!s.endsWith("'")) throw new Error('slip10: must be hardened');
    const idx = (parseInt(s.slice(0, -1), 10) | 0) + 0x80000000;
    const buf = new Uint8Array(37);
    buf[0] = 0;
    buf.set(kL, 1);
    // Big-endian 32-bit index, written byte-by-byte.
    buf[33] = (idx >>> 24) & 0xff;
    buf[34] = (idx >>> 16) & 0xff;
    buf[35] = (idx >>> 8) & 0xff;
    buf[36] = idx & 0xff;
    const I = hmac(sha512, cc, buf);
    kL = I.slice(0, 32);
    cc = I.slice(32);
  }
  return kL;
}

async function deriveSolanaIndependent() {
  const { mnemonicToSeedSync } = requireFromSdk('@scure/bip39');
  const { Keypair } = requireFromSdk('@solana/web3.js');
  const seed = mnemonicToSeedSync(MNEMONIC);
  const priv = slip10Ed25519DerivePrivkey(seed, "m/44'/501'/0'/0'");
  const kp = Keypair.fromSeed(priv);
  return kp.publicKey.toBase58();
}

async function deriveSolanaOurSdk() {
  const sdk = await loadSdk();
  const wallet = sdk.Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const adapter = new sdk.SolanaAdapter({ network: 'mainnet-beta' });
  const acc = wallet.account(adapter, 0, 0);
  return acc.address;
}

/* ------------------------------------------------------------------ */
/* TRON                                                                 */
/* ------------------------------------------------------------------ */

async function deriveTronIndependent() {
  const TronWebNs = requireFromSdk('tronweb');
  const TronWeb =
    TronWebNs.TronWeb ?? TronWebNs.default?.TronWeb ?? TronWebNs.default ?? TronWebNs;
  const out = TronWeb.fromMnemonic(MNEMONIC, "m/44'/195'/0'/0/0");
  return out.address;
}

async function deriveTronOurSdk() {
  const sdk = await loadSdk();
  const wallet = sdk.Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const adapter = new sdk.TronAdapter({ network: 'mainnet' });
  const acc = wallet.account(adapter, 0, 0);
  return acc.address;
}

/* ------------------------------------------------------------------ */
/* TON                                                                  */
/* ------------------------------------------------------------------ */

async function deriveTonIndependent() {
  // Independent path: derive the 32-byte ed25519 seed using our own
  // SLIP-0010 inlined function above, then convert seed -> keypair via
  // @ton/crypto's `keyPairFromSeed`, then ask @ton/ton's WalletContractV4
  // for the bounceable address. This crosses three different libraries
  // (@scure/bip39, @ton/crypto, @ton/ton) versus the adapter's
  // (own deriveEd25519 + @ton/ton).
  const { mnemonicToSeedSync } = requireFromSdk('@scure/bip39');
  const { keyPairFromSeed } = requireFromSdk('@ton/crypto');
  const { WalletContractV4 } = requireFromSdk('@ton/ton');
  const seed = mnemonicToSeedSync(MNEMONIC);
  const priv = slip10Ed25519DerivePrivkey(seed, "m/44'/607'/0'");
  const kp = keyPairFromSeed(Buffer.from(priv));
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: kp.publicKey,
  });
  return wallet.address.toString({ bounceable: true, urlSafe: true });
}

async function deriveTonOurSdk() {
  const sdk = await loadSdk();
  const wallet = sdk.Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const adapter = new sdk.TonAdapter({ network: 'mainnet' });
  const acc = wallet.account(adapter, 0, 0);
  return acc.address;
}

/* ------------------------------------------------------------------ */
/* Aptos                                                                */
/* ------------------------------------------------------------------ */

async function deriveAptosIndependent() {
  const { Account, SigningSchemeInput } = requireFromSdk('@aptos-labs/ts-sdk');
  // legacy=true gives the Petra/Aptos-CLI legacy Ed25519 auth-key formula:
  //   sha3-256(pubkey32 || 0x00)
  // which is exactly what our adapter computes by hand. legacy=false would
  // give a SingleKey scheme address (different bytes).
  const account = Account.fromDerivationPath({
    path: "m/44'/637'/0'/0'/0'",
    mnemonic: MNEMONIC,
    scheme: SigningSchemeInput.Ed25519,
    legacy: true,
  });
  return account.accountAddress.toString();
}

async function deriveAptosOurSdk() {
  const sdk = await loadSdk();
  const wallet = sdk.Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const adapter = new sdk.AptosAdapter({ network: 'mainnet' });
  const acc = wallet.account(adapter, 0, 0);
  return acc.address;
}

/* ------------------------------------------------------------------ */
/* Sui                                                                  */
/* ------------------------------------------------------------------ */

async function deriveSuiIndependent() {
  const { Ed25519Keypair } = requireFromSdk('@mysten/sui/keypairs/ed25519');
  const kp = Ed25519Keypair.deriveKeypair(MNEMONIC, "m/44'/784'/0'/0'/0'");
  return kp.getPublicKey().toSuiAddress();
}

async function deriveSuiOurSdk() {
  const sdk = await loadSdk();
  const wallet = sdk.Wallet.fromMnemonic({ mnemonic: MNEMONIC });
  const adapter = new sdk.SuiAdapter({ network: 'mainnet' });
  const acc = wallet.account(adapter, 0, 0);
  return acc.address;
}

/* ------------------------------------------------------------------ */
/* Runner                                                               */
/* ------------------------------------------------------------------ */

function eq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // EVM is case-insensitive (we normalize all sides to lowercase)
  return a === b;
}

async function safe(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, err: err?.stack ?? String(err) };
  }
}

async function main() {
  const rows = [];
  let allMatch = true;
  for (const claim of CLAIMS) {
    const expected = claim.expected;
    const indep = await safe(claim.independent);
    const ours = await safe(claim.ourSdk);

    // EVM is case-insensitive — normalize all three to lowercase for compare.
    const isEvm = claim.chain === 'TTL/EVM';
    const norm = (v) => (isEvm && typeof v === 'string' ? v.toLowerCase() : v);

    const independentVal = indep.ok ? norm(indep.value) : `ERR(${indep.err.split('\n')[0]})`;
    const ourSdkVal = ours.ok ? norm(ours.value) : `ERR(${ours.err.split('\n')[0]})`;
    const expectedNorm = norm(expected);

    const match =
      indep.ok && ours.ok && eq(expectedNorm, independentVal) && eq(expectedNorm, ourSdkVal);
    if (!match) allMatch = false;
    rows.push({
      chain: claim.chain,
      path: claim.path,
      expected: expectedNorm,
      independent: independentVal,
      our_sdk: ourSdkVal,
      match: match ? 'YES' : 'NO',
      _indepErr: indep.ok ? null : indep.err,
      _ourErr: ours.ok ? null : ours.err,
    });
  }

  const headers = ['chain', 'path', 'expected', 'independent', 'our_sdk', 'match'];
  const widths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => String(r[h]).length)),
  );
  const fmtRow = (cells) =>
    cells
      .map((c, i) => String(c).padEnd(widths[i]))
      .join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  const lines = [];
  lines.push(fmtRow(headers));
  lines.push(sep);
  for (const r of rows) {
    lines.push(fmtRow(headers.map((h) => r[h])));
  }
  lines.push('');
  const matchCount = rows.filter((r) => r.match === 'YES').length;
  lines.push(`Match: ${matchCount} / ${rows.length}`);
  if (!allMatch) {
    lines.push('');
    lines.push('=== MISMATCHES ===');
    for (const r of rows) {
      if (r.match === 'YES') continue;
      lines.push(`- ${r.chain} (${r.path})`);
      lines.push(`    expected    : ${r.expected}`);
      lines.push(`    independent : ${r.independent}`);
      lines.push(`    our_sdk     : ${r.our_sdk}`);
      if (r._indepErr) lines.push(`    indep err   : ${r._indepErr.split('\n').slice(0, 4).join(' | ')}`);
      if (r._ourErr) lines.push(`    sdk err     : ${r._ourErr.split('\n').slice(0, 4).join(' | ')}`);
    }
  }
  const report = lines.join('\n');
  console.log(report);

  // Persist a copy.
  const outDir = join(REPO_ROOT, 'verification');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'addresses.txt'), report + '\n', 'utf8');

  process.exit(allMatch ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
