# firmware/test

Unit + integration tests for the 벼린 요세 firmware.

## Approach

The firmware runs on a Cortex-M4 — we cannot run its tests on the host directly. Two layers of tests:

1. **Pure-host unit tests** (`firmware/test/host/`, future):
   For modules with **no Zephyr dependency** (notably `transport/apdu.c`, `keys/derive.c::keys_parse_path_*`, and the Bech32 helpers in `apps/cosmos_app.c`). Compiled with the host toolchain, linked with `cmocka`, run in `pnpm` CI like any other package.

2. **Emulated firmware tests via Renode**:
   For modules that need Zephyr running (`transport/usb_hid.c` state machine, `ui/buttons.c` debounce, `ui/confirm.c` flow), we boot the firmware ELF inside [Renode](https://renode.io) with a virtual nRF52840 platform plus a Python-driven SE050 mock and a virtual e-ink panel.

   The Renode scripts will live under `firmware/test/renode/` and are invoked by `pnpm --filter @byeorin/firmware-tests run renode`.

## What is *not* tested here

- SE050 hardware behaviour — those tests live in vendor middleware integration and must run on a real SE.
- BLE radio-layer compliance — exercised by Nordic's QC tooling on the bring-up board.

## CI

A future GitHub Actions job will:

1. Build the host unit tests with `cmake -S firmware/test/host -B build/host && cmake --build build/host && ctest`.
2. Build the firmware ELF with `west build` (matrix: dev board + production board).
3. Run Renode emulation tests against the ELF.

## Status

Placeholder. No tests are committed yet — first task once an embedded dev picks up the work is to land `transport/apdu` host tests, which can be authored before any hardware exists.
