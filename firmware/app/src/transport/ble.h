/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — BLE GATT transport.
 *
 * Service:
 *   - WW_SVC          (128-bit UUID, defined in ble.c)
 *     - WRITE_APDU    (write-without-response)  — companion → device
 *     - NOTIFY_RESP   (notify)                  — device → companion
 *
 * Same framing as USB-HID (Ledger-style) but using MTU-sized fragments
 * instead of fixed 64-byte reports. Pairing is required (BT_SMP=y) and
 * SIGN_HASH APDUs are refused over BLE unless CONFIG_NODONG_ALLOW_BLE_SIGNING.
 */
#ifndef NODONG_BLE_H_
#define NODONG_BLE_H_

#include <stddef.h>
#include <stdint.h>

int  nodong_ble_init(void);
int  nodong_ble_start_advertising(void);
void nodong_ble_stop_advertising(void);

/* Send one response APDU back to the connected central. */
int  nodong_ble_send(const uint8_t *apdu, size_t len);

typedef void (*nodong_ble_apdu_cb)(const uint8_t *apdu, size_t len);
void nodong_ble_register_apdu_cb(nodong_ble_apdu_cb cb);

#endif /* NODONG_BLE_H_ */
