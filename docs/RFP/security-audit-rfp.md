# Security Audit RFP — Worker's Wallet (노동자의 지갑)

**Project**: Worker's Wallet (노동자의 지갑) — multi-chain non-custodial wallet
**Issued by**: [COMPANY_LEGAL_NAME] ([COMPANY_SHORT_NAME])
**Primary contact**: [YOUR_NAME], [YOUR_TITLE]
**Email (PGP preferred)**: [YOUR_EMAIL]
**PGP fingerprint**: [PGP_FINGERPRINT]
**Signal**: [SIGNAL_HANDLE_OR_NUMBER]
**Date issued**: [YYYY-MM-DD] (target 2026-05-XX)
**Expected response by**: [YYYY-MM-DD] (suggest issue-date + 14 days)
**Proposal deadline**: [YYYY-MM-DD] (suggest issue-date + 28 days)
**Target kickoff**: [YYYY-MM-DD] (suggest issue-date + 45 days)

---

## 0. How to read this RFP

This document is sent to a shortlist of 3-5 firms. Sections marked with `[PLACEHOLDER]` must be replaced before send. We do not expect a fixed-bid commitment from your firm at the Q&A stage; we expect a written proposal at the proposal deadline. Anything in this RFP that is unclear is a legitimate Q&A topic — we'd rather answer questions early than discover scope mismatch mid-engagement.

---

## 1. Project summary

### 1.1 What it is

Worker's Wallet (Korean: 노동자의 지갑) is a non-custodial, multi-chain wallet for retail end users. The product family is:

- **SDK** (`packages/wallet-sdk`) — TypeScript library with chain adapters (signing, key derivation, encoding, RPC, fee estimation) for EVM, UTXO (BTC/LTC), Cosmos SDK chains, Solana, TON, Aptos, Sui — 9 adapters in total.
- **Shell core** (`packages/shell-core`) — wallet lifecycle, session, account model, keystore integration. Used by all four UI shells.
- **UI shells** — browser extension (`apps/extension`), web app (`apps/web`), Electron desktop (`apps/desktop`), React Native mobile shell with service-worker integration (`apps/mobile`).
- **Hardware firmware skeleton** (`firmware/app`) — Zephyr RTOS application for an upcoming hardware device. APDU parser, USB-HID transport, BLE GATT transport, anti-rollback metadata, secure-boot manifest. **No secure-element (SE) chip in the current skeleton**; the production device will integrate an SE later and that integration will be re-audited.

### 1.2 Brand positioning

Worker's Wallet is positioned around a pro-labor identity (the name translates to "Worker's Wallet"). The primary launch market is **South Korea (KR)**, with English-language support from day one. We expect a regulated, conservative user base — many of whom are first-time wallet users — and we treat user trust as the dominant marketing asset. A high-confidence security audit report is therefore a launch dependency, not a nice-to-have.

### 1.3 What this audit covers

This RFP covers the **wallet codebase** — SDK + four software shells + hardware firmware skeleton. It does **not** cover:

- The future Secure Element (SE) firmware once integrated (separate engagement).
- Network/cloud infrastructure (we run no custody backend; only ancillary services like a price feed proxy and analytics, which will be audited separately if at all).
- Third-party libraries at depth (we assume their existing audits stand — see section 3).

### 1.4 Stage and code freeze

Repository is **pre-launch**. Current state: **10 commits, 156 tests passing, pnpm audit clean (0 critical / 0 high / 0 moderate / 1 low)**. Code volume: **~10,927 lines** (TypeScript + C). We anticipate a code freeze approximately 2 weeks before audit kickoff; we will provide a Git SHA for the audited commit and treat any post-freeze changes as out-of-scope for the audited report.

### 1.5 Why we are issuing this RFP now

We are issuing this RFP **before** code freeze so that:

1. The selected firm has time to read background docs and propose a threat model upfront.
2. Findings from a pre-audit informal review (if your firm offers one) can be folded into freeze.
3. We can sequence the final audit against our marketing/launch calendar without compressing remediation time.

### 1.6 Confidentiality

