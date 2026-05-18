# Changelog

All notable changes to **벼린** (Byeorin / Worker's Wallet) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Until v0.1 tagging, each commit is its own release entry.

---

## [c04a852] harden: review wave 5 — 2nd-pass vulnerability hardening — 2026-05-16

### Added
- `signEvmMessage(signer, address, message)` helper in SDK (EIP-191) — extension can now drop its inline hash construction. Byte-equivalence vs `viem.signMessage` verified.
- `KEYSTORE_PARAMS_FAST` preset (scrypt N=2^16) for mobile / low-end devices; default `KEYSTORE_PARAMS_DEFAULT` bumped to N=2^17 (≈256 MB working set).
- SLIP-0010 ed25519 conformance: 4 tests against canonical spec vectors.
- Cross-vendor regression: Aptos / Solana / Cosmos / Osmosis address derivation validated against each chain's official SDK.
- Tron recovery boundary tests: rejects v ∈ {2, 26, 29, 255}.
- `.github/workflows/ci.yml` — typecheck + test + build + `pnpm audit` gate.

### Changed
- Extension popup ↔ background protocol: 128-bit nonce binding. Direct-URL hijack of `connect.html` / `confirm.html` now rejected with friendly Korean error.
- `sender.id === chrome.runtime.id` guard on every message branch.
- `chrome.runtime.onSuspend` rejects pending requests (Service Worker termination safety).
- `WalletStore`: explicit lock-vs-inflight-transfer policy (broadcast completes, subsequent calls throw), idempotent concurrent `unlock()`, explicit-adapter cache bypass.
- `detectWordlist`: mixed Korean/English now rejected with clear Korean error.
- `prj.conf` (firmware) production preset: CONSOLE/SERIAL/PRINTK/ASSERT/DEBUG=n, BLE_SIGNING=n, CONFIRM_TIMEOUT=60s.
- All firmware transport/se/keys files now carry `SECURITY-CRITICAL` header banners.

### Fixed
- BLE write callback (firmware): pre-callback length / offset / null guards.
- HID reassembly (firmware): `rx_reset()` now memsets the buffer on every IDLE transition.
- Extension connect/App: removed origin URL fallback (spoofing risk).
- EIP-6963 announce: documentation clarified that no account leak occurs.

### Security
- `pnpm audit`: 24 advisories → 1 low (Critical 1→0, High 8→0, Moderate 13→0).
- Root `pnpm.overrides`: `protobufjs ^7.5.8`, `axios ^1.15.2`, `fast-xml-parser ^5.7.0`.
- `.gitignore` hardened: env / secrets / keys / keystores / mobileprovisions patterns.
- SE050: anti-rollback `get` / `increment` prototypes added.
- `WalletStore.test.ts`: 20 new tests covering 6 invariants.

### Test metrics
- SDK: **83 pass / 9 skipped / 0 fail** (was 63).
- shell-core: **37 pass** (was 14).

---

## [a334e20] feat: review wave 4 — insurance v2 + keystore + ext confirm + RN UI + Tron fix — 2026-05-16

### Added
- `docs/INSURANCE.md` (849 lines) — v2 standalone insurance system design. Recommends HW = KB insurance bundle + SW = Nexus/InsurAce distribution + self-pool permanently deferred. 5 kill criteria, legal-first roadmap, 벼린 identity alignment check.
- `packages/shell-core/src/keystore.ts` — scrypt (N=2^16) + AES-GCM `EncryptedKeystoreStore` with `LocalStorageBackend` + `ChromeLocalBackend`.
- `apps/extension/entrypoints/confirm/` — consent popup for `personal_sign` and `eth_sendTransaction`. EIP-191 prefixed hash + v=recovery+27. Hard-enforces chainId 7777 and rejects contract calls (data != 0x) until v0.3.
- `apps/mobile/src/ui/` — RN primitives (Button / Card / Input / AddressDisplay / AmountDisplay). 3 screens (Home / Account / Send) migrated from inline styles to primitives.

### Fixed
- **TRON adapter signature** (production-critical silent failure risk): TronWeb v6 expects `r ‖ s ‖ (recovery + 27)` — we were sending raw recovery 0/1. `applySignatures` now normalizes `+27`, while `27/28` pass through unchanged (HW signer path). New offline verification test enforces byte-for-byte equality.

### Test metrics
- SDK: **63 pass / 9 skipped / 0 fail**.
- shell-core: **14 pass**.

---

## [9d3c847] refactor: review wave 3 — secp dedup + Cosmos Injective + mobile DS — 2026-05-16

### Added
- `packages/wallet-sdk/src/crypto/secp.ts` — single source for `toCompressedSecp256k1` / `toUncompressedSecp256k1`. 5 adapters (btc / xrp / evm / tron / cosmos) had identical local helpers — now all import the shared module.
- `CosmosAdapter.evmAddressing` option — Injective / Ethermint family. keccak256 address derivation (same 20 bytes as EVM), `inj` bech32 prefix, `/injective.crypto.v1beta1.ethsecp256k1.PubKey` Any typeUrl.
- New test: same seed yields `inj1...` 20-byte address ≡ EVM `0x...` 20-byte.

### Changed
- `apps/mobile` adopts `@byeorin/design-system` — `tokens.color` / `space` / `radius` / `font`. 6 hardcoded hex literals replaced.
- Korean font stack added (System → Apple SD Gothic Neo / Noto Sans CJK).
- Dark chrome colors retained at v0.1 (DS exposes light palette only for now).

### Test metrics
- SDK: **59 pass / 9 skipped / 0 fail** (3 new Injective tests).

---

## [72887dc] refactor: review wave 2 — ChainAdapter signRequests[] + @byeorin/shell-core — 2026-05-16

### Added
- `@byeorin/shell-core` package — `WalletStore` + `SessionStore` interface. Eliminates wallet-store.ts duplication across 4 shells (web / desktop / mobile / extension).
- `WebSessionStore` (autoRestoreAllowed=false, v0.1 in-memory only — H1 security policy).
- `ExtensionSessionStore` (`chrome.storage.session`, autoRestoreAllowed=true).
- `MemorySessionStore` (mobile default).
- `SignRequest` interface — `{ message: Uint8Array, prehashed: boolean }`. HW-signer hint.
- New test: BTC multi-input signing now works through the public `Wallet.transfer` API.

### Changed
- **`ChainAdapter` interface migration**: `serializeForSigning` / `applySignature` → `signRequests[]` / `applySignatures[]`. All 9 adapters migrated (evm / btc / xrp / cosmos / solana / tron / ton / aptos / sui). Single-signature chains return exactly one request; BTC returns one per input.
- `BtcAdapter` side channel `signingDigests` made `private` (was inadvertently public).
- Hangul regex tightened `[가-힯]` → `[가-힣]` (M3).

### Test metrics
- SDK: **56 pass / 9 skipped / 0 fail** (1 new BTC multi-input test).
- 8 packages typecheck pass.

---

## [1ec8e5b] fix: review wave 1 — security + UX + cleanups — 2026-05-16

### Added
- Extension EIP-1193: per-origin consent flow + connect popup + EIP-6963 announce + scope restricted to `https://` and `localhost` (C1 + H2 + H3).
- Desktop Wallet: triple-state balance UI (loading / error / success) + "retry" button (M1).
- Web / Desktop: `@byeorin/design-system` adoption (Logo / Button / Card / Input / AddressDisplay / AmountDisplay).
- Firmware APDU: APDU_ERR_BAD_LC error code (M5).

### Changed
- Web Send: `viem.parseUnits` replaces float math (C2 — precision bug).
- SDK: `xrpToDrops` adds safe-range guard, rejects negatives, defends against scientific notation (M6).
- SDK: `isValidClassicAddress` re-export moved to `index.ts` (removes tsup warning).
- Firmware APDU parser: handles both short and extended forms.

---

## [8419a53] feat: parallel wave 2 — P2 adapters + HW spec + firmware skeleton — 2026-05-15

### Added
- **`TonAdapter`** — `@ton/ton` v4 wallet, EQ-bounceable addresses, inline-action serialization (ESM-safe).
- **`AptosAdapter`** — Petra derivation path `m/44'/637'/i'/0'/i'`, sha3-256 auth key.
- **`SuiAdapter`** — blake2b-256 address, intent-prefixed signing, base64 `flag ‖ sig ‖ pubkey`.
- `hardware/SPEC.md` (11 sections), `BOM.csv` (39 rows, target ~$35 at 1k), `pin-map.md`, `threat-model.md`.
- `firmware/` Zephyr skeleton (35 files): nRF52840 + SE050 (I2C) + e-ink (SPI3), Ledger-compatible APDU framing, MCUBoot bootloader plan, chain apps (evm / cosmos / btc).

### Test metrics
- SDK: **55 pass / 9 skipped (live) / 0 fail** across **9 chains** (EVM + TTL, BTC, XRP, Cosmos, Solana, TRON, TON, Aptos, Sui).

---

## [6474c9c] feat: parallel wave — SW shells x4 + P0/P1 adapters + design system — 2026-05-15

### Added
- `apps/web` — Vite + React. Wallet generate / recover / balance / transfer against live TTL RPC.
- `apps/extension` — **WXT** (MV3), EIP-1193 provider, popup.
- `apps/desktop` — **Tauri 2** + React, `src-tauri/` Rust scaffold (Rust toolchain not required at this stage).
- `apps/mobile` — **React Native 0.76 Bare** TypeScript, monorepo metro config.
- `packages/design-system` — `@byeorin/design-system`. tokens.css + Logo / Button / Card / Input / AddressDisplay / AmountDisplay.
- `BtcAdapter` — BIP-84 p2wpkh + Esplora, multi-input signing.
- `XrpAdapter` — xrpl v4, half-SHA-512, DER re-encoding.
- `CosmosAdapter` — cosmoshub-4 / osmosis-1 / etc., hand-rolled `TxRaw`.
- `SolanaAdapter` (P1) — Phantom path `m/44'/501'/i'/0'`.
- `TronAdapter` (P1) — tronweb v6 base58check.

### Test metrics
- SDK: **40 pass / 6 skipped (live) / 0 fail**.
- All builds pass: web / extension / desktop / design-system / wallet-sdk.

---

## [05f00a1] init: monorepo + @byeorin/wallet-sdk with EVM/TTL working — 2026-05-15

### Added
- pnpm + turbo monorepo bootstrap.
- `@byeorin/wallet-sdk` initial scaffold: `Wallet.fromMnemonic` → `Wallet.account(adapter)` → `Wallet.transfer(account, intent)` flow.
- `EvmAdapter` working against TTL (chain 7777) via viem.
- `SoftSigner` (secp256k1 / ed25519, 65-byte `r‖s‖recovery` blob for secp).
- BIP-39 (English wordlist) + BIP-32 + SLIP-0010.
- `TTL_CHAIN` + `EVM_CHAINS` (Ethereum / Polygon / BSC / Arbitrum / Optimism / Base / Avalanche).
