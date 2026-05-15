# 노동자의 지갑 — Architecture (v0.4, 2026-05-16)

> Single-file map of how the system fits together. Deep documents are linked at the bottom.
>
> Audience: a new engineer joining the team. Read this in 15 minutes and know where every line of code lives and why.

---

## 1. System block diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              USER (one human, one seed)                 │
└─────────────────────────────────────────────────────────────────────────┘
              │                  │                  │                │
              ▼                  ▼                  ▼                ▼
   ┌──────────────┐   ┌────────────────┐   ┌──────────────┐  ┌────────────┐
   │  apps/web    │   │ apps/extension │   │ apps/desktop │  │apps/mobile │
   │  Vite+React  │   │  WXT (MV3)     │   │  Tauri 2     │  │ RN 0.76    │
   └──────┬───────┘   └────────┬───────┘   └──────┬───────┘  └─────┬──────┘
          │                    │                  │                │
          └──────────┬─────────┴────────┬─────────┘────────────────┘
                     │                  │
                     ▼                  ▼
            ┌──────────────────────────────────────────┐
            │       @nodong/design-system              │
            │   Logo · Button · Card · Input ·         │
            │   AddressDisplay · AmountDisplay ·       │
            │   tokens.css / tokens.ts                 │
            └──────────────────────────────────────────┘
                     ▲
                     │  (UI primitives — pure presentation)
                     │
            ┌────────┴─────────────────────────────────┐
            │       @nodong/shell-core                 │
            │  ┌────────────────────────────────────┐  │
            │  │ WalletStore (lifecycle, lock/unlock,│ │
            │  │   account cache, transfer delegate)│  │
            │  ├────────────────────────────────────┤  │
            │  │ SessionStore (interface)           │  │
            │  │  ├ WebSessionStore (in-memory)     │  │
            │  │  ├ ExtensionSessionStore (chrome   │  │
            │  │  │   .storage.session)             │  │
            │  │  └ MemorySessionStore (mobile)     │  │
            │  ├────────────────────────────────────┤  │
            │  │ EncryptedKeystoreStore             │  │
            │  │   scrypt(N=2^17) + AES-256-GCM     │  │
            │  │   LocalStorageBackend (web)        │  │
            │  │   ChromeLocalBackend (extension)   │  │
            │  ├────────────────────────────────────┤  │
            │  │ detectWordlist(mnemonic)           │  │
            │  └────────────────────────────────────┘  │
            └──────────────────────────────────────────┘
                     │
                     ▼  (uses Wallet, ChainAdapter, TransferIntent)
            ┌──────────────────────────────────────────┐
            │       @nodong/wallet-sdk                 │
            │                                          │
            │  Wallet.fromMnemonic({ mnemonic, ... })  │
            │     │                                    │
            │     ▼                                    │
            │  wallet.account(adapter, account, idx)   │
            │     │ derives BIP-32 / SLIP-0010 key     │
            │     │ binds SoftSigner + adapter         │
            │     ▼                                    │
            │  WalletAccount { address, signer,        │
            │                  adapter, derivationPath │
            │                  publicKey }             │
            │     │                                    │
            │     ▼                                    │
            │  wallet.transfer(account, intent)        │
            │     │ adapter.buildTransfer(intent, ctx) │
            │     │ adapter.signRequests(tx) → N reqs  │
            │     │ for each: signer.sign(req.message) │
            │     │ adapter.applySignatures(tx, sigs)  │
            │     │ adapter.broadcast(signed)          │
            │     ▼                                    │
            │  TxHash                                  │
            └──────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
 ┌─────────────────┐     ┌─────────────────────┐
 │  ChainAdapter   │     │  Signer (interface) │
 │  (9 impls)      │     │   curve, publicKey, │
 │                 │     │   sign(msg)         │
 │ EvmAdapter      │     │                     │
 │ BtcAdapter      │     │ ┌─ SoftSigner ──┐   │
 │ XrpAdapter      │     │ │ in-memory     │   │
 │ CosmosAdapter   │     │ │ secp + ed25519│   │
 │  (Injective opt)│     │ └───────────────┘   │
 │ SolanaAdapter   │     │ ┌─ HwSigner ────┐   │
 │ TronAdapter     │     │ │ Q3 (not impl) │   │
 │ TonAdapter      │     │ └───────────────┘   │
 │ AptosAdapter    │     │ ┌─ WCSigner ────┐   │
 │ SuiAdapter      │     │ │ Q3 (not impl) │   │
 └─────────────────┘     │ └───────────────┘   │
        │                └─────────────────────┘
        ▼
 ┌─────────────────────────────────────────────┐
 │   crypto primitives (audited TS only)       │
 │   @noble/curves · @noble/hashes · @scure/*  │
 └─────────────────────────────────────────────┘
        │
        ▼
 ┌─────────────────────────────────────────────┐
 │   Chain RPC endpoints (live)                │
 │   TTL · Ethereum · BTC (Esplora) · XRPL ·   │
 │   Cosmos LCD · Solana · TronGrid · TON ·    │
 │   Aptos · Sui                               │
 └─────────────────────────────────────────────┘
```

**Reading rule.** Arrows are *uses*, not *contains*. Every layer below is reachable only via its upper layer's public surface. Specifically:

- Apps never `import` from `@nodong/wallet-sdk` directly for lifecycle — they go through `@nodong/shell-core` so the unlock / lock / session-store contract is uniform.
- Apps **may** import individual `ChainAdapter` classes for non-lifecycle reads (e.g., `adapter.getBalance(address)` with no signer).
- Crypto primitives live exclusively inside `wallet-sdk`. No app or shell code should ever import `@noble/*` directly.

---

## 2. Hardware path (target — Q4+)

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Host: apps/desktop or apps/extension               │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  @nodong/wallet-sdk Wallet + adapter (as above)              │   │
│  │     │                                                        │   │
│  │     │  but with HwSigner instead of SoftSigner               │   │
│  │     ▼                                                        │   │
│  │  HwSigner.sign(message) →   ┌─────────────────────────────┐  │   │
│  │                              │ @ledgerhq/hw-transport-     │  │   │
│  │                              │   webhid / -webusb / -node  │  │   │
│  │                              └─────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ USB-HID  (or BLE GATT on mobile)
                       │ Ledger-compatible APDU framing
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│              firmware/app  (Zephyr RTOS, nRF52840)                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Bootloader (MCUBoot, signed, anti-rollback via SE050 counter)│   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ Core: transport (USB-HID/BLE) · APDU router · UI · power     │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │ Chain apps (sandboxed MPU regions):                           │   │
│  │   evm.c · cosmos.c · btc.c · …                               │   │
│  │   Only display the parsed tx. Signing target = 32-B digest.  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                              │ I2C 1 MHz                            │
│                              ▼                                      │
│                       ┌─────────────────┐                           │
│                       │ NXP SE050        │                          │
│                       │ Seed + keys     │                           │
│                       │ ECDSA / EdDSA   │                           │
│                       │ TRNG · Counter  │                           │
│                       └─────────────────┘                           │
│                                                                     │
│   ┌───────────────┐         ┌─────────────────┐                     │
│   │ e-ink 1.54"   │ ◄── SPI │ Buttons OK/CXL  │ ──┐                 │
│   │ shows tx      │         └─────────────────┘   │ user confirms   │
│   └───────────────┘                               ▼                 │
└─────────────────────────────────────────────────────────────────────┘
```

`SignRequest.prehashed` is the protocol hint that travels with the APDU: `true` = signer receives a 32-byte digest and signs as-is (secp); `false` = signer receives raw payload and hashes internally (Ed25519). SoftSigner ignores it; the firmware uses it to pick the SE050 command variant.

---

## 3. Module responsibility table

| Path | Package / module | Responsibility | What it must NOT do |
|---|---|---|---|
| `packages/wallet-sdk` | `@nodong/wallet-sdk` | Pure key + chain + tx data flow. `Wallet`, `ChainAdapter` interface, 9 chain implementations, `SoftSigner`, crypto primitives. | Persist anything. Know about UI, browser, mobile, dApps, popups. |
| `packages/shell-core` | `@nodong/shell-core` | App-shell common lifecycle. `WalletStore` (unlock/lock/account-cache/transfer-delegate). `SessionStore` interface + 3 backends. `EncryptedKeystoreStore` (scrypt + AES-GCM). `detectWordlist`. | Render UI. Talk to chain RPCs directly. |
| `packages/design-system` | `@nodong/design-system` | Brand tokens (color / space / radius / typography) and React presentation primitives (Logo / Button / Card / Input / AddressDisplay / AmountDisplay). | Hold any wallet state or talk to SDK. Pure presentation. |
| `apps/web` | (private) | Vite + React + DS. Wallet generate / recover / balance / transfer using shell-core. In-memory keystore only (autoRestoreAllowed=false). | Persist seed to localStorage in v0.1 (deliberate H1 policy). |
| `apps/extension` | (private) | WXT (MV3). EIP-1193 provider. Per-origin consent. `connect` + `confirm` popups with 128-bit nonce binding. ChromeLocalBackend keystore. | Auto-sign anything. Accept messages without `sender.id === chrome.runtime.id` and matching nonce. |
| `apps/desktop` | (private) | Tauri 2 + React. Multi-account, triple-state balance UI. Future: USB-HID HW transport. | Bundle Electron. Ship debug builds with `tauri dev` flags. |
| `apps/mobile` | (private) | RN 0.76 Bare TS. 3 screens (Home / Account / Send) + DS primitives. MemorySessionStore. | Use Expo Managed. |
| `firmware/app` | (Zephyr) | nRF52840 firmware skeleton. USB-HID + BLE APDU transport, SE050 wrapper, e-ink UI, MCUBoot integration plan. | Parse chain TX deeply (display only). Hold key material outside SE. |
| `hardware/` | (docs) | `SPEC.md`, `BOM.csv`, `pin-map.md`, `threat-model.md`. | (not code) |
| `verification/addresses.txt` | (data) | Cross-SDK address derivation oracle (10/10 chains). | (not code) |
| `docs/` | (docs) | `PLAN.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `INSURANCE.md`. | (not code) |

---

## 4. Key invariants

These are the load-bearing promises. Any change that violates one of these must be flagged in PR review.

### I-1: Non-custodial

The operator (us) never holds, transmits, persists, observes, or telemeters any seed, mnemonic, private key, or decrypted keystore. Every keystore on disk is `scrypt(N=2^17) + AES-256-GCM` with a passphrase only the user knows.

**Enforcement:** `EncryptedKeystoreStore` is the only persistence path. Nothing else in the codebase writes a mnemonic to disk. `.gitignore` blocks `.env`, `*.key`, `*.keystore`, `*.mobileprovision`.

### I-2: Signer-agnostic

`Wallet.transfer(account, intent)` does not know whether `account.signer` is software, hardware, or WalletConnect. The contract is `Signer { curve, publicKey, sign(message) }`. Adapters MUST NOT call `(signer as SoftSigner).key` or any private state.

**Why it matters:** the same SDK code path will work for HW signers in Q4 without touching adapters.

### I-3: Multi-chain isolation

Every chain has its own `ChainAdapter` implementation. There is no shared "tx" type beyond `TransferIntent`. We deliberately reject any attempt to generalize across UTXO / Account / Cosmos-SDK-message / XRPL-ledger models. The price of that is per-chain depth — and it's the right price.

**Enforcement:** the `ChainAdapter` interface is **8 methods**, all narrow. New chains add a file in `packages/wallet-sdk/src/chains/`, never modify the interface.

### I-4: MV3-compliant (extension)

The extension must work under Manifest V3:
- background is a **Service Worker** — no persistent globals.
- popups talk to background only via `chrome.runtime.sendMessage`.
- on `chrome.runtime.onSuspend`, all pending requests are rejected (otherwise they hang forever on SW termination).
- popup URLs are **nonce-bound** — direct-URL navigation to `confirm.html` is rejected.

### I-5: SE-locked seed (HW path)

When a unit is provisioned, the seed is generated by the SE050's on-die TRNG and never crosses the I2C bus in plaintext. The MCU only sees opaque "sign this 32-byte digest with this BIP32 path" requests. APPROTECT is locked at PVT — boards cannot be flashed-and-read after that.

### I-6: Audit gate

`pnpm audit` runs in CI. **No High or Critical** advisories may merge. Currently: 1 low advisory, 0 elsewhere.

### I-7: One source of truth per concern

- `tokens.css` for design tokens (no inline hex in shells)
- `secp.ts` for pubkey compression (no per-adapter copies)
- `WalletStore` for unlock/lock lifecycle (no per-shell stores)
- `detectWordlist` for Korean/English mnemonic handling (rejected mixed)

---

## 5. Threat boundaries (extension)

The browser extension is the most exposed surface. Every arrow that crosses a `║` line below is hostile by default — validate, authenticate, scope, rate-limit.

```
   ┌────────────────────────────────────────────────────────────┐
   │  Web page (any origin, fully untrusted)                    │
   │     window.ethereum.request({...})                         │
   └─────────────────────────────┬──────────────────────────────┘
                                 │  EIP-1193 method call
   ════════════════════════════ ║ ═══════════════ trust boundary
                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │  inpage.ts  (MAIN world script, lives in page memory)      │
   │  - emits "nodong-rpc-request" CustomEvent on window         │
   │  - the page CAN tamper with this script after injection    │
   └─────────────────────────────┬──────────────────────────────┘
                                 │
   ════════════════════════════ ║ ═══════════════ trust boundary
                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │  content.ts  (ISOLATED world, MV3 content script)          │
   │  - listens for CustomEvent on window                       │
   │  - forwards to background via chrome.runtime.sendMessage   │
   │  - tags every request with the page's origin (frame URL)   │
   └─────────────────────────────┬──────────────────────────────┘
                                 │  { origin, method, params }
   ════════════════════════════ ║ ═══════════════ trust boundary
                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │  background.ts  (Service Worker, our trust root in ext)    │
   │  - sender.id === chrome.runtime.id guard                   │
   │  - per-origin consent registry (Q1 storage layer)          │
   │  - opens popup with crypto.randomUUID()-derived nonce      │
   │  - persists nonce in `chrome.storage.session` (volatile)   │
   │  - chrome.runtime.onSuspend rejects all pending            │
   └─────────────────────────────┬──────────────────────────────┘
                                 │  { requestId, nonce }
   ════════════════════════════ ║ ═══════════════ trust boundary
                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │  popup (connect.html / confirm.html, our UI)               │
   │  - reads nonce from URL fragment, validates against bg     │
   │  - direct-URL navigation without nonce → rejected          │
   │  - shows origin, method, params (or parsed tx) to user     │
   │  - user clicks Approve/Reject → bg                         │
   └─────────────────────────────┬──────────────────────────────┘
                                 │  user decision
                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │  WalletStore (shell-core) — only reached after consent     │
   │  WalletStore.transfer(...) or .signMessage(...)            │
   │  Returns the result back through bg → content → inpage     │
   └────────────────────────────────────────────────────────────┘
```

**Validations at each boundary:**

| Boundary | Validation |
|---|---|
| page → inpage | none — page owns inpage |
| inpage → content | CustomEvent origin & event.isTrusted not relied on (page can synthesize); content treats input as **fully attacker-controlled** |
| content → background | `chrome.runtime.sendMessage`, identity authenticated by Chrome; content **adds** the origin from `location.href` (cannot be spoofed by page) |
| background → popup | popup URL contains `?nonce=...`; nonce was generated by bg via `crypto.getRandomValues` and stored in `chrome.storage.session`. Popup must echo the nonce on first message or be rejected |
| popup → background | every message carries the nonce; bg verifies + clears one-shot |
| background → wallet | only after explicit user consent; wallet operations run inside bg's worker context, never in popup |

The same model is the basis for the desktop app's USB-HID transport (popup ≈ Tauri WebView, transport ≈ Rust core).

---

## 6. Pointers to deep docs

| Topic | Document |
|---|---|
| Product spec, roadmap, kill switches | [`docs/PLAN.md`](./PLAN.md) |
| Per-commit changelog | [`docs/CHANGELOG.md`](./CHANGELOG.md) |
| Insurance system design (SW & HW) | [`docs/INSURANCE.md`](./INSURANCE.md) |
| HW spec — SE / MCU / display / power / certs | [`hardware/SPEC.md`](../hardware/SPEC.md) |
| HW BOM, pin-map | [`hardware/BOM.csv`](../hardware/BOM.csv), [`hardware/pin-map.md`](../hardware/pin-map.md) |
| HW threat model (firmware + transport surface) | [`hardware/threat-model.md`](../hardware/threat-model.md) |
| Firmware build & layout | [`firmware/README.md`](../firmware/README.md) |
| Cross-SDK address verification (10/10) | [`verification/addresses.txt`](../verification/addresses.txt) |

---

*— v0.4. Updated alongside `PLAN.md` v0.4 and `CHANGELOG.md` covering all 8 Q0 commits.*
