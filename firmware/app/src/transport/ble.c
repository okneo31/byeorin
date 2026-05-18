/*
 * SPDX-License-Identifier: Apache-2.0
 * SECURITY-CRITICAL: changes require security review.
 * 벼린 요세 — BLE GATT transport.
 *
 * Protocol summary (mirrors transport/ble.h):
 *
 *   Custom primary service with two characteristics:
 *     - WRITE_APDU   : write-without-response, encrypted
 *                      Companion → device. Each write is exactly one
 *                      framed fragment (NO long-write reassembly across
 *                      ATT prepare-writes — those are refused).
 *     - NOTIFY_RESP  : notify, no fixed permissions on the value attr
 *                      (the CCC descriptor carries the encrypted-write
 *                      permission, which is what gates "subscribe").
 *                      Device → companion. We fragment APDU responses
 *                      across (MTU-3) bytes per notification.
 *
 *   Same Ledger-style framing as USB-HID, but each "report" is
 *   (negotiated MTU - 3) bytes instead of a fixed 64.
 *
 * Security policy:
 *   - CONFIG_BT_SMP=y (prj.conf) — pairing must complete before any
 *     APDU write can be accepted; characteristic uses
 *     BT_GATT_PERM_WRITE_ENCRYPT.
 *   - CCC descriptor also requires encryption so an unpaired peer
 *     cannot even subscribe to notifications.
 *   - apdu.c gates SIGN_HASH off the BLE transport unless the build
 *     opts in via CONFIG_BYEORIN_ALLOW_BLE_SIGNING. We do NOT need to
 *     re-check here; the dispatch layer is authoritative.
 *   - Authentication failures (pairing rejected by the user) are
 *     LOG_ERR'd so a noisy attacker shows up in field-logs.
 */
#include "transport/ble.h"
#include "log.h"

#include <errno.h>
#include <stdbool.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/att.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#if defined(CONFIG_BT_SETTINGS)
#include <zephyr/settings/settings.h>
#endif

LOG_MODULE_REGISTER(byeorin_ble, CONFIG_LOG_DEFAULT_LEVEL);

/*
 * Service UUID block. These are PLACEHOLDERS — a real allocation must
 * be reserved before we ship, either via the Bluetooth SIG vendor block
 * or a UUIDv4 baked into the production identity. Until then the
 * companion app discovers us by the 16-byte service UUID below.
 *
 *   Service:    61b9aa00-ddc0-4caa-9a31-6e776f6e646f
 *   WRITE_APDU: 61b9aa01-ddc0-4caa-9a31-6e776f6e646f
 *   NOTIFY_RSP: 61b9aa02-ddc0-4caa-9a31-6e776f6e646f
 *
 *   The last six bytes (0x6e776f6e646f) spell "nwondo" — a deliberate
 *   marker so we recognise our own peers in a sniffer trace.
 */
#define BT_UUID_WW_SVC_VAL  \
	BT_UUID_128_ENCODE(0x61b9aa00, 0xddc0, 0x4caa, 0x9a31, 0x6e776f6e646f)
#define BT_UUID_WW_WRITE_VAL \
	BT_UUID_128_ENCODE(0x61b9aa01, 0xddc0, 0x4caa, 0x9a31, 0x6e776f6e646f)
#define BT_UUID_WW_NOTIFY_VAL \
	BT_UUID_128_ENCODE(0x61b9aa02, 0xddc0, 0x4caa, 0x9a31, 0x6e776f6e646f)

static struct bt_uuid_128 ww_svc_uuid    = BT_UUID_INIT_128(BT_UUID_WW_SVC_VAL);
static struct bt_uuid_128 ww_write_uuid  = BT_UUID_INIT_128(BT_UUID_WW_WRITE_VAL);
static struct bt_uuid_128 ww_notify_uuid = BT_UUID_INIT_128(BT_UUID_WW_NOTIFY_VAL);

static byeorin_ble_apdu_cb m_cb;
static bool               m_notify_enabled;
static struct bt_conn    *m_conn;       /* current peer (peripheral, max 1) */
static bool               m_advertising;
static bool               m_bt_enabled;

