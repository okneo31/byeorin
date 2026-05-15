# 노동자의 지갑 Cold — Hardware Specification (v0)

> 노동자의 지갑 — 노동의 가치를 지키는 작은 금고. *Worker's Wallet Cold: a small vault for the value of labor.*

| Field | Value |
|---|---|
| Document version | v0 (pre-EVT) |
| Date | 2026-05 |
| Owner | Hardware team, 노동자의 지갑 project |
| Status | Draft — for hardware vendor + SE distributor review |
| Companion document | `docs/PLAN.md` §3 |

---

## 1. Overview

**노동자의 지갑 Cold** is a USB-C + BLE hardware wallet co-designed with the
노동자의 지갑 software suite (Web / Browser-Extension / Desktop / Mobile)
already shipping atop `packages/wallet-sdk`. The device generates and stores
BIP-39 seeds inside a CC EAL6+ Secure Element, displays transaction details on
a 1.54" e-ink panel, and requires physical button confirmation before any
signature leaves the SE. APDU framing is **Ledger-compatible** so that the
existing `@ledgerhq/hw-transport-webhid` / `-webusb` / `-node-hid` stack can be
reused unchanged in the SW shells.

Target retail price: **USD 129–179**. Target BOM (1k volume): **USD 35–55**.
Form factor: ~64 × 39 × 9 mm, ~30 g, single-piece extruded aluminium shell with
PC top window over the e-ink. Two front tactile buttons (UP/CONFIRM-style
mapping decided in firmware), one side power/recovery button, status LED.

The supported chain set is whatever the SDK supports at HW GA:
EVM (TTL 7777 + Ethereum, Polygon, BSC, Arbitrum, Optimism, Base, Avalanche),
BTC, XRP, Cosmos family, Solana, TRON, and (best effort) TON / Aptos / Sui.
Per-chain logic runs as a sandboxed app on the MCU; **the SE only sees opaque
hashes to sign and never the parsed transaction**.

---

## 2. Functional Requirements

| ID | Requirement |
|---|---|
| F-01 | Generate BIP-39 seed (128/256-bit entropy) inside the SE using its on-die TRNG; entropy never leaves the SE. |
| F-02 | Persist seed + per-chain derived keys inside the SE; MCU has zero key material at rest. |
| F-03 | Display destination address, amount, fee, and chain name on the e-ink for every signing operation; require physical button press to confirm. |
| F-04 | Communicate with host over USB-HID (primary) and BLE GATT (mobile). APDU framing is binary-compatible with `@ledgerhq/hw-transport`'s HID transport. |
| F-05 | Provide signed firmware updates with anti-rollback counter stored in SE secure storage. |
| F-06 | Support seed recovery via 12/24-word entry (button-driven word picker) or via SLIP-39 Shamir share import. |
| F-07 | Enforce user PIN (4–8 digits) with exponential back-off on failures; SE wipes seed after 8 consecutive failures. |
| F-08 | Optional passphrase (BIP-39 §8) entered via on-device picker, never sent over USB/BLE. |
| F-09 | Display "this is a genuine device" attestation flow on first boot using SE-bound X.509 attestation cert. |
| F-10 | Support cold-boot under USB power even with empty battery (BLE disabled until battery > 15 %). |

---

## 3. Non-Functional Requirements

| Property | Target |
|---|---|
| Battery life — active BLE signing | ≥ 6 h continuous |
| Battery life — idle (sleep) | ≥ 30 days |
| Battery life — deep storage (radios off, no waking) | ≥ 12 months |
| Cold boot to home screen | ≤ 1.5 s |
| Sign-and-display latency (256-byte tx) | ≤ 400 ms (excluding user button time) |
| Peak power draw (BLE TX + e-ink refresh) | ≤ 90 mA @ 3.3 V |
| Operating temperature | 0 – 45 °C |
| Storage temperature | −20 – 60 °C |
| Weight | ≤ 35 g |
| ESD immunity | IEC 61000-4-2 ±8 kV contact / ±15 kV air on all user-touchable surfaces |
| Drop survival | 1.2 m onto hardwood (5/6 orientations) |

