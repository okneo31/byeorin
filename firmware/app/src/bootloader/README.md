# Bootloader — 벼린 요세

The 벼린 요세 uses **MCUBoot** as its secure bootloader. MCUBoot is built as a **separate Zephyr application**; the manifest (`firmware/west.yml`) pulls in `mcuboot` v2.1.0 alongside Zephyr.

## Why MCUBoot

- Battle-tested across Zephyr, NCS, Mynewt, ESP-IDF.
- Native support for **image signature verification** against an embedded ECDSA-P256 public key.
- Built-in **swap-move** semantics over MCU flash — interrupted upgrades cannot brick the device.
- Already integrated with Zephyr's `CONFIG_BOOTLOADER_MCUBOOT=y` + `img_mgmt` so application code can drive the upgrade flow over USB-HID (APDU `0xFE / 0xFD / 0xFC`).

## Flash layout

Matches `app/boards/nrf52840_byeorin_yose.overlay`:

| Partition       | Offset     | Size      | Notes                                       |
|-----------------|-----------:|----------:|---------------------------------------------|
| mcuboot         | `0x00000`  | `0x0C000` | Bootloader image (≤ 48 KB).                 |
| image-0 (slot0) | `0x0C000`  | `0x67000` | Active firmware.                            |
| image-1 (slot1) | `0x73000`  | `0x67000` | Update receive buffer + post-swap source.   |
| storage         | `0xDA000`  | `0x06000` | Zephyr NVS (BLE bonds, user settings).      |
| keystore-meta   | `0xE0000`  | `0x20000` | SE050 *object-ID* index (no secrets).       |

## Image signing

1. Generate an ECDSA-P256 signing key **offline, once**, on an airgapped machine:
   ```
   imgtool keygen --key mcuboot_priv.pem --type ecdsa-p256
   ```
2. Extract the corresponding public key and embed it in the MCUBoot build via `CONFIG_BOOT_SIGNATURE_KEY_FILE`. The pubkey ends up in the bootloader's read-only flash region.
3. Application images are signed in CI:
   ```
   imgtool sign --key mcuboot_priv.pem \
       --align 4 --version 0.0.1+0 \
       --header-size 0x200 --slot-size 0x67000 \
       zephyr.bin zephyr.signed.bin
   ```
4. The signed image is delivered to the device via `FW_UPGRADE_*` APDUs, written into slot1, then `boot_request_upgrade()` flips the trailer and the next reset performs the swap.

**The `mcuboot_priv.pem` key MUST never live in this repository.** It belongs in an offline HSM, with build agents fetching the public-key-only variant for verification.

## Anti-rollback policy

To prevent attackers from downgrading to a vulnerable firmware version we maintain a **monotonic counter inside the SE050** (object ID `SE_OID_ROLLBACK`, see `app/src/se/se050.c`).

Boot sequence:

1. MCUBoot validates the image signature.
2. MCUBoot reads the image's `image_ver` field.
3. The application's early-boot hook reads the SE counter via `se_anti_rollback_get()`.
4. If `image_ver < se_counter` → application refuses to start, requests USB rescue mode (re-flash with a properly signed downgrade-authorising image).
5. After a successful upgrade boot, the application calls `se_anti_rollback_set(image_ver)` (which the SE will refuse if `image_ver <= current` — defence in depth even if app logic is wrong).

The SE counter survives a full flash wipe of the MCU. That's the property that makes rollback genuinely irrecoverable for an attacker who only owns the MCU.

## Build (separate from app)

MCUBoot is built using its own `prj.conf`. The conventional workflow with `west`:

```
west build -d build/mcuboot -b nrf52840dk_nrf52840 \
  bootloader/mcuboot/boot/zephyr -- \
  -DCONFIG_BOOT_SIGNATURE_TYPE_ECDSA_P256=y \
  -DCONFIG_BOOT_SIGNATURE_KEY_FILE='"path/to/mcuboot_pub.pem"' \
  -DCONFIG_BOOT_BOOTSTRAP=n \
  -DCONFIG_BOOT_SWAP_USING_MOVE=y
```

Then build the application separately and flash both. Production manufacturing uses a combined hex via `imgtool` + `mergehex`.

## Status

This README is the *contract*. The actual bootloader build configuration ships when the production board file lands under `firmware/boards/`. The application side (`CONFIG_BOOTLOADER_MCUBOOT=y` in `prj.conf`) is already wired up.