The repository is private. We will share via private GitHub fork invitation or a signed tarball (your preference). We are willing to sign an NDA before sharing code — please provide your standard NDA template or accept ours ([NDA_LINK_OR_ATTACHMENT]).

---

## 2. Audit scope (per repository path)

Effort percentages below are **our internal estimate** and not prescriptive; your proposal may reallocate as you see fit. LOC counts are TypeScript unless noted.

### 2.1 In scope

| Path | Type | Approx LOC | Suggested effort | Notes |
|---|---|---|---|---|
| `packages/wallet-sdk/` | TS | ~5,800 | ~35% | 9 chain adapters, signing, BIP-32/BIP-39/SLIP-10 derivation, keystore (AES-GCM + Argon2id). **Highest-priority area.** |
| `packages/shell-core/` | TS | ~1,400 | ~12% | Wallet lifecycle, session timeout, keystore integration, account selection, address book. |
| `apps/extension/` | TS | ~1,300 | ~18% | EIP-1193 provider, dApp connection (origin tracking), consent UI, MV3 manifest, content script isolation. **Second-highest priority** — biggest attack surface in production. |
| `apps/web/` | TS | ~600 | ~5% | UI security: XSS, clipboard handling, CSP. |
| `apps/desktop/` (Electron) | TS | ~500 | ~6% | contextIsolation, nodeIntegration off, preload bridge, auto-updater integrity. |
| `apps/mobile/` (RN + SW) | TS | ~400 | ~4% | Deep-link handling, service-worker storage isolation, biometric fallback. |
| `firmware/app/` | C (Zephyr) | ~900 | ~20% | APDU parser, USB-HID, BLE GATT, anti-rollback counter, secure-boot manifest. **Highest C-side priority.** Skeleton — no SE — please flag whatever you'd defer to post-SE-integration audit. |

Total approx **10.9k LOC** (TS + C combined).

### 2.2 Out of scope

- External dependencies' internals: `viem`, `@cosmjs/*`, `@solana/web3.js`, `@aptos-labs/ts-sdk`, `@mysten/sui.js`, `bitcoinjs-lib`, `tonweb`. We assume upstream audits stand. **However**, please do flag any obviously dangerous patterns of *how we use* these libraries.
- Cryptographic primitives (libsodium, WebCrypto, mbedTLS) — assume upstream audits.
- Browser engines, OS kernels, Zephyr kernel itself.
- The future SE chip integration (separate engagement).
- Marketing site / billing infrastructure / customer-support tooling.

### 2.3 Documentation provided to auditors at kickoff

- `docs/ARCHITECTURE.md` — module-level diagrams, trust boundaries.
- `docs/PLAN.md` — roadmap, threat model summary, security goals.
- `docs/INSURANCE.md` — insurance-coverage design (relevant for understanding what risks we cannot otherwise mitigate).
- `docs/CHANGELOG.md` — full commit-level history.
- This RFP.
- Build instructions for SDK, each shell, and firmware.
- Test suite (156 tests at issuance) and CI configuration.

---

## 3. Threats we specifically want evaluated

We list the threats we are most worried about. This is **not** an exhaustive checklist — please apply your own methodology and tell us what we missed.

### 3.1 Mnemonic / seed exfiltration

- **Memory**: zeroization timing, V8/JIT residue, RN bridge residue, Electron renderer residue.
- **Storage**: keystore-at-rest format, KDF parameters, encrypted-blob portability across shells, leakage to browser/OS sync (iCloud Keychain, Google Backup, Chrome Sync).
- **UI**: clipboard exposure of mnemonic words, screenshot defenses (mobile FLAG_SECURE, desktop screen-capture), shoulder-surfing affordances during onboarding.
- **Transport between shells**: keystore export/import flow integrity.

### 3.2 Signature correctness and malleability (per chain)

- EVM: EIP-155 chainId binding, EIP-1559 vs legacy fee fields, EIP-712 typed-data hashing, blind-signing dangers.
- UTXO: BIP-143 / BIP-341 sighash flags, PSBT round-tripping, fee-bumping (RBF/CPFP) consent.
- Cosmos: SIGN_MODE_DIRECT vs SIGN_MODE_LEGACY_AMINO_JSON, multi-chain replay.
- Solana: nonce-account semantics, durable nonce vs recent-blockhash.
- TON: cell hashing, internal-message signing.
- Aptos / Sui: BCS encoding correctness, gas object handling, sponsored-tx flows.
- Cross-chain: ensuring a signature for chain A cannot be replayed on chain B given any path code may take.