---

## 4. System Architecture

```
        ┌────────── Host (PC / Phone) ───────────┐
        │  노동자의 지갑 SW (Web/Ext/Desk/Mobile)│
        │  @ledgerhq/hw-transport-*  (HID/BLE)   │
        └───────────────┬────────────────────────┘
                        │  Ledger-style APDU
              ┌─────────┴──────────┐
              │ USB-C (HID 0xF1D0) │ BLE 5.0 GATT
              └─────────┬──────────┘
                        │
┌───────────────────────┴──────────────────────────────────┐
│                  MCU — Nordic nRF52840                    │
│  ┌───────────────────────────────────────────────────┐    │
│  │ Bootloader (signed, anti-rollback via SE)         │    │
│  ├───────────────────────────────────────────────────┤    │
│  │ Core firmware                                      │    │
│  │  · USB-HID + BLE GATT transports                  │    │
│  │  · APDU router  · UI / e-ink driver               │    │
│  │  · Input driver · Power/PMIC driver               │    │
│  ├───────────────────────────────────────────────────┤    │
│  │ Chain Apps (sandbox, 1 app = 1 chain family)      │    │
│  │  EVM | BTC | XRP | Cosmos | SOL | TRON | …        │    │
│  └────────────────────┬──────────────────────────────┘    │
└───────────────────────┼───────────────────────────────────┘
        ┌───────────────┼─────────────────────┐
        │ I2C (1 MHz)   │ SPI (4 MHz)         │ GPIO
        ▼               ▼                     ▼
   ┌─────────┐     ┌──────────┐         ┌──────────┐
   │ SE      │     │ e-ink    │         │ Buttons  │
   │ NXP     │     │ 1.54"    │         │ × 3,     │
   │ SE050   │     │ 200×200  │         │ LED × 1  │
   └─────────┘     └──────────┘         └──────────┘
                        ▲
                        │
              ┌─────────┴─────────┐
              │ Battery 200 mAh   │
              │ + PMIC (BQ25180)  │
              └───────────────────┘
```

The MCU is the only component with code execution exposed to USB/BLE. The
SE is reachable **only** via the MCU's I2C bus and never directly from the
host transport.

---

## 5. Component Decisions

### 5.1 Secure Element

| | |
|---|---|
| **Choice** | **NXP SE050C2HQ1/Z01V** (I2C, CC EAL 6+, 50 kB user flash) |
| **Alternative** | STMicro ST31N600 (Ledger Nano S+/X part, NDA-gated) — or Microchip ATECC608B-TFLXTLS as ultra-low-cost fallback |
| **Rationale** | SE050 has a publicly available datasheet, full Plug-and-Trust C middleware on GitHub, supports secp256k1 / secp256r1 / Ed25519 / RSA, and is purchasable through Mouser/DigiKey without an NDA. ST31 is more battle-tested in wallets but requires a signed NDA with ST and a custom JavaCard applet — a 6-month critical-path risk. |
| **Risk** | NXP automotive lines have run hot on lead times (16–32 wk historically). Need to qualify second-source ST31 in parallel and keep ≥10k pcs safety stock once we hit DVT. |

### 5.2 MCU

| | |
|---|---|
| **Choice** | **Nordic nRF52840 (QIAA-R)** — Cortex-M4F, 1 MB Flash, 256 kB RAM, USB-FS, BLE 5.0, ARM CryptoCell-310 |
| **Alternative** | nRF52840 Module form (Raytac MDBT50Q-1MV2 or Fanstel BC840M) for pre-certified BLE; or STM32WB55 if we must own the BLE stack license. |
| **Rationale** | Single chip gives BLE + USB + crypto accelerator + enough Flash for bootloader (128 kB) + core OS (256 kB) + 6–8 chain apps (~64 kB each). Pre-certified module variant cuts BLE/FCC effort by ~4 weeks and ~USD 8k in test-house time. |
| **Risk** | nRF52840 die has had public glitching attacks (LimitedResults 2020). Mitigation: keep all key material in SE and gate the bootloader anti-rollback on SE-stored counter. |

### 5.3 Display

