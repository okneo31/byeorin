/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — APDU dispatch.
 */
#include "transport/apdu.h"
#include "se/se050.h"
#include "keys/derive.h"
#include "ui/confirm.h"
#include "ui/display.h"
#include "apps/evm_app.h"
#include "apps/cosmos_app.h"
#include "apps/btc_app.h"
#include "version.h"
#include "log.h"

#include <errno.h>
#include <string.h>

LOG_MODULE_REGISTER(nodong_apdu, CONFIG_LOG_DEFAULT_LEVEL);

/* ----------------------- Handlers (stubs) ----------------------- */

static int h_get_version(const struct nodong_apdu_cmd *cmd,
			 struct nodong_apdu_resp *resp)
{
	(void)cmd;
	const char *ver = NODONG_FW_VERSION;
	size_t n = strlen(ver);

	if (resp->capacity < n) {
		resp->sw = NODONG_SW_INTERNAL_ERROR;
		return -ENOMEM;
	}
	memcpy(resp->data, ver, n);
	resp->len = n;
	resp->sw  = NODONG_SW_OK;
	return 0;
}

static int h_get_pubkey(const struct nodong_apdu_cmd *cmd,
			struct nodong_apdu_resp *resp)
{
	/*
	 * Expected TLVs in cmd->data:
	 *   - CURVE      (1 byte)
	 *   - BIP32_PATH (N * uint32 BE)
	 *
	 * We never sign in this path, but we *do* require a quick on-screen
	 * "Export public key?" confirmation when P1 == 0x01, to prevent
	 * silent address-fingerprinting.
	 */
	(void)cmd;
	(void)resp;
	/* TODO: parse TLVs, call keys_derive_pubkey, optionally confirm. */
	resp->sw = NODONG_SW_INS_NOT_SUPPORTED;
	return -ENOSYS;
}

static int h_sign_hash(const struct nodong_apdu_cmd *cmd,
		       struct nodong_apdu_resp *resp)
{
	const uint8_t *curve_v = NULL, *path_v = NULL, *digest_v = NULL;
	const uint8_t *chain_v = NULL, *to_v = NULL, *amount_v = NULL;
	size_t curve_l = 0, path_l = 0, digest_l = 0;
	size_t chain_l = 0, to_l = 0, amount_l = 0;
	int rc;

	rc = nodong_tlv_find(cmd->data, cmd->lc, NODONG_TLV_CURVE, &curve_v, &curve_l);
	if (rc || curve_l != 1) { resp->sw = NODONG_SW_INCORRECT_DATA; return 0; }
	rc = nodong_tlv_find(cmd->data, cmd->lc, NODONG_TLV_BIP32_PATH, &path_v, &path_l);
	if (rc || (path_l % 4) != 0) { resp->sw = NODONG_SW_INCORRECT_DATA; return 0; }
	rc = nodong_tlv_find(cmd->data, cmd->lc, NODONG_TLV_DIGEST, &digest_v, &digest_l);
	if (rc || digest_l != 32) { resp->sw = NODONG_SW_INCORRECT_DATA; return 0; }

	(void)nodong_tlv_find(cmd->data, cmd->lc, NODONG_TLV_CHAIN_LABEL,
			      &chain_v, &chain_l);
	(void)nodong_tlv_find(cmd->data, cmd->lc, NODONG_TLV_TO_ADDRESS,
			      &to_v, &to_l);
	(void)nodong_tlv_find(cmd->data, cmd->lc, NODONG_TLV_AMOUNT_STR,
			      &amount_v, &amount_l);

	/*
	 * Route to the per-chain "app" so the user sees a chain-appropriate
	 * confirmation screen. Each app must end by either:
	 *   - returning CONFIRM_OK and we call se_sign, OR
	 *   - returning CONFIRM_CANCEL / CONFIRM_TIMEOUT.
	 */
	enum nodong_confirm_result conf = NODONG_CONFIRM_CANCEL;
	if (chain_l >= 3 && (memcmp(chain_v, "ETH", 3) == 0 ||
			     memcmp(chain_v, "TTL", 3) == 0)) {
		conf = evm_app_confirm(chain_v, chain_l,
				       to_v, to_l, amount_v, amount_l);
	} else if (chain_l >= 6 && memcmp(chain_v, "COSMOS", 6) == 0) {
		conf = cosmos_app_confirm(chain_v, chain_l,
					  to_v, to_l, amount_v, amount_l);
	} else if (chain_l >= 3 && memcmp(chain_v, "BTC", 3) == 0) {
		conf = btc_app_confirm(chain_v, chain_l,
				       to_v, to_l, amount_v, amount_l);
	} else {
		ND_LOG_WRN("sign_hash: unknown chain label, generic confirm");
		conf = confirm_generic_sign();
	}

