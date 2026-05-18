/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — application entry point.
 *
 * Boot sequence:
 *   1. Init logging.
 *   2. Init UI (display, buttons).
 *   3. Init SE050 (i2c0 must be up).
 *   4. Init transports: USB-HID first (cabled), then BLE (if enabled).
 *   5. Wire transport → APDU dispatcher.
 *   6. Show the idle "Worker's Wallet — ready" screen.
 *   7. Enter the message-loop thread; main() returns.
 *
 * The message loop is intentionally simple: one queue, drained by one
 * thread. Confirmation dialogs block that thread on purpose — there is
 * no "concurrent signing".
 */

#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/device.h>

#include "version.h"
#include "log.h"
#include "transport/apdu.h"
#include "transport/usb_hid.h"
#include "transport/ble.h"
#include "se/se050.h"
#include "ui/display.h"
#include "ui/buttons.h"
#include "ui/confirm.h"

LOG_MODULE_REGISTER(byeorin_main, CONFIG_LOG_DEFAULT_LEVEL);

#define APDU_QUEUE_SLOTS    4
#define APDU_BUF_BYTES      CONFIG_BYEORIN_MAX_APDU_LEN
#define MSG_THREAD_STACK    4096
#define MSG_THREAD_PRIO     5

struct apdu_msg {
	byeorin_transport_t origin;
	size_t             len;
	uint8_t            data[APDU_BUF_BYTES];
};

K_MSGQ_DEFINE(m_apdu_q, sizeof(struct apdu_msg), APDU_QUEUE_SLOTS, 4);

static void enqueue_apdu(const uint8_t *apdu, size_t len, byeorin_transport_t o)
{
	struct apdu_msg m = { .origin = o, .len = len };
	if (len > APDU_BUF_BYTES) {
		ND_LOG_ERR("apdu over %u bytes — dropped", APDU_BUF_BYTES);
		return;
	}
	memcpy(m.data, apdu, len);
	if (k_msgq_put(&m_apdu_q, &m, K_NO_WAIT) != 0) {
		ND_LOG_ERR("apdu queue full");
	}
}

static void on_usb_apdu(const uint8_t *a, size_t l)
{
	enqueue_apdu(a, l, BYEORIN_TRANSPORT_USB_HID);
}

static void on_ble_apdu(const uint8_t *a, size_t l)
{
	enqueue_apdu(a, l, BYEORIN_TRANSPORT_BLE);
}

static void show_idle_screen(void)
{
	display_clear();
	(void)display_draw_text(8,  32, 2, "Worker's Wallet");
	(void)display_draw_text(8,  72, 1, "벼린");
	(void)display_draw_text(8, 144, 0, "fw " BYEORIN_FW_VERSION);
	(void)display_draw_text(8, 160, 0, "Ready.");
	(void)display_refresh_full();
}

static void msg_thread_fn(void *a, void *b, void *c)
{
	(void)a; (void)b; (void)c;

	uint8_t resp_buf[APDU_BUF_BYTES];

	for (;;) {
		struct apdu_msg m;
		k_msgq_get(&m_apdu_q, &m, K_FOREVER);

		struct byeorin_apdu_cmd cmd;
		if (byeorin_apdu_parse(m.data, m.len, &cmd) != 0) {
			ND_LOG_WRN("malformed apdu, len=%zu", m.len);
			continue;
		}
		cmd.origin = m.origin;

		struct byeorin_apdu_resp resp = {
			.data     = resp_buf,
			.capacity = sizeof(resp_buf) - 2,
			.len      = 0,
			.sw       = BYEORIN_SW_INTERNAL_ERROR,
		};
		(void)byeorin_apdu_dispatch(&cmd, &resp);

		uint8_t out[APDU_BUF_BYTES];
		int n = byeorin_apdu_serialize(&resp, out, sizeof(out));
		if (n < 0) {
			ND_LOG_ERR("serialize failed: %d", n);
			continue;
		}

		if (m.origin == BYEORIN_TRANSPORT_USB_HID) {
			(void)byeorin_usb_hid_send(out, (size_t)n);
		} else {
			(void)byeorin_ble_send(out, (size_t)n);
		}
	}
}

K_THREAD_DEFINE(byeorin_msg_thread, MSG_THREAD_STACK,
		msg_thread_fn, NULL, NULL, NULL,
		MSG_THREAD_PRIO, 0, 0);

int main(void)
{
	ND_LOG_INF("벼린 요세 — boot, fw=%s", BYEORIN_FW_VERSION);

	if (display_init() != 0) {
		ND_LOG_WRN("display_init failed (continuing for dev board)");
	}
	if (buttons_init() != 0) {
		ND_LOG_ERR("buttons_init failed");
	}
	if (se_init() != 0) {
		ND_LOG_ERR("se_init failed — device unusable for signing");
	}

	byeorin_usb_hid_register_apdu_cb(on_usb_apdu);
	byeorin_ble_register_apdu_cb(on_ble_apdu);

	(void)byeorin_usb_hid_init();
	(void)byeorin_usb_hid_start();
	(void)byeorin_ble_init();
	(void)byeorin_ble_start_advertising();

	show_idle_screen();
	return 0;
}
