/*
 * SPDX-License-Identifier: Apache-2.0
 * SECURITY-CRITICAL: changes require security review.
 * 벼린 요세 — USB-HID transport (Ledger-style framing).
 *
 * Protocol summary (mirrors transport/usb_hid.h):
 *
 *   Each HID OUT/IN report is exactly HID_REPORT_LEN (CONFIG_BYEORIN_USB_HID_REPORT_LEN,
 *   default 64) bytes. Inside each report:
 *
 *     Byte 0..1 : channel ID, big-endian, fixed 0x0101
 *     Byte 2    : tag, fixed 0x05 (APDU)
 *     Byte 3..4 : sequence index, big-endian (0 == first fragment)
 *     If seq == 0:
 *       Byte 5..6 : total APDU length, big-endian
 *       Byte 7..  : payload
 *     Else:
 *       Byte 5..  : payload
 *
 *   Responses use the same framing in reverse.
 *
 * Zephyr USB-HID glue:
 *
 *   We register a single vendor-defined HID interface (HID_0) with one
 *   IN endpoint and one OUT endpoint, both carrying 64-byte reports.
 *   On RX (host → device) the class driver invokes set_report (legacy
 *   stack) or on_int_out_ready, depending on which path the build picks
 *   up — both paths funnel into hid_on_report_out() which feeds the
 *   reassembler above.
 *
 *   On TX (device → host) we use hid_int_ep_write() which copies into
 *   the class's IN-endpoint buffer and triggers the SIE.
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
#include <zephyr/device.h>
#include <zephyr/usb/usb_device.h>
#include <zephyr/usb/class/usb_hid.h>

LOG_MODULE_REGISTER(byeorin_usb, CONFIG_LOG_DEFAULT_LEVEL);

#define HID_REPORT_LEN  CONFIG_BYEORIN_USB_HID_REPORT_LEN
#define MAX_APDU_LEN    CONFIG_BYEORIN_MAX_APDU_LEN

/*
 * Compile-time sanity: the Ledger framing uses an 8-bit-aligned 64-byte
 * report. We accept anything in [32..1024] (Kconfig range) but the IN-endpoint
 * write path below assumes the report fits in a single bulk transfer. If a
 * board ever needs a smaller MTU we want a build break, not silent truncation.
 */
BUILD_ASSERT(HID_REPORT_LEN >= 32 && HID_REPORT_LEN <= 1024,
	     "HID report length out of supported range");
BUILD_ASSERT(MAX_APDU_LEN >= HID_REPORT_LEN,
	     "MAX_APDU_LEN must fit at least one HID report");

/*
 * Why we cap the report at 64 bytes even though USB HS interrupt endpoints
 * support up to 1024-byte packets: 64 is the Ledger-protocol convention and
 * what every companion SDK in the wild assumes. Widening this would force
 * SDK changes on every host platform we support. If we ever need to push
 * larger reports, bump CONFIG_BYEORIN_USB_HID_REPORT_LEN and pin the
 * companion SDK version simultaneously.
 */

/*
 * HID is interface 0 of the composite USB device. Today there is only HID,
 * but if a future build adds another USB class (MSC for a "files" mode, CDC
 * for a debug shell, etc.), the host driver enumerates by interface number
 * and the companion SDK keys off interface 0 == HID. Pin it here so a
 * reordering shows up at build time, not as a silent enumeration breakage
 * in the field.
 */
#define BYEORIN_HID_INTERFACE 0
#if defined(CONFIG_USB_CDC_ACM) || defined(CONFIG_USB_MASS_STORAGE)
/*
 * If another USB class lands in the build, the linker order determines the
 * interface number assignment. We cannot statically prove HID == 0 from the
 * legacy stack's macros, so leave a loud reminder for the embedded dev to
 * re-verify with `lsusb -v` after enabling the additional class.
 */
#warning "Additional USB class enabled — verify BYEORIN_HID_INTERFACE is still 0"
#endif