| | |
|---|---|
| **Choice** | **GoodDisplay GDEW0154M09** — 1.54", 200×200, SPI, 4-level greyscale, partial refresh |
| **Alternative** | WaveShare 1.54" V2 (same controller, looser tolerance) |
| **Rationale** | Industry-standard pinout (SSD1681 controller), readily second-sourced, ghosting acceptable for our short-string use case, ≤ 26 mW peak refresh. E-ink chosen over OLED for low-power sleep and to avoid retaining sensitive data on screen. |
| **Risk** | GoodDisplay MOQ at custom FPC length can push to 5k. Specify standard 24-pin FPC to stay catalog. |

### 5.4 Buttons / Switches

| | |
|---|---|
| **Choice** | 2× Alps SKRPACE010 SMD tact (front: UP, CONFIRM), 1× C&K PTS526 SMTRBLFS (side: power/recovery) |
| **Alternative** | Omron B3U-1000P for front, Panasonic EVQ-PUJ02K for side |
| **Rationale** | All three are catalog parts on Mouser/DigiKey with ≥ 100k actuation rating and < USD 0.20 each at 1k. Pure mechanical (no touch IC) keeps BOM and certification simple. |
| **Risk** | None significant. Avoid through-hole to keep autoplace SMT line. |

### 5.5 USB-C Connector + ESD

| | |
|---|---|
| **Choice** | GCT USB4105-GF-A (USB-C 2.0, 16-pin, mid-mount) + Nexperia PRTR5V0U2X (2-channel ESD on D+/D−) + 2× 5.1 kΩ ±5 % 0402 (CC1/CC2 pulldown to advertise as a USB 2.0 device — not a PD sink) |
| **Alternative** | Amphenol 12401610E4#2A connector; Littelfuse SP0503BAHTG ESD |
| **Rationale** | USB 2.0 only (480 Mbps not needed); explicit 5.1 kΩ CC pulldowns are the documented and PD-compliant way to negotiate 5 V from a PD source. No PD controller required — saves USD 0.40 + 4 mm². |
| **Risk** | Hand-solder of mid-mount USB-C in EVT is error-prone; require X-ray inspection on first 50 boards. |

### 5.6 BLE Antenna

| | |
|---|---|
| **Choice** | Johanson 2450AT18A100E ceramic chip antenna + matching network (pi-network, parts populated after VNA tuning at EVT) |
| **Alternative** | Use the **module** SKU of the MCU (Raytac MDBT50Q-1MV2) which ships with antenna + FCC/CE/KC modular pre-certification, eliminating most RF risk. |
| **Rationale** | Chip antenna keeps cost low; if we are time-pressured the module path is cheaper in NRE even though BOM cost is +USD 2.50. **Decision gate at EVT-1.** |
| **Risk** | Chip antenna efficiency falls off badly inside an aluminium shell — confirmed-required PC top window above the antenna keep-out. |

### 5.7 Battery + PMIC / Charge IC

| | |
|---|---|
| **Choice** | EVE LP402025 200 mAh 3.7 V LiPo (with onboard JEITA protection PCM, 2-pin Molex 53398-0271) + **TI BQ25180YBGR** linear charger w/ I²C + battery monitor |
| **Alternative** | PKCell LP402025; Nanjing Top Power TP4056 (charger only, no I²C — fallback if BQ25180 is on allocation) |
| **Rationale** | BQ25180 gives us battery voltage / state-of-charge over I²C without burning ADC channels and supports ship-mode (< 2 µA) for the "deep storage 12 mo" requirement. EVE is UL-1642 + IEC-62133 certified, shortens KC battery cert. |
| **Risk** | LiPo logistics — DG class 9. Must use battery supplier with MSDS + UN38.3 test report in hand at PVT. |

### 5.8 LDO / Power Tree (see §6)

| | |
|---|---|
| **Choice** | TI TPS62840 (60 nA Iq buck, 3.3 V main rail, 750 mA) + Diodes Inc AP2112K-1.8 (1.8 V LDO for SE050 VCC if jumper-selected) |
| **Alternative** | TI TPS62740 (slightly higher Iq, same package) |
| **Rationale** | SE050 runs at 1.62–3.6 V — running it from the same 3V3 rail as MCU is allowed and saves the 1V8 LDO. Keep 1V8 LDO footprint as **DNP** for now. |
| **Risk** | TPS62840 was on allocation in late 2024; verify Q2-2026 lead time. |