/*
 * Conservative default for the per-notification payload before MTU
 * exchange completes. After the central negotiates a larger MTU the
 * connection callback updates this value.
 *
 *   ATT MTU 23 (BT 4.0 minimum) → 20 bytes per notification.
 *   ATT MTU 247 (typical nRF)   → 244 bytes per notification.
 */
#define DEFAULT_NOTIFY_PAYLOAD  20u
static atomic_t m_notify_payload = ATOMIC_INIT(DEFAULT_NOTIFY_PAYLOAD);

/* ----------------------- GATT write (RX) -------------------------------- */

static ssize_t on_write_apdu(struct bt_conn *conn,
			     const struct bt_gatt_attr *attr,
			     const void *buf, uint16_t len,
			     uint16_t offset, uint8_t flags)
{
	(void)conn; (void)attr;

	/*
	 * GATT writes carry an `offset` for long-write / prepare-write
	 * sequences. We do NOT support reassembly across multiple GATT
	 * writes — each write must be a complete framed fragment. Reject
	 * non-zero offsets so a peer cannot smuggle bytes past our length
	 * check by issuing prepare-writes.
	 */
	if (offset != 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
	}
	/*
	 * Same reasoning for the BT_GATT_WRITE_FLAG_PREPARE flag: refuse
	 * the prepared-write phase entirely. The companion is required to
	 * use write-without-response.
	 */
	if (flags & BT_GATT_WRITE_FLAG_PREPARE) {
		return BT_GATT_ERR(BT_ATT_ERR_WRITE_REQ_REJECTED);
	}
	if (!buf || len == 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}
	/*
	 * MUST validate length BEFORE handing the pointer to the next
	 * layer. CONFIG_BYEORIN_MAX_APDU_LEN is the hard ceiling shared
	 * with the USB-HID transport and the main-thread queue buffer.
	 */
	if (len > (uint16_t)CONFIG_BYEORIN_MAX_APDU_LEN) {
		ND_LOG_WRN("ble: oversize write len=%u, rejecting", len);
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}
	if (m_cb) {
		/* TODO: feed into the same reassembler used by USB-HID
		 *       (Ledger-style framing, but MTU-sized). For now we
		 *       hand the buffer straight to the dispatch layer —
		 *       which expects a fully-assembled APDU; the companion
		 *       SDK MUST chunk at the framing layer above us. */
		m_cb((const uint8_t *)buf, len);
	}
	return len;
}

/* ----------------------- CCC subscribe ---------------------------------- */

static void on_notify_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	(void)attr;
	m_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
	ND_LOG_INF("ble notifications %s", m_notify_enabled ? "on" : "off");
}

/* ----------------------- GATT service definition ------------------------ */

/*
 * The CHARACTERISTIC attribute (the "declaration" attr) is at offset 0
 * inside its triple; the *value* attribute, which is what bt_gatt_notify
 * actually targets, is at offset +1. The macro BT_GATT_SERVICE_DEFINE
 * builds the attr table in order, so:
 *
 *   [0] BT_GATT_PRIMARY_SERVICE
 *   [1] BT_GATT_CHARACTERISTIC declaration   (WRITE_APDU)
 *   [2] BT_GATT_CHARACTERISTIC value attr    (WRITE_APDU value)
 *   [3] BT_GATT_CHARACTERISTIC declaration   (NOTIFY_RSP)
 *   [4] BT_GATT_CHARACTERISTIC value attr    (NOTIFY_RSP value)  ← notify target
 *   [5] BT_GATT_CCC                          (CCCD)
 *
 * `&ww_svc.attrs[NOTIFY_VALUE_ATTR_IDX]` is what bt_gatt_notify needs.
 */
#define NOTIFY_VALUE_ATTR_IDX  4

BT_GATT_SERVICE_DEFINE(ww_svc,
	BT_GATT_PRIMARY_SERVICE(&ww_svc_uuid),
	BT_GATT_CHARACTERISTIC(&ww_write_uuid.uuid,
		BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
		BT_GATT_PERM_WRITE_ENCRYPT,
		NULL, on_write_apdu, NULL),
	BT_GATT_CHARACTERISTIC(&ww_notify_uuid.uuid,
		BT_GATT_CHRC_NOTIFY,
		BT_GATT_PERM_NONE,
		NULL, NULL, NULL),
	BT_GATT_CCC(on_notify_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE_ENCRYPT),
);