### 3.3 dApp consent bypass / origin spoofing (extension primary)

- Origin attribution in MV3 service worker.
- Iframe / popup origin confusion.
- Consent-screen UI redress (clickjacking via parent page).
- `eth_signTypedData_v4` domain-separator validation.
- Permission persistence and revocation flow.
- WalletConnect v2 session hijacking.

### 3.4 Cross-chain key reuse

- Single-mnemonic derivation across 9 chains — are derivation paths correctly isolated?
- Edge cases: same private key used for two chains with different curves (does any code path accidentally do this?).
- Address-format confusion (e.g., showing an EVM address where a Cosmos address belongs).

### 3.5 Hardware: APDU and transport

- APDU parser: length-field, TLV (if used), boundary conditions, integer overflow.
- USB-HID: report descriptor, fragmentation/reassembly, host-side spoofing.
- BLE GATT: pairing/bonding model, MITM resistance, characteristic permissions, ATT MTU handling.
- Anti-rollback: monotonic counter integrity, downgrade attacks during update.
- Secure-boot manifest: signature verification, key-revocation strategy.
- Side channels: timing leaks in PIN compare, simple power analysis exposure of the PIN/seed loading code (note: no SE in skeleton — please tell us what *cannot* be mitigated without an SE).

### 3.6 Side channels (software)

- Timing leaks in keystore unlock.
- Memory dumps via crash reporters, telemetry, or OS-level dumps.
- Spectre/Meltdown-class concerns in the browser extension context (mitigation reliance on browser COOP/COEP).

### 3.7 Supply chain

- Lockfile integrity (`pnpm-lock.yaml`), npm typosquat exposure.
- Build reproducibility for firmware artifacts.
- Signing of release artifacts (extension store, desktop installers, mobile binaries, firmware images).

---

## 4. Deliverables expected

1. **Threat model document** — produced in week 1-2; living document until report freeze.
2. **Findings report**, machine-readable + PDF, with each issue categorized as:
   - Critical / High / Medium / Low / Informational
   - Each issue: title, location (file:line), description, reproduction, impact, suggested remediation, references.
3. **Executive summary** — 2-4 pages, non-technical, suitable for board/insurer disclosure (with our redactions if needed).
4. **Remediation review** — one re-audit round of fixes is included. Subsequent rounds priced separately.
5. **Re-test SHA report** — confirming each finding's fix status against a post-remediation commit SHA.
6. **Tooling artifacts** — any custom fuzzers, scripts, or test harnesses you build, delivered for our reuse.

Korean-language deliverables are **welcome but not required**. English is acceptable for all deliverables.

---

## 5. Timeline expectations

- **Total elapsed**: 6-12 weeks from kickoff to final report.
- **Phase 1 (1-2 weeks)**: onboarding, threat model, initial review.
- **Phase 2 (3-6 weeks)**: deep review, findings drafting.
- **Phase 3 (1-2 weeks)**: report finalization.
- **Remediation gap (variable, our side)**: typically 2-4 weeks; not counted in audit elapsed.
- **Phase 4 (1-2 weeks)**: remediation re-audit.

We are open to your firm's preferred sequencing. If you recommend a phased approach (e.g., SDK first, firmware second), please describe in your proposal.

---

## 6. Budget guidance

Our budget envelope is **USD 50,000 – 150,000** for the initial audit + one remediation round. This is guidance, not a ceiling — if you believe the scope justifies more, please say so and explain why in your proposal; we will compare on substance, not the number alone. For reference, the code volume is **~10.9k LOC** (TS + C), but the diversity of chains and the firmware C component may justify a multiplier over a flat LOC-rate.

---

## 7. Selection criteria (weighted, indicative)