/*
 * VID/PID hygiene.
 *
 * CONFIG_USB_DEVICE_VID=0x2C97 is **Ledger SAS**'s registered USB-IF vendor
 * ID. We are using it as a placeholder so the companion SDK (forked from
 * Ledger's) doesn't need to be re-keyed during bench bring-up, but shipping
 * a product on someone else's VID is both legally questionable and a
 * support-burden landmine (USB-IF database collisions, host udev rules,
 * etc.). Before any external distribution we MUST either:
 *   (a) obtain our own VID from USB-IF (~$6k/year membership), or
 *   (b) license a sub-VID from a USB-IF member program, or
 *   (c) use a pid.codes / openmoko community VID for hobbyist builds.
 *
 * We deliberately use BUILD_ASSERT rather than #warning so a release build
 * cannot accidentally ship with the squatted VID; if you are doing bench
 * work, define BYEORIN_VID_SQUAT_ACK in the per-developer overlay file.
 */
#if !defined(BYEORIN_VID_SQUAT_ACK)
BUILD_ASSERT(CONFIG_USB_DEVICE_VID != 0x2C97,
	     "CONFIG_USB_DEVICE_VID=0x2C97 is Ledger's VID. "
	     "Allocate our own VID before release, or define "
	     "BYEORIN_VID_SQUAT_ACK in a per-developer overlay to silence "
	     "this for bench work only. See TODO in usb_hid.c.");
#endif

/* ----------------------- RX reassembly ---------------------------------- */

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
static byeorin_apdu_inbound_cb  m_inbound_cb;

/* USB HID device handle + ready flag for write path. */
static const struct device *m_hdev;
static atomic_t             m_in_ready = ATOMIC_INIT(1);
static bool                 m_started;

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

void byeorin_usb_hid_register_apdu_cb(byeorin_apdu_inbound_cb cb)
{
	m_inbound_cb = cb;
}

/* ----------------------- HID report descriptor -------------------------- */

/*
 * Vendor-defined HID interface, Ledger-compatible:
 *   Usage Page : 0xFFA0 (vendor)
 *   Usage      : 0x0001
 *   1 input report  : 64 * 8-bit values
 *   1 output report : 64 * 8-bit values
 *
 * No report ID byte (single in/out report).
 */
static const uint8_t hid_report_desc[] = {
	/*
	 * Usage Page (Vendor-Defined 0xFFA0). The Zephyr HID_USAGE_PAGE
	 * macro emits the 1-byte-data short form `0x05, p`, which can
	 * only carry an 8-bit page index. 0xFFA0 needs the 2-byte-data
	 * short form `0x06, lo, hi`, so we emit it raw.
	 */
	0x06, 0xA0, 0xFF,
	HID_USAGE(0x01),
	HID_COLLECTION(HID_COLLECTION_APPLICATION),
		HID_USAGE(0x01),
		HID_LOGICAL_MIN8(0x00),
		HID_LOGICAL_MAX16(0xFF, 0x00),
		HID_REPORT_SIZE(8),
		HID_REPORT_COUNT(HID_REPORT_LEN),
		/* Data, Variable, Absolute */
		HID_INPUT(0x02),

		HID_USAGE(0x01),
		HID_LOGICAL_MIN8(0x00),
		HID_LOGICAL_MAX16(0xFF, 0x00),
		HID_REPORT_SIZE(8),
		HID_REPORT_COUNT(HID_REPORT_LEN),
		/* Data, Variable, Absolute */
		HID_OUTPUT(0x02),
	HID_END_COLLECTION,
};

/* ----------------------- RX path: report → reassembler ------------------ */

/*
 * Called by the HID class for every report we receive on the OUT endpoint.
 * Kept static so we can unit-test by exposing a test-only wrapper later.
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

	if (ch != BYEORIN_HID_CHANNEL_ID || tag != BYEORIN_HID_TAG_APDU) {
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

/* ----------------------- Zephyr HID class callbacks --------------------- */

/*
 * SET_REPORT path (control transfers). Some hosts (Windows, some Chrome HID)
 * deliver OUT reports here even when an interrupt-OUT endpoint exists. We
 * handle both for compatibility.
 */