/* ----------------------- Advertising data ------------------------------- */

static const struct bt_data k_adv[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	/*
	 * Use the Kconfig'd ASCII name. The pretty Korean name
	 * "노동자의지갑" is 9 UTF-8 code-points × 3 bytes = 27 bytes which
	 * blows the BLE adv length budget once flags + UUID are added, so
	 * we ship "ByeorinYose" by default. The full name can still be
	 * surfaced in a GAP Device Name characteristic if desired.
	 */
	BT_DATA(BT_DATA_NAME_COMPLETE,
		CONFIG_BYEORIN_BLE_NAME, sizeof(CONFIG_BYEORIN_BLE_NAME) - 1),
};

static const struct bt_data k_scan_rsp[] = {
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_WW_SVC_VAL),
};

void byeorin_ble_register_apdu_cb(byeorin_ble_apdu_cb cb) { m_cb = cb; }

/* ----------------------- Connection callbacks --------------------------- */

static void on_connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		ND_LOG_ERR("ble: connection failed, err=0x%02x", err);
		return;
	}
	/* Only one central at a time (CONFIG_BT_MAX_CONN=1). */
	if (m_conn) {
		ND_LOG_WRN("ble: spurious second connection — dropping new one");
		bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		return;
	}
	m_conn = bt_conn_ref(conn);
	/*
	 * Force the link to be encrypted before we accept any GATT writes.
	 * The characteristic permission would refuse the write anyway, but
	 * raising the security here gives us a deterministic point to
	 * react to authentication failure.
	 *
	 * -EBUSY means a security procedure is already in flight (e.g. the
	 * central kicked one off first) — that's benign; the security_changed
	 * callback will still fire when it completes.
	 *
	 * Any other negative rc means we could not even *initiate* the
	 * upgrade — at that point the link is plaintext from our perspective
	 * and the GATT permissions would block reads/writes, but holding a
	 * plaintext link around is pointless attack surface (and may also
	 * keep us out of advertising). Drop it.
	 */
	int rc = bt_conn_set_security(conn, BT_SECURITY_L2);
	if (rc && rc != -EBUSY) {
		ND_LOG_ERR("ble: bt_conn_set_security rc=%d — disconnecting", rc);
		(void)bt_conn_disconnect(conn,
				BT_HCI_ERR_AUTH_FAIL);
		return;
	}
	ND_LOG_INF("ble: connected");
}

static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
	ND_LOG_INF("ble: disconnected reason=0x%02x", reason);
	if (m_conn) {
		bt_conn_unref(m_conn);
		m_conn = NULL;
	}
	m_notify_enabled = false;
	atomic_set(&m_notify_payload, DEFAULT_NOTIFY_PAYLOAD);
	/*
	 * Restart advertising. If start_advertising fails it'll log; we
	 * deliberately do not retry in a tight loop here — the next call
	 * site (UI button or main-loop tick) can re-arm.
	 */
	(void)byeorin_ble_start_advertising();
}

static void on_security_changed(struct bt_conn *conn,
				bt_security_t level,
				enum bt_security_err err)
{
	if (err) {
		/*
		 * Pairing failed or the central refused the upgrade. Per
		 * security policy we MUST NOT allow GATT activity over a
		 * plaintext link — drop the conn and let advertising restart.
		 * Even though BT_GATT_PERM_WRITE_ENCRYPT would refuse the
		 * write, holding the link reserves a connection slot and
		 * burns radio time.
		 */
		ND_LOG_ERR("ble: security level change failed, err=%d "
			   "— disconnecting", err);
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
		return;
	}
	if (level < BT_SECURITY_L2) {
		ND_LOG_ERR("ble: security level %u below L2 — disconnecting",
			   (unsigned)level);
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
		return;
	}
	ND_LOG_INF("ble: security level = %u", (unsigned)level);
}

static void on_le_param_updated(struct bt_conn *conn,
				uint16_t interval, uint16_t latency,
				uint16_t timeout)
{
	(void)conn;
	ND_LOG_INF("ble: conn params interval=%u latency=%u to=%u",
		   interval, latency, timeout);
}

