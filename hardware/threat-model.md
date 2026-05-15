# 노동자의 지갑 Cold — Hardware Threat Model (v0)

Companion to `hardware/SPEC.md`. References to spec sections use the form `SPEC §N`.

## 1. Assets

| ID | Asset | Where it lives | Sensitivity |
|---|---|---|---|
| A1 | BIP-39 seed (entropy / mnemonic) | SE050 secure storage only | **Catastrophic if leaked.** Funds-equivalent. |
| A2 | Per-chain derived private keys | SE050, ephemeral derivation at signing | Catastrophic. |
| A3 | Device PIN (4–8 digits) | SE050 secure counter + hash | High; gates A1/A2 use. |
| A4 | Optional BIP-39 passphrase | **Never persisted**; entered each session via on-device picker | High; combined with A1 = full key. |
| A5 | SE050 attestation private key + certificate chain | SE050 factory-bound | High; loss = device cannot prove genuineness. |
| A6 | Firmware signing root public key | nRF52840 UICR (fused at PVT) | High; loss/compromise = mass arbitrary firmware install. |
| A7 | Anti-rollback counter | SE050 secure storage | High; rollback bypass = re-exploit patched bug. |
| A8 | BLE pairing keys | SE050 (long-term), MCU RAM (session) | Medium; per-pairing scope. |
| A9 | User transaction history / metadata | **Not stored on device.** | n/a (out of scope). |

## 2. Attackers (capability tiers)

| ID | Attacker | Access | Budget | Goal |
|---|---|---|---|---|
| T1 | Remote-only | Host PC / phone, network, malicious dApp | Low | Trick user into signing wrong tx. |
| T2 | Malicious companion software | Compromised host SW, MITM USB-HID/BLE | Medium | Extract seed; sign without user consent. |
| T3 | Supply-chain (pre-purchase) | Tampered device before reaching user | High | Pre-seed device, weaken RNG, swap firmware. |
| T4 | Evil maid (post-purchase) | Brief unattended physical access (≤ 15 min) | Medium | Implant tampered firmware; observe PIN entry; clone device. |
| T5 | Customs / border / coercion | Hours of access, possibly with user under duress | Medium-High | Compel user to unlock; extract seed offline. |
| T6 | Well-funded lab | Permanent physical possession, expensive tooling (FIB, side-channel rigs, laser fault injection) | Very High | Extract A1 from a single recovered device. |

## 3. Trust boundaries

```
┌──────────────┐ untrusted ┌──────────────┐ semi-trusted ┌──────────────┐ trusted
│ Host SW      │ ◄──HID──► │ MCU          │ ◄──I²C────► │ SE050        │
│ dApp/web/etc │   BLE     │ nRF52840     │              │ (CC EAL6+)   │
└──────────────┘           └──────────────┘              └──────────────┘
                                  ▲                            
                                  │ buttons + e-ink            
                                  ▼                            
                              ┌──────────┐  ←─ the ONLY trusted I/O for user intent
                              │  User    │
                              └──────────┘
```

- **Host is untrusted.** Display+button confirmation is the only consent path.
- **MCU is semi-trusted.** It parses transactions but never owns keys; we assume MCU code may be exploitable and design so that an exploited MCU still cannot exfiltrate A1/A2 without user consent on each signature.
- **SE is trusted.** Trust scope: signing, key storage, attestation, anti-rollback counter, PIN counter.

## 4. Threats × Mitigations