### 5.9 External Flash

| | |
|---|---|
| **Choice** | **None.** nRF52840's 1 MB internal flash covers bootloader (128 kB) + core OS (256 kB) + 8 chain apps (~64 kB each) + filesystem (~120 kB). |
| **Alternative** | Macronix MX25R1635F (16 Mbit QSPI) — populate footprint if app set exceeds 8. |
| **Rationale** | Avoids external-flash side-channel and supply-chain re-flash risk. |
| **Risk** | If we add Sui / Aptos / TON apps before v1 GA we may need to drop to 4 active chains or enable the QSPI footprint. |

### 5.10 Crystals / Oscillators

| | |
|---|---|
| **Choice** | 32.768 kHz Epson FC-135 ±20 ppm (LFXO) + 32 MHz NDK NX2016SA ±10 ppm (HFXO, BLE-grade) |
| **Alternative** | Abracon ABS07 (32 kHz); Abracon ABM8 (32 MHz) |
| **Rationale** | nRF52840 BLE radio needs ±40 ppm or better on HFXO — NX2016SA is the Nordic-recommended part and avoids BLE radio cert re-test. |
| **Risk** | 32 MHz xtals saw lead-time bumps; keep both Abracon and NDK qualified. |

### 5.11 RTC

| | |
|---|---|
| **Choice** | **None — use nRF52840 internal RTC** driven by 32.768 kHz LFXO. |
| **Rationale** | We don't need wall-clock time, only monotonic uptime + cooldown timers; an external RTC would add cost and an extra battery. |

### 5.12 Tamper / Secure Boot Fuses

| | |
|---|---|
| **Choice** | nRF52840 APPROTECT (factory-locked via UICR after PVT) + SE050 binding (bootloader checks SE attestation cert on every boot) |
| **Alternative** | Add mesh trace under SE if v2 EAL5+ target requires |
| **Rationale** | APPROTECT v2 (post errata 2021) blocks SWD readout; SE binding prevents board-swap. Sufficient for v1; v2 may add an active tamper mesh. |
| **Risk** | APPROTECT can be glitched on nRF52840 (public research) — treated as defence-in-depth, not the trust root. |

### 5.13 LED + Misc

- 1× 0603 green LED + 1 kΩ series on a PWM-capable GPIO for charge / activity.
- Vibration motor: **omit** in v1 (cost + waterproofing).
- Buzzer: **omit**.

---

## 6. Power Tree

```
USB 5V (VBUS) ──┬── BQ25180 (charger + path control)
                │       │
                │       └──► Battery 3.7 V (EVE 200 mAh)
                │                  │
                │                  ▼
                └─────────► VSYS (3.0–4.2 V, battery or USB)
                                   │
                                   ▼
                          TPS62840 buck → 3V3 main rail (750 mA)
                                   │
              ┌────────────────────┼─────────────────────┐
              ▼                    ▼                     ▼
         nRF52840 VDD          SE050 VCC           e-ink VDD + VDDIO
         (3.3 V)               (3.3 V)             (3.3 V)
                                                         │
                                    e-ink onboard chargepump → ±15 V panel rail
```

Optional 1V8 rail (DNP footprint): AP2112K-1.8 LDO from 3V3, populated only if a future SE revision (or ST31 second-source) requires it.

**Sleep states:**

| State | Trigger | MCU | Radios | E-ink | Iq target |
|---|---|---|---|---|---|
| ACTIVE | user interaction | run | USB or BLE | refresh on demand | 60–90 mA |
| IDLE | 15 s no input | sleep, RTC on | off | retained image | < 200 µA |
| DEEP_SLEEP | 5 min idle | System OFF, wake on button | off | retained image | < 4 µA |
| SHIP_MODE | factory / user command | off via BQ25180 | off | blank | < 2 µA |

---