static int on_set_report(const struct device *dev,
			 struct usb_setup_packet *setup,
			 int32_t *len, uint8_t **data)
{
	(void)dev; (void)setup;

	if (!len || !data || !*data || *len <= 0) {
		return -EINVAL;
	}
	if ((size_t)*len != HID_REPORT_LEN) {
		ND_LOG_WRN("hid set_report unexpected len=%d", *len);
		return -EINVAL;
	}
	hid_on_report_out(*data, (size_t)*len);
	return 0;
}

/*
 * Interrupt-OUT endpoint ready path. Zephyr signals "the host wrote a
 * report" via this callback; the buffer is owned by the class driver and
 * is pulled with hid_int_ep_read(). Kept compatible across NCS 2.7 — if
 * the symbol name diverges on a particular Zephyr branch, see the
 * "API drift" note at the bottom of this file.
 */
static void on_int_out_ready(const struct device *dev)
{
	uint8_t buf[HID_REPORT_LEN];
	uint32_t got = 0;

#if defined(CONFIG_ENABLE_HID_INT_OUT_EP)
	int rc = hid_int_ep_read(dev, buf, sizeof(buf), &got);
	if (rc < 0) {
		ND_LOG_WRN("hid_int_ep_read rc=%d", rc);
		return;
	}
	if (got != HID_REPORT_LEN) {
		ND_LOG_WRN("hid: short int-out read got=%u", got);
		return;
	}
	hid_on_report_out(buf, got);
#else
	/* No interrupt-OUT endpoint configured; SET_REPORT path is used. */
	(void)dev; (void)buf; (void)got;
#endif
}

/* IN-endpoint completion: mark the endpoint ready for the next write. */
static void on_int_in_ready(const struct device *dev)
{
	(void)dev;
	atomic_set(&m_in_ready, 1);
}

static const struct hid_ops m_ops = {
	.get_report   = NULL,
	.set_report   = on_set_report,
	.int_in_ready = on_int_in_ready,
#if defined(CONFIG_ENABLE_HID_INT_OUT_EP)
	.int_out_ready = on_int_out_ready,
#endif
	.on_idle      = NULL,
	.protocol_change = NULL,
};

/* ----------------------- Lifecycle -------------------------------------- */

int byeorin_usb_hid_init(void)
{
	rx_reset();

	/*
	 * In Zephyr v3.7 the legacy USB device stack still exposes HID
	 * instances by name (HID_0, HID_1, ...). The new device_next stack
	 * uses DEVICE_DT_GET(); for now we stick to the legacy API because
	 * CONFIG_USB_DEVICE_STACK is enabled in prj.conf.
	 */
	m_hdev = device_get_binding("HID_0");
	if (!m_hdev) {
		ND_LOG_ERR("usb_hid: no HID_0 device binding");
		return -ENODEV;
	}

	usb_hid_register_device(m_hdev, hid_report_desc,
				sizeof(hid_report_desc), &m_ops);

	int rc = usb_hid_init(m_hdev);
	if (rc) {
		ND_LOG_ERR("usb_hid_init rc=%d", rc);
		return rc;
	}

	atomic_set(&m_in_ready, 1);
	m_started = false;
	ND_LOG_INF("usb_hid: HID class registered, %u-byte reports",
		   (unsigned)HID_REPORT_LEN);
	return 0;
}

int byeorin_usb_hid_start(void)
{
	if (!m_hdev) {
		return -EINVAL;
	}
	if (m_started) {
		return 0;
	}

	/*
	 * usb_enable() drives the SIE pull-up. NULL passes the default
	 * status callback. We could pass a custom one to react to
	 * SUSPEND/RESUME but for a cold wallet the only signal we need
	 * is "host wrote a report" (handled via hid_ops).
	 */
	int rc = usb_enable(NULL);
	if (rc == -EALREADY) {
		/* Idempotent: someone else (e.g. USB DFU) already enabled. */
		rc = 0;
	}
	if (rc) {
		ND_LOG_ERR("usb_enable rc=%d", rc);
		return rc;
	}

	m_started = true;
	ND_LOG_INF("usb_hid: started");
	return 0;
}

