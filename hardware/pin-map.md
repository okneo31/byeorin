# nRF52840 Pin Map — 노동자의 지갑 Cold (v0)

MCU: **Nordic nRF52840-QIAA-R** (aQFN73). All GPIO 3.3 V CMOS unless noted.
Pin numbering follows the nRF52840 product spec; GPIO designators follow
Nordic's `P<port>.<pin>` convention.

Legend: **IN** = MCU input, **OUT** = MCU output, **BIDIR** = bidirectional bus.
**RES** = reserved / do not route. Default state at boot is given where it
matters for boot security.

## Power, ground, reset

| Pin | Net | Function | Notes |
|---|---|---|---|
| VDD, VDDH | 3V3 | Main supply | From TPS62840 output. 100nF + 10uF decoupling, ferrite bead between VDDH and VDD if using BLE TX +8 dBm. |
| VBUS | USB_5V | USB sense | Direct from USB-C VBUS through 1 kΩ + ESD. |
| VSS (multi) | GND | Ground | Stitched via 4-layer PCB. |
| DEC1, DEC2, DEC3, DEC4, DEC5, DEC6 | — | Internal LDO decoupling | 100 nF X7R 0402 each, per Nordic ref design. |
| XC1, XC2 | Y2 | 32 MHz HFXO | NX2016SA + 2× 12 pF C0G. **BLE mandatory.** |
| P0.00, P0.01 | Y1 | 32.768 kHz LFXO | Epson FC-135 + 2× 6.8 pF. Required for low-power sleep. |
| nRESET (P0.18) | RESET_N | System reset | 10 kΩ pull-up to 3V3, 100 nF cap. Test point TP_RST removed after PVT. |
| SWDIO (P0.19) | SWD_IO | Debug data | SWD header populated at EVT/DVT only. APPROTECT enabled at PVT. |
| SWDCLK | SWD_CLK | Debug clock | Same as above. |

## SE050 (Secure Element) — I²C

| Pin | GPIO | Function | Notes |
|---|---|---|---|
| 6 | **P0.04** | SE050_SDA (TWIM0 SDA) | I²C 1 MHz fast-mode plus, 4.7 kΩ pull-up to 3V3. Star-route, keep < 30 mm. |
| 7 | **P0.05** | SE050_SCL (TWIM0 SCL) | 4.7 kΩ pull-up. |
| 8 | **P0.06** | SE050_ENA | OUT, drives SE050 ENA pin. Default LOW at reset → SE off until firmware enables. |
| 9 | **P0.07** | SE050_RSTn (optional) | OUT, only if footprint populated. DNP in v1. |

## E-ink display (GoodDisplay GDEW0154M09 / SSD1681) — SPI

| Pin | GPIO | Function | Notes |
|---|---|---|---|
| 11 | **P0.08** | EINK_SCK (SPIM1 SCK) | SPI 4 MHz; SSD1681 max 20 MHz but EMI margin kept low. |
| 12 | **P0.09** | EINK_MOSI (SPIM1 MOSI) | — |
| — | — | EINK_MISO | **Not connected** (display is write-only). |
| 13 | **P0.10** | EINK_CSn | OUT, active low. |
| 14 | **P0.11** | EINK_DC | OUT, data/command select. |
| 15 | **P0.12** | EINK_RSTn | OUT, drives display reset; default LOW at boot. |
| 16 | **P0.13** | EINK_BUSY | IN, no pull. Display drives high during refresh (waits ~700 ms full / ~250 ms partial). |

## Buttons

| Pin | GPIO | Function | Notes |
|---|---|---|---|
| 17 | **P0.14** | BTN_UP (front) | IN, internal pull-up enabled. Active LOW. Wakeup-capable via GPIOTE PORT event. |
| 18 | **P0.15** | BTN_CONFIRM (front) | IN, internal pull-up. Active LOW. Wakeup-capable. |
| 19 | **P0.16** | BTN_POWER (side) | IN, internal pull-up. Active LOW. **Wake-from-SYSTEM_OFF source**; long-press 3 s = factory reset / recovery mode entry. |

## Power management — BQ25180 + battery monitor

| Pin | GPIO | Function | Notes |
|---|---|---|---|
| 20 | **P0.17** | PMIC_SDA (TWIM1 SDA) | Separate I²C bus from SE; 4.7 kΩ pull-up. |
| 22 | **P0.20** | PMIC_SCL (TWIM1 SCL) | — |
| 23 | **P0.21** | PMIC_INT | IN, falling-edge wake. BQ25180 interrupt on charge complete / fault. |
| 24 | **P0.22** | VBAT_SENSE (AIN0 / SAADC ch0) | Battery voltage divider, 2× 1 MΩ + 100 nF, sampled every 30 s. |
| 25 | **P0.23** | USB_VBUS_SENSE | IN, GPIOTE high-to-low for USB attach/detach. Already gated by VBUS divider 100k/100k. |

## Status LED

| Pin | GPIO | Function | Notes |
|---|---|---|---|
| 26 | **P0.24** | LED_STATUS | OUT (PWM via TIMER1/PWM0). 1 kΩ series, active LOW (LED cathode to GPIO, anode to 3V3). |

## USB-FS (built-in)

| Pin | Net | Function | Notes |
|---|---|---|---|
| D+ | USB_DP | USB data plus | Route differential pair, 90 Ω diff impedance, 5 mm to ESD device. |
| D− | USB_DM | USB data minus | Same. |
| VBUS (USB) | USB_5V | USB sense | Internal USB peripheral senses VBUS through dedicated pin (see datasheet). |

## BLE antenna

| Pin | Net | Function | Notes |
|---|---|---|---|
| ANT | RF_OUT | Single-ended 50 Ω BLE | Through pi-matching network (C-L-C) to Johanson chip antenna or balun if a module is later substituted. Keep-out zone ≥ 5 × 10 mm with **no copper on any layer**. |

## Reserved / NC pins

| GPIO | Reason |
|---|---|
| P0.02, P0.03 | RES — kept for analog reference / future capacitive button rework. |
| P0.25 – P0.31 | RES — break out to test pads only, no nets. |
| P1.00 – P1.15 | RES (port 1) — most unused; P1.00 reserved for future QSPI flash (CS), P1.01-P1.04 for IO0-IO3 if MX25R1635F populated. |

## Boot strapping & security

- **APPROTECT (UICR.APPROTECT)**: written to `Enabled (0x00)` on the production
  programming station at PVT. After this point SWD readback is blocked.
- **BOOTLOADER (UICR.BOOTLOADERADDR)**: points to FSBL at `0x000F8000`.
- All test points (SWD, UART log, VBAT) are placed on the bottom side and are
  **physically blocked by the bottom shell** after assembly; no pad is exposed
  through any case opening.

## Quick wire-up table (one-page summary)

| Function | Pin |
|---|---|
| SE050 I²C SDA/SCL/ENA | P0.04 / P0.05 / P0.06 |
| E-ink SCK/MOSI/CS/DC/RST/BUSY | P0.08 / P0.09 / P0.10 / P0.11 / P0.12 / P0.13 |
| Buttons UP/CONFIRM/POWER | P0.14 / P0.15 / P0.16 |
| PMIC I²C SDA/SCL/INT | P0.17 / P0.20 / P0.21 |
| VBAT ADC | P0.22 (AIN0) |
| USB VBUS sense | P0.23 |
| Status LED | P0.24 |
| HFXO / LFXO | XC1-XC2 / P0.00-P0.01 |
| SWD | SWDIO / SWDCLK (locked at PVT) |