## 7. Secure Boot & Firmware Update Flow

**Chain of trust:**

1. **nRF52840 ROM** (immutable) → verifies first-stage bootloader signature using a key fused into UICR at PVT.
2. **First-stage bootloader (FSBL)** → reads anti-rollback counter from SE050 secure storage; verifies second-stage / app slot signature against root public key; refuses to boot if version < counter.
3. **Application** → on every boot, opens an authenticated channel to SE050 using the SE's pre-provisioned attestation key; if the SE refuses, app halts.
4. **Chain apps** are signed by the same root and loaded by core firmware at runtime; each app is run in an MPU-isolated region.

**Firmware update:**

- A/B slot layout in internal flash. New image staged via USB-HID or BLE.
- Update package: `manifest.json` (version, hashes, min-rollback) + signed binary. Signature verified by FSBL before swap.
- Anti-rollback counter incremented in SE only after first successful boot of the new image (commit-on-success).
- Recovery mode entered by holding side button at power-on; allows re-flash of bootloader-trusted recovery image only.

---

## 8. Communication Interfaces

### 8.1 USB-HID

- USB-IF VID/PID strategy: **Apply for a real USB-IF VID** (cost: USD ~6,000 one-time) — required for Apple notarisation and to avoid VID/PID squatting. Until issued, use a sub-licensed PID from openmoko/pid.codes for EVT/DVT only.
- Class: HID, single Interface, Report Size 64 bytes IN + 64 bytes OUT, no consumer reports — same descriptor shape as Ledger Nano S so `@ledgerhq/hw-transport-webhid` enumerates without changes.
- Reported product string: `"Nodong Cold"`.

### 8.2 APDU Framing (Ledger-compatible)

```
HID Report (64 bytes):
  [0:2]  channel id (BE, 0x0101 default)
  [2]    command tag (0x05 = APDU)
  [3:5]  packet sequence (BE)
  [5:7]  total APDU length (BE, first packet only)
  [...]  APDU payload chunk
```

This is the framing used by Ledger's `hid-framing.js` and is implemented by
`@ledgerhq/hw-transport-webhid`. Our APDU class bytes use `0xE0` (Ledger
convention) with our own INS bytes per chain app — see `firmware/protocol.md`
(to be written).

### 8.3 BLE GATT

- Custom Primary Service UUID: `6e400001-1234-4e6f-646f-6e672d77616c` (deterministic from "nodong-walet"; final UUID issued at DVT).
- Two characteristics:
  - `…-0002` Write, Write-Without-Response (host → device, APDU chunks, 244 B MTU)
  - `…-0003` Notify (device → host)
- Connection-level encryption: LE Secure Connections + numeric comparison (6-digit code shown on the e-ink panel — mandatory for pairing).
- Application-level: AES-CCM channel using key derived from SE-side ECDH over secp256r1; SE handles the ECDH so the private side of the channel key is never in MCU RAM.

### 8.4 WebUSB / WebHID

- WebHID preferred (Chromium); WebUSB available as fallback. Browser-extension and Web shells use `@ledgerhq/hw-transport-webhid` already wired in `packages/wallet-sdk`.

---

## 9. Production Milestones

| Stage | Quantity | What it proves | Gate to next stage |
|---|---|---|---|
| **EVT-1** | 10 | Schematic + power tree + USB enumeration + SE I²C bring-up + e-ink draw. Hand-soldered USB-C acceptable. | All 10 boards enumerate over USB; SE attestation cert reads back; e-ink draws "HELLO". |
| **EVT-2** | 25 | BLE radio works inside (or near) shell; battery charges; full APDU round-trip from desktop app; bootloader signature check. | One full sign flow (BTC + TTL EVM) end-to-end from `apps/desktop`. |
| **DVT** | 200 | Final mechanicals (CNC shell, FPC routing, buttons feel), ESD pre-scan, external security audit (red team on firmware + APDU surface). | ESD ±8 kV contact passes on all surfaces; security audit report has zero "critical"; drop test 5/6 pass. |
| **PVT** | 1,000 | Production line at CM proves cycle-time, yield, tester throughput. Per-device attestation key provisioned via HSM on the line. | First-pass yield ≥ 92 %, line cycle ≤ 90 s, all certifications passed. |
| **MP** | ≥ 5,000 | Mass production. | n/a |