| # | Asset(s) | Attacker | Threat | Mitigation | Spec ref |
|---|---|---|---|---|---|
| TH-01 | A1, A2 | T1, T2 | Host requests sign of a malicious tx hash | All sign requests require physical button-press after on-device display of destination + amount + chain (F-03). | SPEC §2 F-03, §8 |
| TH-02 | A1 | T2 | MITM injects "show address" command that swaps displayed address | Address display is rendered from the same path the SE will sign; SE returns address-derived from same path; "verify on device" is required UX. | SPEC §2 F-09 |
| TH-03 | A1 | T2 | Try to dump seed via custom APDU | APDU surface is whitelisted; SE has no "export seed" APDU exposed; recovery export only via on-device user flow. | SPEC §8.2 |
| TH-04 | A6, firmware integrity | T2 | Push malicious firmware over USB | A/B slot + signature verification by FSBL using UICR-fused root key; user must physically confirm update; anti-rollback counter checked. | SPEC §7 |
| TH-05 | A7 | T2 | Roll back to an old firmware with a known exploit | Anti-rollback counter stored in SE secure storage; FSBL refuses image with `version < counter`; counter advances only on successful boot. | SPEC §7 |
| TH-06 | A1 | T3 | Manufacturer pre-seeds device | Device must generate seed itself on first boot; a pre-seeded SE shows non-zero `init` flag and refuses to operate. First-boot attestation flow shows SE serial + CA-signed cert to verify SE was personalised by us. | SPEC §2 F-09 |
| TH-07 | A1 | T3 | Swap firmware before retail | All shipped firmware is signed; bootloader verifies; tamper-evident screws + void-on-removal label make physical swap detectable. | SPEC §5.13, BOM SCREW/SEAL |
| TH-08 | A1, A3 | T4 | Evil maid implants logger inside | Tamper-evident shell (Torx security screws + void seal); attestation flow re-checked on every boot; user trained to verify seal. | SPEC §5, BOM SCREW/SEAL |
| TH-09 | A3 | T4 | Shoulder-surf PIN entry | On-device PIN picker scrambles digit order each session; PIN never displayed in plain. | SPEC §2 F-07 |
| TH-10 | A3 | T1 (brute) | Try every PIN over USB | SE enforces exponential backoff; wipes seed after 8 wrong PINs. PIN counter lives in SE, not MCU. | SPEC §2 F-07 |
| TH-11 | A1 | T5 | Coerced unlock at border | **Optional BIP-39 passphrase** creates plausible-deniability wallet — main PIN unlocks a low-balance "duress" view; passphrase needed for real funds. Documented; risk to user explained in UX. | SPEC §2 F-08 |
| TH-12 | A1 | T6 | Decap SE and read flash | Out of scope for v1 device-level cert; we inherit SE050's CC EAL6+ resistance which already targets this class of attack. v2 may add active tamper mesh. | SPEC §5.1, §10 |
| TH-13 | A1 | T6 | Glitch MCU APPROTECT, dump nRF52840 flash | MCU flash contains no key material (keys live in SE only); SE binding means a cloned MCU cannot talk to its SE without the SE-bound credentials. | SPEC §5.2, §5.12 |
| TH-14 | A8 | T2 | Sniff BLE traffic | LE Secure Connections numeric comparison shown on e-ink (6-digit); application-layer AES-CCM with SE-side ECDH; no static keys. | SPEC §8.3 |
| TH-15 | A1 | T6 | Side-channel (DPA/CPA) on signing | Signing happens inside SE; SE050 has CC-evaluated side-channel countermeasures. MCU never touches private keys, so MCU-side leakage is non-fatal. | SPEC §5.1 |
| TH-16 | A1 | T3 | SDK supply chain — malicious chain app loaded at runtime | Chain apps signed by same root as firmware; FSBL verifies; loaded into MPU-isolated region; only signing requests with explicit user button consent leave the sandbox. | SPEC §7 |
| TH-17 | Firmware integrity | T6 | Physical re-flash via SWD | APPROTECT permanently enabled at PVT; SWD readback blocked. APPROTECT glitching is public — treated as defence-in-depth only, not the root. | SPEC §5.12 |
| TH-18 | User funds | T1 | Phishing companion app | Display the chain name, contract method (e.g. `approve`, `transfer`), and recipient on e-ink; show warning bar for unlimited approvals; this is firmware policy, not host-trusted. | SPEC §2 F-03 |
| TH-19 | A1 on recovery | T1 | Companion app prompts "enter recovery seed for backup" | Recovery seed entry is **input-only** on device. There is no "export over USB" APDU. | SPEC §8.2 |
| TH-20 | A1 (RNG) | T6 | Weak entropy at seed generation | Use SE050's certified TRNG; on first boot, mix with a user-button-timing-derived entropy pool as belt-and-braces (NIST SP 800-90B post-processing inside SE). | SPEC §2 F-01 |

## 5. Residual risks (explicitly accepted)

- **R-1 — APPROTECT glitch on nRF52840.** Public research shows it is bypassable with sub-USD-1000 gear. We accept because MCU holds no key material; attack yields firmware (which we publish anyway).
- **R-2 — User loses recovery card.** Out of scope — funds gone. Mitigated by recommending SLIP-39 Shamir share generation (2-of-3 default in companion UX).
- **R-3 — Coerced unlock with passphrase known.** No technical defence; passphrase + duress wallet reduces but cannot eliminate.
- **R-4 — Display readability under partial refresh ghosting.** Mitigation = full refresh on critical screens (address verify, fw update); accept the latency cost.
- **R-5 — Battery shipment regulation surprises.** Mitigated by EVE certs-in-hand; residual risk = freight delays at customs.

## 6. Non-goals (v1)

- **N-1.** EAL5+ device-level Common Criteria certification. We inherit SE EAL6+ only; device-level CC targets v2.
- **N-2.** Defence against well-funded lab (T6) invasive attacks (FIB, decap) on the SE die — handled by SE vendor, not us.
- **N-3.** Hidden / secret screen modes for nation-state evasion. Out of scope.
- **N-4.** Air-gapped-only operation (QR-only). Future product line, not this device.
- **N-5.** Multisig coordination on-device. Done in companion SW.
- **N-6.** Fingerprint / biometric unlock — adds cost, attack surface, and KC bio cert overhead disproportionate to v1 budget.

---

*— End v0 threat model. Next review at EVT-2 (after external security audit kickoff).*