	switch (conf) {
	case NODONG_CONFIRM_OK:
		break;
	case NODONG_CONFIRM_CANCEL:
		resp->sw = NODONG_SW_USER_CANCELLED;
		return 0;
	case NODONG_CONFIRM_TIMEOUT:
	default:
		resp->sw = NODONG_SW_TIMEOUT;
		return 0;
	}

	/* TODO: call se_sign(curve, path, digest, resp->data). */
	resp->sw = NODONG_SW_INTERNAL_ERROR;
	return -ENOSYS;
}

static int h_get_device_info(const struct nodong_apdu_cmd *cmd,
			     struct nodong_apdu_resp *resp)
{
	(void)cmd;
	(void)resp;
	/* TODO: SE050 OEF + boot counter + battery + firmware hash. */
	resp->sw = NODONG_SW_INS_NOT_SUPPORTED;
	return -ENOSYS;
}

static int h_fw_upgrade_begin(const struct nodong_apdu_cmd *cmd,
			      struct nodong_apdu_resp *resp)
{
	(void)cmd;
	(void)resp;
	/* TODO: validate version > current, open slot1, request user confirm. */
	resp->sw = NODONG_SW_INS_NOT_SUPPORTED;
	return -ENOSYS;
}

/* ----------------------- Dispatch table ------------------------- */

static const struct nodong_apdu_entry k_table[] = {
	{ NODONG_INS_GET_VERSION,      false, true,  h_get_version,      "GET_VERSION"     },
	{ NODONG_INS_GET_PUBKEY,       false, true,  h_get_pubkey,       "GET_PUBKEY"      },
	{ NODONG_INS_SIGN_HASH,        true,  false, h_sign_hash,        "SIGN_HASH"       },
	{ NODONG_INS_GET_DEVICE_INFO,  false, true,  h_get_device_info,  "GET_DEVICE_INFO" },
	{ NODONG_INS_FW_UPGRADE_BEGIN, true,  false, h_fw_upgrade_begin, "FW_UPGRADE_BEGIN"},
};

/* ----------------------- Parser & helpers ----------------------- */

/*
 * APDU parser — ISO/IEC 7816-4 short and extended forms.
 *
 * Layouts we accept:
 *   Case 1 (no data, no Le):  [CLA INS P1 P2]                                 len == 4
 *   Short, no Le:             [CLA INS P1 P2 Lc data(Lc)]                     len == 5 + Lc
 *   Short, with Le:           [CLA INS P1 P2 Lc data(Lc) Le]                  len == 6 + Lc
 *   Extended, no Le:          [CLA INS P1 P2 0x00 LcHi LcLo data(Lc)]         len == 7 + Lc
 *   Extended, with Le:        [CLA INS P1 P2 0x00 LcHi LcLo data(Lc) LeHi LeLo]
 *                                                                             len == 9 + Lc
 *
 * Extended form is signalled by raw[4] == 0x00 with at least 7 total bytes.
 * Earlier this function blindly did `out->lc = raw[4]` (a single byte),
 * which silently mangled any extended-form APDU: only the low 8 bits of
 * Lc were kept, and the 2-byte big-endian Lc plus the first byte of data
 * were treated as payload starting one byte too early. Downstream TLV
 * walks would then run off the truncated `lc` and miss data. Fix below
 * decodes the framing correctly and rejects unrecognised trailing bytes.
 *
 * We do not currently consume Le, but tolerate its presence so a more
 * conservative companion SDK does not break the link.
 */
int nodong_apdu_parse(const uint8_t *raw, size_t raw_len,
		      struct nodong_apdu_cmd *out)
{
	if (!raw || !out) {
		return -EINVAL;
	}
	if (raw_len < 4u || raw_len > (size_t)CONFIG_NODONG_MAX_APDU_LEN) {
		return -EINVAL;
	}