BT_CONN_CB_DEFINE(byeorin_conn_cb) = {
	.connected        = on_connected,
	.disconnected     = on_disconnected,
	.security_changed = on_security_changed,
	.le_param_updated = on_le_param_updated,
};

/* ----------------------- MTU callback ----------------------------------- */

static void on_mtu_updated(struct bt_conn *conn, uint16_t tx, uint16_t rx)
{
	(void)conn;
	/*
	 * tx/rx are ATT MTUs. Notification payload = min(tx, rx) - 3
	 * (1 byte opcode + 2 byte handle). Clamp to >= DEFAULT to keep
	 * the value sane on weird stacks.
	 */
	uint16_t mtu = (tx < rx) ? tx : rx;
	uint16_t payload = (mtu > 3) ? (mtu - 3) : DEFAULT_NOTIFY_PAYLOAD;
	if (payload < DEFAULT_NOTIFY_PAYLOAD) {
		payload = DEFAULT_NOTIFY_PAYLOAD;
	}
	atomic_set(&m_notify_payload, payload);
	ND_LOG_INF("ble: ATT MTU %u, notify payload %u", mtu, payload);
}

static struct bt_gatt_cb m_gatt_cb = {
	.att_mtu_updated = on_mtu_updated,
};

/* ----------------------- Authentication callbacks ----------------------- */

#if defined(CONFIG_BT_SMP)
static void auth_cancel(struct bt_conn *conn)
{
	(void)conn;
	ND_LOG_WRN("ble: pairing cancelled by peer");
}

static void auth_pairing_failed(struct bt_conn *conn, enum bt_security_err err)
{
	(void)conn;
	/* LOG_ERR on bond auth fail per security policy. */
	ND_LOG_ERR("ble: pairing FAILED, err=%d", err);
}

static void auth_pairing_complete(struct bt_conn *conn, bool bonded)
{
	(void)conn;
	ND_LOG_INF("ble: pairing complete, bonded=%d", bonded);
}

static const struct bt_conn_auth_cb m_auth_cb = {
	.cancel = auth_cancel,
	/*
	 * passkey_display/passkey_entry intentionally left NULL — we use
	 * CONFIG_BT_FIXED_PASSKEY (set in prj.conf) which causes the stack
	 * to show a fixed passkey set with bt_passkey_set() at init.
	 *
	 * TODO(WAVE-7, embedded dev): default behaviour today is Just Works
	 * pairing because bt_passkey_set() has NOT been called yet — that
	 * is unauthenticated and vulnerable to a MITM during the pairing
	 * window. Before shipping:
	 *   1) provision a per-device 6-digit passkey into keystore-meta
	 *      at manufacture time,
	 *   2) call bt_passkey_set() from byeorin_ble_init() before
	 *      bt_enable() (or immediately after, per Zephyr docs),
	 *   3) wire a passkey_display callback that paints the passkey on
	 *      the e-ink during the pairing exchange so the user can
	 *      compare it against the value shown by the companion app.
	 * Until (1)–(3) ship, BLE pairing MUST be considered untrusted and
	 * SIGN_HASH over BLE MUST stay off (see CONFIG_BYEORIN_ALLOW_BLE_SIGNING).
	 */
};

static const struct bt_conn_auth_info_cb m_auth_info_cb = {
	.pairing_failed   = auth_pairing_failed,
	.pairing_complete = auth_pairing_complete,
};
#endif /* CONFIG_BT_SMP */

/* ----------------------- Lifecycle -------------------------------------- */

int byeorin_ble_init(void)
{
	int rc;

	if (m_bt_enabled) {
		return 0;
	}

	rc = bt_enable(NULL);
	if (rc) {
		ND_LOG_ERR("bt_enable rc=%d", rc);
		return rc;
	}

	bt_gatt_cb_register(&m_gatt_cb);

#if defined(CONFIG_BT_SMP)
	rc = bt_conn_auth_cb_register(&m_auth_cb);
	if (rc) {
		ND_LOG_ERR("bt_conn_auth_cb_register rc=%d", rc);
		return rc;
	}
	rc = bt_conn_auth_info_cb_register(&m_auth_info_cb);
	if (rc) {
		ND_LOG_ERR("bt_conn_auth_info_cb_register rc=%d", rc);
		return rc;
	}
#endif

#if defined(CONFIG_BT_SETTINGS)
	/*
	 * Load persisted bonds (BT_SETTINGS=y in prj.conf). settings_load()
	 * is normally called by main, but the BLE init is a natural place
	 * for it — main.c does not call it explicitly. If main.c starts
	 * doing so later, this becomes a no-op (idempotent in Zephyr).
	 *
	 * TODO(embedded dev): once main.c grows a settings layer for
	 * non-BT keys (UI prefs, etc.) move this call into main.
	 */
	rc = settings_load();
	if (rc) {
		ND_LOG_WRN("settings_load rc=%d (continuing)", rc);
	}
#endif

	m_bt_enabled = true;
	ND_LOG_INF("ble_init: stack up");
	return 0;
}

