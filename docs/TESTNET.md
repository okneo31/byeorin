# TTL Network Access — Mainnet & Testnet

This document records what we know (and probed) about TTL chain RPC
endpoints, the state of a public testnet, and how to broadcast a
transaction against either from the `@byeorin/wallet-sdk`.

---

## 1. Mainnet — confirmed working

| Field | Value |
| --- | --- |
| RPC HTTP | `https://rpc.ttl1.top` |
| RPC WebSocket | `wss://ws.ttl1.top` |
| Block explorer | `https://scan.ttl1.top` |
| Chain ID | **7777** (`0x1e61`) |
| Native currency | TTL (18 decimals) |
| Geth fork | 1.13.15 |
| SLIP-0044 coin type | 60 (uses standard EVM `m/44'/60'/0'/0/x`) |

Quick check:

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  https://rpc.ttl1.top
# → {"jsonrpc":"2.0","id":1,"result":"0x1e61"}
```

The wallet-sdk registers TTL as the default EVM chain — see
`packages/wallet-sdk/src/chains/registry.ts` (`TTL_CHAIN`).

---

## 2. Testnet — not currently exposed

### What we probed (2026-05-16)

We tried JSON-RPC `eth_chainId` against every plausible subdomain:

| Endpoint | Result |
| --- | --- |
| `https://rpc-testnet.ttl1.top` | empty response (TLS connects but server returns no body) |
| `https://testnet.ttl1.top` | empty response |
| `https://testnet-rpc.ttl1.top` | empty response |
| `https://rpc.testnet.ttl1.top` | empty response |
| `https://rpc-test.ttl1.top` | TLS cert principal mismatch (`SEC_E_WRONG_PRINCIPAL`) |
| `https://rpc-sepolia.ttl1.top` | TLS cert principal mismatch |
| `https://devnet.ttl1.top` | TLS cert principal mismatch |
| `https://api.ttl1.top` | HTML page, no JSON-RPC endpoint exposed |
| `https://faucet.ttl1.top` | empty response |

The empty-response endpoints all resolve to a single shared IP
(`46.250.249.80`) that appears to be a wildcard fallback — they accept
TLS handshakes but no server is listening on them. The mismatch
endpoints don't have a cert matching their hostname at all.

**Conclusion:** *no public TTL testnet currently exists at any of the
obvious URLs*. If one is being run internally it's behind auth or on a
non-`*.ttl1.top` domain we haven't been told about.

### Questions for the TTL team

These should be filed as issues / asked directly:

1. Is there a public testnet RPC URL? If yes, please publish it on
   `docs.ttl1.top` (which itself does not yet exist).
2. Chain ID of the testnet? (We currently assume **17777** by analogy
   with Ethereum's `1` / `11155111`, but this is just a guess.)
3. Is there a faucet for the testnet? Throughput limits per address?
   Captcha / OAuth / Discord-based?
4. Block explorer for the testnet (analogous to `scan.ttl1.top`)?
5. Is there a planned deprecation date for mainnet's geth 1.13.15 fork
   in favour of a newer engine (Prague-equivalent)?

### Provisional configuration (placeholder)

When the TTL team confirms testnet details, add this to
`packages/wallet-sdk/src/chains/registry.ts`:

```ts
export const TTL_TESTNET: ViemChain = {
  id: 17777, // PLACEHOLDER — confirm with TTL team
  name: 'TTL Testnet',
  testnet: true,
  nativeCurrency: { name: 'TTL', symbol: 'TTL', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://rpc-testnet.ttl1.top'], // PLACEHOLDER
    },
  },
  blockExplorers: {
    default: { name: 'TTL Scan (testnet)', url: 'https://scan-testnet.ttl1.top' },
  },
} as const;
```

Until then, dev tests can target a local hardhat node running on
`localhost:8545` with `chainId: 7777` to exercise the same code path
without real-money risk.

---

## 3. Faucet — request flow (placeholder)

When the testnet exists, a faucet is the canonical way to get test
TTL. Typical patterns:

- **Form-based** (Sepolia-style): submit address via web form, get
  ≤ 1 TTL per 24 h, captcha gated.
- **Discord-based** (Avalanche-Fuji-style): `/faucet <address>` in a
  designated channel.
- **GitHub-OAuth-based** (Optimism-style): one-time grant per account.

Until the TTL team chooses, the docs assume a Sepolia-style HTTP
faucet at `https://faucet.ttl1.top` with payload:

```sh
curl -X POST https://faucet.ttl1.top/api/claim \
  -H "Content-Type: application/json" \
  -d '{"address":"0x...","captcha":"..."}'
```

This URL **does not currently respond** — see §2.

---

## 4. Broadcasting a real transaction (mainnet)

The wallet-sdk's `Wallet.transfer` does the full build → sign →
broadcast cycle:

```ts
import {
  Wallet,
  EvmAdapter,
  TTL_CHAIN,
} from '@byeorin/wallet-sdk';
import { parseEther } from 'viem';

const MNEMONIC = '...your 12/24 BIP-39 words...';

const wallet = Wallet.fromMnemonic({ mnemonic: MNEMONIC });
const adapter = new EvmAdapter({
  chain: TTL_CHAIN,
  // rpcUrl defaults to https://rpc.ttl1.top (set in TTL_CHAIN)
});

const account = wallet.account(adapter, /* accountIdx */ 0, /* index */ 0);
console.log('from:', account.address);

// One call does build + sign + broadcast and returns the tx hash:
const txHash = await wallet.transfer(account, {
  to: '0xRecipientAddressHere',
  amount: parseEther('0.001'),   // bigint of wei
});

console.log('https://scan.ttl1.top/tx/' + txHash);
```

### Sign-only (don't broadcast)

For testing — or for a hardware-wallet flow where you want to confirm
the rawTx before sending — you can stop after `applySignatures`:

```ts
import { parseTransaction } from 'viem';

const unsigned = await adapter.buildTransfer(
  { to: '0x...', amount: parseEther('0.001') },
  { sender: account.address, signer: account.signer },
);
const requests = await adapter.signRequests(unsigned);
const signatures = await Promise.all(
  requests.map((r) => account.signer.sign(r.message)),
);
const signed = await adapter.applySignatures(unsigned, signatures);

console.log('raw:', signed.raw);
console.log('hash:', signed.hash);

// Decode it back to verify it's well-formed before broadcasting:
const decoded = parseTransaction(signed.raw);
console.log(decoded);
//   { type: 'eip1559', chainId: 7777, nonce: …, to: '0x…',
//     value: …, gas: …, maxFeePerGas: …, maxPriorityFeePerGas: …,
//     r: '0x…', s: '0x…', v: 0n | 1n }
```

This is exactly the round-trip the agent's *step 7* would attempt
against a testnet — but since no testnet exists, the only safe
non-mocked test is to set `rpcUrl` to a local hardhat node.

---

## 5. Address-derivation cross-check

Independent of any network access, `scripts/verify-addresses.mjs`
cross-checks the wallet-sdk's HD derivation against canonical upstream
libraries (ethers, xrpl, @cosmjs, etc.) for every supported chain.
Run it whenever changing crypto code:

```sh
node scripts/verify-addresses.mjs
# → table with Match: 10 / 10
```

That script is the source of truth for "does our HD derivation match
the rest of the ecosystem", and it does not require any RPC endpoint
to be online.