| Criterion | Weight |
|---|---|
| Demonstrated prior wallet or HW-wallet audit work (public reports preferred) | 30% |
| Multi-chain coverage: EVM + at least 2 of {Cosmos, Solana, UTXO, Move-family} in prior work | 20% |
| Hardware / embedded-C audit capability (Zephyr/RTOS, transport stacks) | 15% |
| Methodology rigor: threat-model-first, fuzzing/property-testing capability, tooling artifacts | 15% |
| Team CV depth: senior auditors named on engagement, not pure account-management front | 10% |
| Communication: Korean-timezone overlap, responsiveness, written-English clarity | 5% |
| Price | 5% |

Firms we are particularly familiar with by reputation and would welcome proposals from include (in no order): **Trail of Bits, Halborn, OpenZeppelin, Cure53, SlowMist, ChainSecurity, Quantstamp, Spearbit, Veridise, Sigma Prime**. Inclusion in this list is not a commitment; exclusion is not a disqualification. See `audit-firms-shortlist.md` for our internal notes (not shared with bidders).

---

## 8. Process and dates

| Step | Date placeholder | Suggested offset |
|---|---|---|
| RFP issued | [YYYY-MM-DD] | T+0 |
| Q&A window opens | [YYYY-MM-DD] | T+0 |
| Q&A window closes | [YYYY-MM-DD] | T+10 days |
| Proposal deadline | [YYYY-MM-DD] | T+14 days |
| Shortlist notification | [YYYY-MM-DD] | T+21 days |
| Selection announced | [YYYY-MM-DD] | T+28 days |
| MSA + SOW signed | [YYYY-MM-DD] | T+35 days |
| Kickoff | [YYYY-MM-DD] | T+45 days |

Q&A is conducted by email to [YOUR_EMAIL]; we will compile answers and re-distribute to all bidders weekly so all firms see the same answers.

---

## 9. Repository access

- Mode: **private GitHub repository invitation** to nominated audit team members (preferred), **OR** signed tarball delivered over [TRANSPORT_METHOD].
- Access duration: kickoff date through final report + 30 days.
- Branch model: audit performed against a frozen tag `audit/v1-rc1`; cherry-picks for fixes go on `audit/v1-fixes`.
- Bug-bounty interaction: any finding from this audit is **not** eligible for our future bug bounty; auditors are paid via this engagement.

---

## 10. Communication and operations

- **Primary channel**: encrypted email (PGP). Fingerprint above.
- **Real-time channel**: Signal group (members: 2 from each side, named).
- **Collaboration**: shared Notion workspace OR your preferred docs platform; please specify in proposal.
- **Status cadence**: weekly written update (1 page), bi-weekly 30-min video sync.
- **Severity escalation**: any finding rated Critical to be communicated within 24 hours of internal triage, not held for the weekly report.

---

## 11. Proposal contents requested

Please structure your proposal as follows. Length flexible; we read in full.

1. **Cover letter** — firm overview, conflict-of-interest declarations.
2. **Proposed team** — named auditors with brief CVs and engagement allocation (% time).
3. **Methodology** — your standard process, plus any deviations for this engagement.
4. **Scope confirmation** — explicit acknowledgement of section 2 in this RFP, with any proposed scope changes.
5. **Threat model preview** — your initial reading of section 3, with anything you'd add or de-prioritize.
6. **Timeline** — Gantt or equivalent, with milestones and dependencies on us.
7. **Pricing** — fixed bid OR time-and-materials with cap; payment milestones.
8. **Sample deliverables** — link to a redacted past report (or full report if public).
9. **References** — 2-3 past clients we may contact (with their permission).
10. **Legal** — your standard MSA/NDA, indemnification limits, liability cap.

Submit as PDF to [YOUR_EMAIL], encrypted to the PGP key above. If you cannot use PGP, we accept Proton Mail [PROTON_ADDRESS_PLACEHOLDER].

---

## 12. Closing

We are building Worker's Wallet for users who, by and large, cannot afford to lose their funds. We want this audit to be done with care, and we recognize that the right firm for us may not be the cheapest. We thank you for your time in reviewing this RFP.

— [YOUR_NAME], on behalf of [COMPANY_LEGAL_NAME]
[YOUR_EMAIL] · [PGP_FINGERPRINT] · [SIGNAL_HANDLE_OR_NUMBER]
