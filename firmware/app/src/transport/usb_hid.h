/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — USB-HID transport.
 *
 * APDUs travel inside Ledger-compatible HID reports:
 *
 *   Byte 0..1 : channel ID (we use 0x0101)
 *   Byte 2    : tag (0x05 = APDU)
 *   Byte 3..4 : sequence index, big-endian (0 == first fragment)
 *   First fragment only — Byte 5..6 : total APDU length, big-endian
 *   Remaining payload bytes follow until the report is full.
 *
 * Each report is exactly CONFIG_NODONG_USB_HID_REPORT_LEN bytes
 * (default 64). Responses use the same framing in reverse.
 */
#ifndef NODONG_USB_HID_H_
#define NODONG_USB_HID_H_

#include <stddef.h>
#include <stdint.h>

#define NODONG_HID_CHANNEL_ID   0x0101u
#define NODONG_HID_TAG_APDU     0x05u

/* Lifecycle */
int  nodong_usb_hid_init(void);
int  nodong_usb_hid_start(void); /* enables the USB device + endpoints */
void nodong_usb_hid_stop(void);

/*
 * Pushes one outgoing APDU response. The transport will fragment it
 * across as many 64-byte reports as needed. Returns 0 on success.
 * Thread context: callable from the dispatcher thread only.
 */
int nodong_usb_hid_send(const uint8_t *apdu, size_t len);

/*
 * Caller-side hook: the transport calls this with a fully reassembled
 * inbound APDU. Implemented by the dispatch layer.
 */
typedef void (*nodong_apdu_inbound_cb)(const uint8_t *apdu, size_t len);
void nodong_usb_hid_register_apdu_cb(nodong_apdu_inbound_cb cb);

#endif /* NODONG_USB_HID_H_ */
