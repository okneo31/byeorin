/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — APDU dispatch.
 *
 * APDUs arrive from the transport layer (USB-HID or BLE) already
 * de-framed. We use a Ledger-style INS table so the companion SDK
 * can speak a familiar protocol.
 *
 * Wire format (command):
 *   +----+-----+----+----+----+----------+
 *   | CLA| INS | P1 | P2 | Lc | data ... |
 *   +----+-----+----+----+----+----------+
 * Wire format (response):
 *   +-----------+-----+-----+
 *   | data ...  | SW1 | SW2 |
 *   +-----------+-----+-----+
 *
 * All commands use CLA=0xE0 (our vendor class). SW1/SW2 follow ISO 7816.
 */
#ifndef NODONG_APDU_H_
#define NODONG_APDU_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <zephyr/kernel.h>

#define NODONG_APDU_CLA          0xE0u

/* INS opcodes. Keep contiguous-ish so the dispatch table stays compact. */
#define NODONG_INS_GET_VERSION       0x00u
#define NODONG_INS_GET_PUBKEY        0x01u
#define NODONG_INS_SIGN_HASH         0x02u
#define NODONG_INS_GET_DEVICE_INFO   0x03u
#define NODONG_INS_PAIR_BEGIN        0x10u
#define NODONG_INS_PAIR_COMPLETE     0x11u
#define NODONG_INS_FW_UPGRADE_BEGIN  0xFEu
#define NODONG_INS_FW_UPGRADE_CHUNK  0xFDu
#define NODONG_INS_FW_UPGRADE_FINISH 0xFCu

/* Status words. */
#define NODONG_SW_OK                  0x9000u
#define NODONG_SW_USER_CANCELLED      0x6985u
#define NODONG_SW_INCORRECT_DATA      0x6A80u
#define NODONG_SW_INS_NOT_SUPPORTED   0x6D00u
#define NODONG_SW_CLA_NOT_SUPPORTED   0x6E00u
#define NODONG_SW_INTERNAL_ERROR      0x6F00u
#define NODONG_SW_UNAUTHORIZED        0x6982u
#define NODONG_SW_TIMEOUT             0x6401u

/* TLV tags used inside command/response payloads. */
#define NODONG_TLV_CURVE         0x01u  /* 1 byte: 0=secp256k1, 1=ed25519, 2=secp256r1 */
#define NODONG_TLV_BIP32_PATH    0x02u  /* N x uint32 big-endian */
#define NODONG_TLV_DIGEST        0x03u  /* 32 bytes typically */
#define NODONG_TLV_CHAIN_LABEL   0x04u  /* UTF-8 ASCII, e.g. "TTL", "ETH" */
#define NODONG_TLV_TO_ADDRESS    0x05u  /* UTF-8 / hex */
#define NODONG_TLV_AMOUNT_STR    0x06u  /* UTF-8 human-readable amount */
#define NODONG_TLV_PUBKEY        0x10u
#define NODONG_TLV_SIGNATURE     0x11u

#define NODONG_CURVE_SECP256K1   0x00u
#define NODONG_CURVE_ED25519     0x01u
#define NODONG_CURVE_SECP256R1   0x02u

/*
 * Origin of the APDU. Some commands (notably SIGN_HASH) are refused over
 * BLE by default — see CONFIG_NODONG_ALLOW_BLE_SIGNING.
 */
typedef enum {
	NODONG_TRANSPORT_USB_HID = 0,
	NODONG_TRANSPORT_BLE     = 1,
} nodong_transport_t;

/* Parsed command APDU. `data` points into the caller's buffer. */
struct nodong_apdu_cmd {
	uint8_t  cla;
	uint8_t  ins;
	uint8_t  p1;
	uint8_t  p2;
	uint16_t lc;
	const uint8_t *data;
	nodong_transport_t origin;
};

/* Response APDU under construction. */
struct nodong_apdu_resp {
	uint8_t *data;
	size_t   capacity;
	size_t   len;       /* bytes written so far (excluding SW) */
	uint16_t sw;        /* status word; SW1=hi, SW2=lo */
};

/* Handler signature. Return 0 on success (sw populated), <0 on internal err. */
typedef int (*nodong_apdu_handler_t)(const struct nodong_apdu_cmd *cmd,
				     struct nodong_apdu_resp *resp);

struct nodong_apdu_entry {
	uint8_t ins;
	bool    requires_user_confirm;
	bool    allow_over_ble;
	nodong_apdu_handler_t fn;
	const char *name;
};

/* Parse a raw command buffer. Returns 0 on OK, negative errno on malformed. */
int nodong_apdu_parse(const uint8_t *raw, size_t raw_len,
		      struct nodong_apdu_cmd *out);

/* Dispatch a parsed command. Always sets resp->sw, even on error paths. */
int nodong_apdu_dispatch(const struct nodong_apdu_cmd *cmd,
			 struct nodong_apdu_resp *resp);

/* Serialise a response into a flat buffer ready for the transport layer.
 * Writes resp->data[0..len] then SW1 SW2. Returns total bytes written, or
 * negative errno on overflow.                                            */
int nodong_apdu_serialize(const struct nodong_apdu_resp *resp,
			  uint8_t *out, size_t out_capacity);

/* Small TLV decode helper — used by handlers and the per-chain apps. */
int nodong_tlv_find(const uint8_t *buf, size_t len, uint8_t tag,
		    const uint8_t **out_value, size_t *out_value_len);

#endif /* NODONG_APDU_H_ */
