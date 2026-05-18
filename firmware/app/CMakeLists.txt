# SPDX-License-Identifier: Apache-2.0
#
# 벼린 요세 — application CMakeLists.
#
# Targets Zephyr 3.7. Builds against board overlays in ./boards/.
# Bootloader (MCUBoot) is a separate build configuration — see src/bootloader/README.md.

cmake_minimum_required(VERSION 3.20.0)

# Allow consumers to set BOARD via env, default to nRF52840 DK for dev.
if(NOT DEFINED BOARD)
  set(BOARD nrf52840dk_nrf52840)
endif()

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(byeorin_yose
  VERSION 0.0.1
  LANGUAGES C
  DESCRIPTION "Worker's Wallet (벼린) Cold — hardware wallet firmware"
)

# C99 + a couple of common warning escalations.
target_compile_options(app PRIVATE
  -Wall
  -Wextra
  -Wno-unused-parameter
  -Werror=implicit-function-declaration
  -Werror=incompatible-pointer-types
)

target_include_directories(app PRIVATE src)

target_sources(app PRIVATE
  src/main.c

  # Transport
  src/transport/usb_hid.c
  src/transport/ble.c
  src/transport/apdu.c

  # Secure element
  src/se/se050.c

  # Key derivation (thin wrapper over SE)
  src/keys/derive.c

  # User-interface
  src/ui/display.c
  src/ui/buttons.c
  src/ui/confirm.c

  # Per-chain "apps" (display layers only — signing is generic)
  src/apps/evm_app.c
  src/apps/cosmos_app.c
  src/apps/btc_app.c
)

# If/when vendor middleware lands under third_party/se05x, link it here.
# add_subdirectory(../third_party/se05x se05x)
# target_link_libraries(app PRIVATE se05x_middleware)