	out->cla = raw[0];
	out->ins = raw[1];
	out->p1  = raw[2];
	out->p2  = raw[3];

	/* Case 1: header only, no Lc, no data, no Le. */
	if (raw_len == 4u) {
		out->lc   = 0;
		out->data = NULL;
		return 0;
	}

	/* From here on raw_len >= 5. */
	if (raw[4] != 0x00) {
		/* Short form: 1-byte Lc in raw[4]. */
		uint16_t lc = raw[4];
		size_t   need_no_le = 5u + lc;
		size_t   need_w_le  = 6u + lc;

		if (raw_len == need_no_le) {
			out->lc   = lc;
			out->data = (lc > 0) ? &raw[5] : NULL;
			return 0;
		}
		if (raw_len == need_w_le) {
			/* Trailing Le byte; ignored (we don't use Le). */
			out->lc   = lc;
			out->data = (lc > 0) ? &raw[5] : NULL;
			return 0;
		}
		return -APDU_ERR_BAD_LC;
	}

	/*
	 * Extended form: raw[4] == 0x00, then 2-byte big-endian Lc in
	 * raw[5..6], data in raw[7..]. Requires at least 7 header bytes.
	 */
	if (raw_len < 7u) {
		return -APDU_ERR_BAD_LC;
	}
	{
		uint16_t lc = (uint16_t)((raw[5] << 8) | raw[6]);
		size_t   need_no_le = 7u + lc;
		size_t   need_w_le  = 9u + lc;

		if (raw_len == need_no_le) {
			out->lc   = lc;
			out->data = (lc > 0) ? &raw[7] : NULL;
			return 0;
		}
		if (raw_len == need_w_le) {
			/* Trailing 2-byte Le; ignored. */
			out->lc   = lc;
			out->data = (lc > 0) ? &raw[7] : NULL;
			return 0;
		}
		return -APDU_ERR_BAD_LC;
	}
}

int nodong_tlv_find(const uint8_t *buf, size_t len, uint8_t tag,
		    const uint8_t **out_value, size_t *out_value_len)
{
	size_t i = 0;
	while (i + 2 <= len) {
		uint8_t t = buf[i];
		uint8_t l = buf[i + 1];
		if (i + 2 + l > len) {
			return -EINVAL;
		}
		if (t == tag) {
			*out_value     = &buf[i + 2];
			*out_value_len = l;
			return 0;
		}
		i += 2u + l;
	}
	return -ENOENT;
}

int nodong_apdu_dispatch(const struct nodong_apdu_cmd *cmd,
			 struct nodong_apdu_resp *resp)
{
	if (cmd->cla != NODONG_APDU_CLA) {
		resp->sw = NODONG_SW_CLA_NOT_SUPPORTED;
		return 0;
	}

	for (size_t i = 0; i < ARRAY_SIZE(k_table); i++) {
		const struct nodong_apdu_entry *e = &k_table[i];
		if (e->ins != cmd->ins) {
			continue;
		}
		if (cmd->origin == NODONG_TRANSPORT_BLE && !e->allow_over_ble) {
#ifndef CONFIG_NODONG_ALLOW_BLE_SIGNING
			ND_LOG_WRN("ins=0x%02x refused over BLE", cmd->ins);
			resp->sw = NODONG_SW_UNAUTHORIZED;
			return 0;
#endif
		}
		ND_LOG_INF("dispatch %s (ins=0x%02x)", e->name, cmd->ins);
		return e->fn(cmd, resp);
	}

	resp->sw = NODONG_SW_INS_NOT_SUPPORTED;
	return 0;
}

int nodong_apdu_serialize(const struct nodong_apdu_resp *resp,
			  uint8_t *out, size_t out_capacity)
{
	if (!resp || !out) {
		return -EINVAL;
	}
	if (resp->len + 2u > out_capacity) {
		return -ENOMEM;
	}
	if (resp->len > 0 && resp->data != out) {
		memmove(out, resp->data, resp->len);
	}
	out[resp->len]     = (uint8_t)(resp->sw >> 8);
	out[resp->len + 1] = (uint8_t)(resp->sw & 0xFF);
	return (int)(resp->len + 2u);
}