---

## 10. Certification Roadmap

| Cert | Scope | Standard | Est. cost (USD) | Weeks | Stage |
|---|---|---|---|---|---|
| FCC Part 15 Class B + DSS (BLE) | US sales, intentional radiator | 47 CFR §15.247 | ~$8k (with pre-cert MCU module: ~$3k) | 4–6 | PVT |
| CE RED | EU sales | EN 300 328, EN 301 489-1/-17, EN 62368-1 | ~$10k | 6–8 | PVT |
| KC | Korea sales (강행) | 방송통신기자재 등의 적합성평가 | ~$5k | 4 | PVT |
| RoHS / REACH | EU material restrictions | EN IEC 63000 | ~$1k (declaration-based, plus XRF) | 2 | DVT |
| UN 38.3 / IEC 62133 | LiPo transport + safety | UN Manual of Tests and Criteria | included in battery vendor | — | DVT |
| USB-IF compliance (optional v1) | USB logo | USB 2.0 CTS | ~$3k | 3 | PVT |
| FIDO / Common Criteria EAL5+ | v2 device-level | CC | $300k–$1M | 26–52 | **v2 only** |

Reusing a pre-certified BLE MCU module (Raytac/Fanstel) drops FCC/CE/KC radio
test cost by ~50 % and shaves ~4 weeks; **decision gate is at EVT-1**.

---

## 11. Open Questions (for vendor / SE distributor)

1. **SE050 lead time** at Mouser/Avnet for SE050C2HQ1/Z01V in 5k and 25k volumes as of Q3-2026? Confirm whether the C2 variant or the new SE051 is recommended for new designs (NXP issued a PCN in 2024).
2. **SE050 Plug-and-Trust middleware licensing** — is the Apache-2.0 reference enough to ship commercially, or do we need the paid "EdgeLock 2GO" service for line-side provisioning?
3. **Per-device attestation key provisioning** — does NXP support our own HSM-side CA chained off their factory cert, or do we need to use EdgeLock 2GO? What is the cost per device?
4. **MCU module vs. raw chip** — what is the NRE delta and FCC re-test delta between Raytac MDBT50Q-1MV2 (pre-cert) and a custom layout with chip antenna? Get a written quote.
5. **Aluminium shell + BLE** — does the CM's tooling allow a PC window above the antenna keep-out, or do we need a plastic top-third? Need EVT-2 RF efficiency measurement before locking mechanicals.
6. **Battery vendor UN38.3** — does EVE LP402025 ship with current UN38.3 + IEC 62133-2 + KC battery certs in hand, or do we need to re-test? Will they private-label?
7. **CM tooling for mid-mount USB-C** — what is the X-ray inspection cost per board, and is the CM willing to take USB-C reflow yield risk or do they pass it through?
8. **E-ink panel MOQ** — GoodDisplay GDEW0154M09 at our chosen FPC length: is the catalog 24-pin part in stock at 5k+ on standard lead time, or does any FPC tweak push us to a custom SKU?
9. **APPROTECT lock irreversibility** — we want APPROTECT enabled on every shipped device. Confirm that the CM's programming station can enforce this with no human override, and that returns/RMA can be triaged with units in this state (we cannot read flash on returns; expect bin-and-replace).
10. **USB-IF VID** — do we apply directly (USD ~6k + USD ~5k/year membership) or sub-license? Sub-licensing voids Apple notarisation for some macOS HID paths — verify.
11. **Tamper evidence** — does the case vendor offer a void-on-removal label that survives 12-month shelf life and operating temp 45 °C? Cost per unit?
12. **CC EAL pre-eval scoping** — what is the budget and timeline for a CC EAL5+ evaluation of the *combined* device (not just SE) targeting v2? Need a written scoping quote before we commit to a v2 roadmap date.

---

*— End of v0 spec. Next: lock SE choice, then EVT-1 schematic capture in KiCad
under `hardware/kicad/`.*
