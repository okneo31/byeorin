/*
 * SPDX-License-Identifier: Apache-2.0
 * SECURITY-CRITICAL: changes require security review.
 * 노동자의 지갑 Cold — USB-HID transport (Ledger-style framing).
 *
 * State machine:
 *
 *  +---------------+    first-fragment    +---------------+
 *  | RX_IDLE       | -------------------> | RX_REASSEMBLE |
 *  | (seq expected |                      | (consume      |
 *  |   = 0)        |                      |  fragments    |
 *  +---------------+                      |  until total  |
 *         ^                               |  length met)  |
 *         |  apdu delivered to dispatch   +---------------+
 *         +-------------------------------|
 *
 *  Tx is the mirror: build a contiguous buffer, then chop into 64-byte
 *  reports tagged with sequence indices.
 */

#include "transport/usb_hid.h"
#include "log.h"

#include <errno.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>

LOG_MODULE_REGISTER(nodong_usb, CONFIG_LOG_DEFAULT_LEVEL);

#define HID_REPORT_LEN  CONFIG_NODONG_USB_HID_REPORT_LEN
#define MAX_APDU_LEN    CONFIG_NODONG_MAX_APDU_LEN

enum rx_state {
	RX_IDLE,
	RX_REASSEMBLE,
};

struct rx_ctx {
	enum rx_state state;
	uint16_t      total_len;
	uint16_t      cursor;
	uint16_t      next_seq;
	uint8_t       buf[MAX_APDU_LEN];
};

static struct rx_ctx           m_rx;
static nodong_apdu_inbound_cb  m_inbound_cb;

/*
 * Defence in depth: when we return to IDLE — whether because we
 * completed an APDU, the host sent a malformed fragment, or a sequence
 * number jumped — wipe the reassembly buffer so a subsequent partial
 * fill cannot expose stale bytes from an earlier (possibly aborted)
 * transaction to a later read.
 */
static void rx_reset(void)
{
	m_rx.state     = RX_IDLE;
	m_rx.total_len = 0;
	m_rx.cursor    = 0;
	m_rx.next_seq  = 0;
	memset(m_rx.buf, 0, sizeof(m_rx.buf));
}

void nodong_usb_hid_register_apdu_cb(nodong_apdu_inbound_cb cb)
{
	m_inbound_cb = cb;
}

int nodong_usb_hid_init(void)
{
	rx_reset();
	/* TODO: usb_enable(), bind HID class with our report descriptor,
	 *       register the OUT endpoint callback that funnels into
	 *       hid_on_report_out() below. */
	ND_LOG_INF("usb_hid_init (stub)");
	return 0;
}

int nodong_usb_hid_start(void)
{
	/* TODO: usb_enable(NULL); pull-up DP. */
	return 0;
}

void nodong_usb_hid_stop(void)
{
	/* TODO: usb_disable(); */
}

/*
 * Called by the HID class glue (TODO) for every 64-byte report received
 * on our OUT endpoint. Kept static so we can unit-test by exposing a
 * test-only wrapper later.
 */
static void hid_on_report_out(const uint8_t *report, size_t len)
{
	if (len < 5 || len != HID_REPORT_LEN) {
		ND_LOG_WRN("hid: malformed report len=%zu", len);
		return;
	}

	uint16_t ch  = ((uint16_t)report[0] << 8) | report[1];
	uint8_t  tag = report[2];
	uint16_t seq = ((uint16_t)report[3] << 8) | report[4];
	size_t   payload_off = 5;

	if (ch != NODONG_HID_CHANNEL_ID || tag != NODONG_HID_TAG_APDU) {
		ND_LOG_WRN("hid: wrong channel/tag");
		return;
	}

	if (seq == 0) {
		if (len < 7) { rx_reset(); return; }
		/*
		 * A first-fragment arriving mid-reassembly aborts the prior
		 * APDU and starts a fresh one. Wipe the old buffer first so
		 * no leftover bytes can be smuggled into the new payload.
		 */
		rx_reset();
		m_rx.total_len = ((uint16_t)report[5] << 8) | report[6];
		if (m_rx.total_len == 0 || m_rx.total_len > MAX_APDU_LEN) {
			ND_LOG_ERR("hid: rejecting apdu len=%u", m_rx.total_len);
			rx_reset();
			return;
		}
		m_rx.cursor   = 0;
		m_rx.next_seq = 1;
		m_rx.state    = RX_REASSEMBLE;
		payload_off   = 7;
	} else {
		if (m_rx.state != RX_REASSEMBLE || seq != m_rx.next_seq) {
			ND_LOG_WRN("hid: seq mismatch (got %u want %u)",
				   seq, m_rx.next_seq);
			rx_reset();
			return;
		}
		m_rx.next_seq++;
	}

	/*
	 * Bounds: len <= HID_REPORT_LEN (uint8 worth), payload_off <= 7,
	 * cursor <= total_len <= MAX_APDU_LEN. The MIN below clamps copy
	 * so cursor + copy <= total_len, and total_len fits in uint16_t —
	 * no wraparound is reachable on this path.
	 */
	size_t copy = MIN(len - payload_off, (size_t)(m_rx.total_len - m_rx.cursor));
	memcpy(&m_rx.buf[m_rx.cursor], &report[payload_off], copy);
	m_rx.cursor += copy;

	if (m_rx.cursor >= m_rx.total_len) {
		if (m_inbound_cb) {
			m_inbound_cb(m_rx.buf, m_rx.total_len);
		}
		rx_reset();
	}
}

int nodong_usb_hid_send(const uint8_t *apdu, size_t len)
{
	if (!apdu || len == 0 || len > MAX_APDU_LEN) {
		return -EINVAL;
	}

	uint8_t report[HID_REPORT_LEN];
	size_t  cursor = 0;
	uint16_t seq   = 0;

	while (cursor < len) {
		memset(report, 0, sizeof(report));
		report[0] = (uint8_t)(NODONG_HID_CHANNEL_ID >> 8);
		report[1] = (uint8_t)(NODONG_HID_CHANNEL_ID & 0xFF);
		report[2] = NODONG_HID_TAG_APDU;
		report[3] = (uint8_t)(seq >> 8);
		report[4] = (uint8_t)(seq & 0xFF);

		size_t hdr;
		if (seq == 0) {
			report[5] = (uint8_t)(len >> 8);
			report[6] = (uint8_t)(len & 0xFF);
			hdr = 7;
		} else {
			hdr = 5;
		}

		size_t take = MIN(HID_REPORT_LEN - hdr, len - cursor);
		memcpy(&report[hdr], &apdu[cursor], take);
		cursor += take;
		seq++;

		/* TODO: hid_int_ep_write() or usb_hid_send_report(). */
		(void)report;
	}
	return 0;
}

/* Hook called by hid_int_ep IN-complete (TODO) — placeholder. */
__attribute__((unused))
static void hid_on_report_in_complete(void) { }

/* Compile-time shim so the linker still has a reference to hid_on_report_out
 * until the real USB glue is wired up. Remove once usb_enable() is in init. */
__attribute__((unused))
static void *_keep_static_callbacks[] = {
	(void *)&hid_on_report_out,
	(void *)&hid_on_report_in_complete,
};
