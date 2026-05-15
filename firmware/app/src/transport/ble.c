/*
 * SPDX-License-Identifier: Apache-2.0
 * SECURITY-CRITICAL: changes require security review.
 * 노동자의 지갑 Cold — BLE GATT skeleton.
 */
#include "transport/ble.h"
#include "log.h"

#include <errno.h>
#include <stdbool.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/att.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>

LOG_MODULE_REGISTER(nodong_ble, CONFIG_LOG_DEFAULT_LEVEL);

/*
 * Service UUID:        e4f0…-나-너-우-리 (placeholder; reserve real one
 *                      via the Bluetooth SIG vendor allocation later).
 *
 *   Service:    61b9aa00-ddc0-4caa-9a31-6e776f6e646f
 *   WRITE_APDU: 61b9aa01-ddc0-4caa-9a31-6e776f6e646f
 *   NOTIFY_RSP: 61b9aa02-ddc0-4caa-9a31-6e776f6e646f
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

static nodong_ble_apdu_cb m_cb;
static bool               m_notify_enabled;

static ssize_t on_write_apdu(struct bt_conn *conn,
			     const struct bt_gatt_attr *attr,
			     const void *buf, uint16_t len,
			     uint16_t offset, uint8_t flags)
{
	(void)conn; (void)attr; (void)flags;

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
	if (!buf || len == 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}
	/*
	 * MUST validate length BEFORE handing the pointer to the next
	 * layer. CONFIG_NODONG_MAX_APDU_LEN is the hard ceiling shared
	 * with the USB-HID transport and the main-thread queue buffer.
	 */
	if (len > (uint16_t)CONFIG_NODONG_MAX_APDU_LEN) {
		ND_LOG_WRN("ble: oversize write len=%u, rejecting", len);
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}
	if (m_cb) {
		/* TODO: feed into the same reassembler used by USB-HID
		 *       (Ledger-style framing, but MTU-sized). */
		m_cb((const uint8_t *)buf, len);
	}
	return len;
}

static void on_notify_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
	(void)attr;
	m_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
	ND_LOG_INF("ble notifications %s", m_notify_enabled ? "on" : "off");
}

/* GATT service definition. */
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

static const struct bt_data k_adv[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA(BT_DATA_NAME_COMPLETE,
		CONFIG_NODONG_BLE_NAME, sizeof(CONFIG_NODONG_BLE_NAME) - 1),
};

static const struct bt_data k_scan_rsp[] = {
	BT_DATA(BT_DATA_UUID128_ALL, BT_UUID_WW_SVC_VAL, 16),
};

void nodong_ble_register_apdu_cb(nodong_ble_apdu_cb cb) { m_cb = cb; }

int nodong_ble_init(void)
{
	/* TODO: bt_enable(NULL); register conn callbacks; load BT settings. */
	ND_LOG_INF("ble_init (stub)");
	return 0;
}

int nodong_ble_start_advertising(void)
{
	/* TODO: bt_le_adv_start(BT_LE_ADV_CONN_NAME, k_adv, ARRAY_SIZE(k_adv),
	 *                       k_scan_rsp, ARRAY_SIZE(k_scan_rsp)); */
	(void)k_adv; (void)k_scan_rsp;
	return 0;
}

void nodong_ble_stop_advertising(void)
{
	/* TODO: bt_le_adv_stop(); */
}

int nodong_ble_send(const uint8_t *apdu, size_t len)
{
	if (!apdu || len == 0) { return -EINVAL; }
	if (!m_notify_enabled) { return -ENOTCONN; }
	/* TODO: fragment + bt_gatt_notify on the NOTIFY characteristic. */
	return -ENOSYS;
}
