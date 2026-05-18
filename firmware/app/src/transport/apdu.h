/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — APDU dispatch.
 *
 * APDUs arrive from the transport layer (USB-HID or BLE) already
 * de-framed. We use a Ledger-style INS table so the companion SDK
 * can speak a familiar protocol.
 *
 * Wire format (command, ISO/IEC 7816-4):
 *   Short form (Lc in 0x01..0xFF):
 *     +----+-----+----+----+------+----------+
 *     | CLA| INS | P1 | P2 |  Lc  | data ... |
 *     +----+-----+----+----+------+----------+
 *       1    1    1    1     1       Lc bytes
 *   Extended form (Lc > 0xFF, header byte 0x00 marks extended):
 *     +----+-----+----+----+------+-------+----------+
 *     | CLA| INS | P1 | P2 | 0x00 | Lc_BE | data ... |
 *     +----+-----+----+----+------+-------+----------+
 *       1    1    1    1     1       2       Lc bytes
 *   Case 1 (no data, no Le): header only, total length == 4.
 *
 *   We do NOT use Le in our protocol. A single trailing Le byte (short form)
 *   or two trailing Le bytes (extended form) is tolerated and skipped; any
 *   other trailing slop is a framing error.
 *
 * Wire format (response):
 *   +-----------+-----+-----+
 *   | data ...  | SW1 | SW2 |
 *   +-----------+-----+-----+
 *
 * All commands use CLA=0xE0 (our vendor class). SW1/SW2 follow ISO 7816.
 */
#ifndef BYEORIN_APDU_H_
#define BYEORIN_APDU_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <zephyr/kernel.h>

#define BYEORIN_APDU_CLA          0xE0u

/* INS opcodes. Keep contiguous-ish so the dispatch table stays compact. */
#define BYEORIN_INS_GET_VERSION       0x00u
#define BYEORIN_INS_GET_PUBKEY        0x01u
#define BYEORIN_INS_SIGN_HASH         0x02u
#define BYEORIN_INS_GET_DEVICE_INFO   0x03u
#define BYEORIN_INS_PAIR_BEGIN        0x10u
#define BYEORIN_INS_PAIR_COMPLETE     0x11u
#define BYEORIN_INS_FW_UPGRADE_BEGIN  0xFEu
#define BYEORIN_INS_FW_UPGRADE_CHUNK  0xFDu
#define BYEORIN_INS_FW_UPGRADE_FINISH 0xFCu

/* Status words. */
#define BYEORIN_SW_OK                  0x9000u
#define BYEORIN_SW_USER_CANCELLED      0x6985u
#define BYEORIN_SW_INCORRECT_DATA      0x6A80u
#define BYEORIN_SW_INS_NOT_SUPPORTED   0x6D00u
#define BYEORIN_SW_CLA_NOT_SUPPORTED   0x6E00u
#define BYEORIN_SW_INTERNAL_ERROR      0x6F00u
#define BYEORIN_SW_UNAUTHORIZED        0x6982u
#define BYEORIN_SW_TIMEOUT             0x6401u

/* TLV tags used inside command/response payloads. */
#define BYEORIN_TLV_CURVE         0x01u  /* 1 byte: 0=secp256k1, 1=ed25519, 2=secp256r1 */
#define BYEORIN_TLV_BIP32_PATH    0x02u  /* N x uint32 big-endian */
#define BYEORIN_TLV_DIGEST        0x03u  /* 32 bytes typically */
#define BYEORIN_TLV_CHAIN_LABEL   0x04u  /* UTF-8 ASCII, e.g. "TTL", "ETH" */
#define BYEORIN_TLV_TO_ADDRESS    0x05u  /* UTF-8 / hex */
#define BYEORIN_TLV_AMOUNT_STR    0x06u  /* UTF-8 human-readable amount */
#define BYEORIN_TLV_PUBKEY        0x10u
#define BYEORIN_TLV_SIGNATURE     0x11u

#define BYEORIN_CURVE_SECP256K1   0x00u
#define BYEORIN_CURVE_ED25519     0x01u
#define BYEORIN_CURVE_SECP256R1   0x02u

/*
 * Origin of the APDU. Some commands (notably SIGN_HASH) are refused over
 * BLE by default — see CONFIG_BYEORIN_ALLOW_BLE_SIGNING.
 */
typedef enum {
	BYEORIN_TRANSPORT_USB_HID = 0,
	BYEORIN_TRANSPORT_BLE     = 1,
} byeorin_transport_t;

/* Parsed command APDU. `data` points into the caller's buffer. */
struct byeorin_apdu_cmd {
	uint8_t  cla;
	uint8_t  ins;
	uint8_t  p1;
	uint8_t  p2;
	uint16_t lc;
	const uint8_t *data;
	byeorin_transport_t origin;
};

/* Response APDU under construction. */
struct byeorin_apdu_resp {
	uint8_t *data;
	size_t   capacity;
	size_t   len;       /* bytes written so far (excluding SW) */
	uint16_t sw;        /* status word; SW1=hi, SW2=lo */
};

/* Handler signature. Return 0 on success (sw populated), <0 on internal err. */
typedef int (*byeorin_apdu_handler_t)(const struct byeorin_apdu_cmd *cmd,
				     struct byeorin_apdu_resp *resp);

struct byeorin_apdu_entry {
	uint8_t ins;
	bool    requires_user_confirm;
	bool    allow_over_ble;
	byeorin_apdu_handler_t fn;
	const char *name;
};

/*
 * Parse a raw command buffer per ISO/IEC 7816-4.
 *
 * Accepts:
 *   - Case 1                  : raw_len == 4                        (lc = 0)
 *   - Short form, no Le       : raw_len == 5 + Lc, raw[4] in 1..255 (lc = raw[4])
 *   - Short form, with Le     : raw_len == 6 + Lc, raw[4] in 1..255 (Le skipped)
 *   - Extended form, no Le    : raw_len == 7 + Lc, raw[4] == 0x00,
 *                               Lc = (raw[5]<<8)|raw[6]
 *   - Extended form, with Le  : raw_len == 9 + Lc, raw[4] == 0x00   (Le skipped)
 *
 * Returns 0 on OK, -EINVAL on null/short/oversized, -APDU_ERR_BAD_LC if the
 * declared Lc does not match raw_len under any of the legal framings above.
 */
int byeorin_apdu_parse(const uint8_t *raw, size_t raw_len,
		      struct byeorin_apdu_cmd *out);

/*
 * Parser error codes. Returned as negative values from byeorin_apdu_parse().
 * Distinct from generic -EINVAL so the transport layer can map them to a
 * specific status word if desired.
 */
#define APDU_ERR_BAD_LC          200  /* Declared Lc disagrees with raw_len */

/* Dispatch a parsed command. Always sets resp->sw, even on error paths. */
int byeorin_apdu_dispatch(const struct byeorin_apdu_cmd *cmd,
			 struct byeorin_apdu_resp *resp);

/* Serialise a response into a flat buffer ready for the transport layer.
 * Writes resp->data[0..len] then SW1 SW2. Returns total bytes written, or
 * negative errno on overflow.                                            */
int byeorin_apdu_serialize(const struct byeorin_apdu_resp *resp,
			  uint8_t *out, size_t out_capacity);

/* Small TLV decode helper — used by handlers and the per-chain apps. */
int byeorin_tlv_find(const uint8_t *buf, size_t len, uint8_t tag,
		    const uint8_t **out_value, size_t *out_value_len);

#endif /* BYEORIN_APDU_H_ */
