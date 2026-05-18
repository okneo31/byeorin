# 벼린 요세 — Firmware

Firmware for the **벼린 요세** (Worker's Wallet Cold) hardware wallet.
Target SoC: Nordic **nRF52840**. Secure Element: NXP **SE050**.
Runs on **Zephyr RTOS**. Communicates with the companion software (`apps/desktop`, `packages/wallet-sdk`) over **USB-HID** and **BLE GATT**.

This firmware is intentionally minimal: it does not parse chain-specific transaction formats deeply. The companion SDK (`packages/wallet-sdk/ChainAdapter.serializeForSigning`) hands the device a **32-byte digest**, a curve identifier, and a BIP32 path. The device displays a human-readable summary on the e-ink panel, waits for a physical button confirmation, and asks the SE050 to sign. Private keys never leave the secure element.

## Hardware (see `hardware/SPEC.md`)

- nRF52840 (BLE 5 + USB 2.0 FS)
- NXP SE050 over I2C (seed storage, key derivation, ECDSA/EdDSA signing, monotonic counter)
- 1.54" e-ink panel, SSD1681 / UC8151 controller, over SPI3
- 2 physical buttons: **OK** (P0.13), **CANCEL** (P0.15)
- USB-C (CDC + HID)
- Status LED

## Dependencies

- **Zephyr SDK ≥ 3.7.0** (this manifest pins `v3.7.0`)
- **nRF Connect SDK** (`sdk-nrf`) `v2.7.0` — pulled via west
- **west** ≥ 1.2
- **GCC ARM Embedded toolchain** (or the Zephyr SDK's `arm-zephyr-eabi`)
- **Python ≥ 3.10** (for west + pyocd/nrfjprog)
- **MCUBoot** — pulled as a west module; used as the secure bootloader (separate build)

## Building (from a clean checkout)

```bash
# 1. Initialise the west workspace using THIS repo's manifest
west init -l firmware/
west update

# 2. Export Zephyr CMake package
west zephyr-export

# 3. Build for the development board
west build -b nrf52840dk_nrf52840 firmware/app \
  -- -DDTC_OVERLAY_FILE=boards/nrf52840_byeorin_yose.overlay

# 4. Flash
west flash
```

For production hardware (custom board `byeorin_yose`), the board file lives under `firmware/boards/`. Pass `-b byeorin_yose` once the board YAML is added.

### Bootloader (MCUBoot)

MCUBoot is built **separately** with its own Zephyr build configuration. Application images are signed with `imgtool.py` using the project signing key. See `app/src/bootloader/README.md`.

## Layout

```
firmware/
├── west.yml                        # west manifest
├── zephyr/module.yml               # declares this tree as a Zephyr module
├── boards/                         # (future) custom board files for the production HW
├── app/
│   ├── CMakeLists.txt
│   ├── prj.conf
│   ├── Kconfig
│   ├── boards/
│   │   └── nrf52840_byeorin_yose.overlay
│   └── src/
│       ├── main.c
│       ├── version.h
│       ├── log.h
│       ├── transport/   # USB-HID, BLE GATT, APDU dispatch
│       ├── se/          # SE050 wrapper
│       ├── keys/        # key derivation (delegated to SE)
│       ├── ui/          # display, buttons, confirm-dialog
│       ├── apps/        # chain-app display layers (EVM, Cosmos, BTC)
│       └── bootloader/  # MCUBoot integration notes
└── test/                # Renode-based emulation tests (CI)
```

## Status

Scaffold only. Every hardware-touching function returns `-ENOSYS` or a stub. See the top-level `docs/PLAN.md` § 3 for the integration roadmap.