void byeorin_usb_hid_stop(void)
{
	if (!m_started) {
		return;
	}
	int rc = usb_disable();
	if (rc) {
		ND_LOG_WRN("usb_disable rc=%d", rc);
	}
	m_started = false;
	rx_reset();
}

/* ----------------------- TX: outbound APDU → reports -------------------- */

/*
 * Wait briefly for the IN endpoint to become ready again after the previous
 * write. The host should drain reports at the configured poll interval
 * (1 ms by default, see CONFIG_USB_HID_POLL_INTERVAL_MS). 50 ms is a
 * generous slack; if it expires we treat the link as stalled.
 */
#define HID_IN_READY_TIMEOUT_MS  50

static int wait_in_ready(void)
{
	int waited_ms = 0;
	while (!atomic_cas(&m_in_ready, 1, 0)) {
		if (waited_ms >= HID_IN_READY_TIMEOUT_MS) {
			return -ETIMEDOUT;
		}
		k_sleep(K_MSEC(1));
		waited_ms++;
	}
	return 0;
}

int byeorin_usb_hid_send(const uint8_t *apdu, size_t len)
{
	if (!apdu || len == 0 || len > MAX_APDU_LEN) {
		return -EINVAL;
	}
	if (!m_hdev || !m_started) {
		return -ENOTCONN;
	}

	uint8_t  report[HID_REPORT_LEN];
	size_t   cursor = 0;
	uint16_t seq    = 0;

	while (cursor < len) {
		memset(report, 0, sizeof(report));
		report[0] = (uint8_t)(BYEORIN_HID_CHANNEL_ID >> 8);
		report[1] = (uint8_t)(BYEORIN_HID_CHANNEL_ID & 0xFF);
		report[2] = BYEORIN_HID_TAG_APDU;
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

		int rc = wait_in_ready();
		if (rc) {
			ND_LOG_ERR("usb_hid_send: IN endpoint stalled");
			return rc;
		}

		uint32_t wrote = 0;
		rc = hid_int_ep_write(m_hdev, report, sizeof(report), &wrote);
		if (rc) {
			ND_LOG_ERR("hid_int_ep_write rc=%d", rc);
			/* Restore the ready bit so the next attempt is not
			 * permanently stuck waiting on a write we never made. */
			atomic_set(&m_in_ready, 1);
			return rc;
		}
		if (wrote != sizeof(report)) {
			ND_LOG_WRN("hid: short write %u/%u",
				   wrote, (unsigned)sizeof(report));
		}
	}

	/* Wipe stack-local frame: it carried APDU response bytes which may
	 * include signatures or pubkey material. Defence-in-depth only —
	 * the actual response data is the caller's, but the report copy
	 * here is the last on-stack residue. */
	memset(report, 0, sizeof(report));
	return 0;
}

/*
 * --- API drift notes for the embedded dev (DOUBLE-CHECK on real toolchain):
 *
 *   1) The exact name of `hid_int_ep_read` may be `hid_int_ep_read` (NCS 2.7
 *      mainline) or surfaced via the new `usbd_hid_*` API on the
 *      device_next stack. We target the legacy API because prj.conf has
 *      CONFIG_USB_DEVICE_STACK=y, not CONFIG_USB_DEVICE_NEXT.
 *
 *   2) `struct hid_ops` member names vary slightly between Zephyr LTS
 *      revisions. The fields used here (set_report, int_in_ready,
 *      int_out_ready) are the v3.7 baseline. If a member is renamed in
 *      a backport, add the missing initialiser; do NOT compile out
 *      `set_report` — it is the cross-host compatibility path.
 *
 *   3) device_get_binding("HID_0") still works in v3.7 but is deprecated;
 *      the recommended path is DEVICE_DT_GET_ONE(zephyr_hid_device) on
 *      the device_next stack. Migrate when we move off the legacy stack.
 */