/*
 * Shutdown semantics on MCU reset / firmware upgrade.
 *
 * We deliberately do NOT call bt_disable() on the firmware-upgrade or
 * reboot path. Rationale:
 *   - sys_reboot() (Zephyr's controlled reset) drops the BLE controller
 *     hardware into reset along with the CPU, which the central observes
 *     as a supervision-timeout link loss — the same as a battery pull.
 *     The peer-side reconnect logic must already cope with this.
 *   - bt_disable() on Zephyr v3.7 is the explicit "tear down stack" path
 *     and is intended for the rare case where a wallet stays running
 *     while a sub-system reboots. It is NOT required (and not safe to
 *     call from a reboot ISR; it sleeps).
 *
 * If a future code path stays running across a partial reset (e.g. soft
 * MCUboot swap that does NOT reboot), THAT path should bt_disable()
 * cleanly before swapping, then bt_enable() again afterwards.
 */

int byeorin_ble_start_advertising(void)
{
	if (!m_bt_enabled) {
		return -EINVAL;
	}
	if (m_advertising) {
		return 0;
	}

	/*
	 * Advertising interval tuning.
	 *
	 * Zephyr's `BT_LE_ADV_CONN_NAME` macro defaults to BT_GAP_ADV_FAST_INT_MIN_2
	 * / _MAX_2 (~100–150 ms) which is fine for a "user just pressed the
	 * pair button" window but drains battery if we keep running it
	 * forever waiting for a central. A future refinement is to drop to
	 * BT_GAP_ADV_SLOW_INT_MIN/MAX (~1 s) after ~5 s of unanswered
	 * advertising; for now we pin the fast interval explicitly so the
	 * value cannot silently change if the Zephyr default shifts.
	 *
	 * Flags:
	 *   BT_LE_ADV_OPT_CONNECTABLE — central may connect to us
	 *   BT_LE_ADV_OPT_USE_NAME    — advertise CONFIG_BT_DEVICE_NAME
	 *                               (kept for parity with the macro
	 *                               version we replaced; also redundant
	 *                               with the BT_DATA_NAME_COMPLETE entry
	 *                               in k_adv, but explicit is fine)
	 *
	 * TODO(power): start a k_work_delayable on no-peer that re-arms
	 * advertising with BT_GAP_ADV_SLOW_INT_MIN / _MAX after 5 s.
	 */
	static const struct bt_le_adv_param k_adv_param = BT_LE_ADV_PARAM_INIT(
		BT_LE_ADV_OPT_CONNECTABLE | BT_LE_ADV_OPT_USE_NAME,
		BT_GAP_ADV_FAST_INT_MIN_2,
		BT_GAP_ADV_FAST_INT_MAX_2,
		NULL);

	int rc = bt_le_adv_start(&k_adv_param,
				 k_adv, ARRAY_SIZE(k_adv),
				 k_scan_rsp, ARRAY_SIZE(k_scan_rsp));
	if (rc == -EALREADY) {
		m_advertising = true;
		return 0;
	}
	if (rc) {
		ND_LOG_ERR("bt_le_adv_start rc=%d", rc);
		return rc;
	}
	m_advertising = true;
	ND_LOG_INF("ble: advertising as '%s'", CONFIG_BYEORIN_BLE_NAME);
	return 0;
}

void byeorin_ble_stop_advertising(void)
{
	if (!m_advertising) {
		return;
	}
	int rc = bt_le_adv_stop();
	if (rc && rc != -EALREADY) {
		ND_LOG_WRN("bt_le_adv_stop rc=%d", rc);
	}
	m_advertising = false;
}

/* ----------------------- TX: response → notifications ------------------- */

int byeorin_ble_send(const uint8_t *apdu, size_t len)
{
	if (!apdu || len == 0) {
		return -EINVAL;
	}
	if (len > (size_t)CONFIG_BYEORIN_MAX_APDU_LEN) {
		return -EINVAL;
	}
	if (!m_conn || !m_notify_enabled) {
		return -ENOTCONN;
	}

	const struct bt_gatt_attr *notify_attr =
		&ww_svc.attrs[NOTIFY_VALUE_ATTR_IDX];

	/*
	 * Fragment the APDU + framing into payload-sized chunks. We use
	 * the same Ledger-style framing as USB-HID so the companion can
	 * reuse its de-framer; only the chunk size differs (MTU - 3
	 * instead of 64).
	 */
	uint16_t payload = (uint16_t)atomic_get(&m_notify_payload);
	if (payload < 8u) {
		/* Need at least seq (2) + total_len (2) + a few payload
		 * bytes for the first frame to make progress. */
		return -EMSGSIZE;
	}

	uint8_t  frame[CONFIG_BYEORIN_MAX_APDU_LEN + 7];
	size_t   cursor = 0;
	uint16_t seq    = 0;

	while (cursor < len) {
		size_t hdr;
		frame[0] = (uint8_t)0x01;            /* channel hi (mirrors HID) */
		frame[1] = (uint8_t)0x01;            /* channel lo */
		frame[2] = (uint8_t)0x05;            /* tag = APDU */
		frame[3] = (uint8_t)(seq >> 8);
		frame[4] = (uint8_t)(seq & 0xFF);

		if (seq == 0) {
			frame[5] = (uint8_t)(len >> 8);
			frame[6] = (uint8_t)(len & 0xFF);
			hdr = 7;
		} else {
			hdr = 5;
		}

		size_t take = (size_t)payload - hdr;
		if (take > len - cursor) {
			take = len - cursor;
		}
		memcpy(&frame[hdr], &apdu[cursor], take);
		cursor += take;
		seq++;

		int rc = bt_gatt_notify(m_conn, notify_attr,
					frame, hdr + take);
		if (rc) {
			ND_LOG_ERR("bt_gatt_notify rc=%d", rc);
			memset(frame, 0, sizeof(frame));
			return rc;
		}
	}

	/* Wipe local copy of the response (may contain signature material). */
	memset(frame, 0, sizeof(frame));
	return 0;
}

/*
 * --- API drift notes for the embedded dev (DOUBLE-CHECK on real toolchain):
 *
 *   1) We previously used the convenience macro `BT_LE_ADV_CONN_NAME`; we
 *      now pass an explicit `bt_le_adv_param` so the advertising interval
 *      is pinned to BT_GAP_ADV_FAST_INT_MIN_2 / _MAX_2 rather than
 *      whatever the macro's default happens to be on a given Zephyr
 *      revision. If `BT_LE_ADV_OPT_USE_NAME` is renamed (some NCS forks
 *      strip the option in favour of relying on BT_DATA_NAME_COMPLETE in
 *      the adv-data array), drop it from the flags — k_adv already
 *      carries the complete-name AD type.
 *
 *   2) `BT_GATT_WRITE_FLAG_PREPARE` is the canonical name in v3.7.
 *      Older Zephyr called it BT_GATT_WRITE_FLAG_CMD; this is the
 *      opposite flag (no-response), so do not "fix" the rename by
 *      switching macro — verify the flag direction in zephyr/bluetooth/gatt.h.
 *
 *   3) `bt_conn_auth_info_cb_register` was added in v3.x; pre-v3 only
 *      had bt_conn_auth_cb_register. NCS 2.7 has both — keep the split
 *      as written.
 *
 *   4) The NOTIFY_VALUE_ATTR_IDX (= 4) is hard-coded. If the service
 *      table above is ever reordered (new characteristic added before
 *      NOTIFY_RSP), this index MUST be recomputed or the device will
 *      cheerfully notify on the wrong attribute. A future cleanup is
 *      to discover the attr at boot with bt_gatt_find_by_uuid() and
 *      cache the pointer.
 */
