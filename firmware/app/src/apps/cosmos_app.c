/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — Cosmos chain-app.
 *
 * Recipients are bech32 strings ("cosmos1..." / "ttl1..."). We render
 * them with the HRP intact so the user can sanity-check the network
 * (mainnet vs testnet vs sidechain).
 */
#include "apps/cosmos_app.h"
#include "log.h"

#include <string.h>

LOG_MODULE_REGISTER(byeorin_cosmos, CONFIG_LOG_DEFAULT_LEVEL);

enum byeorin_confirm_result cosmos_app_confirm(const uint8_t *chain_label,
					      size_t chain_label_len,
					      const uint8_t *to_bech32,
					      size_t to_len,
					      const uint8_t *amount_str,
					      size_t amount_str_len)
{
	char label[24];
	char to_buf[64];
	char amt_buf[32];

	size_t cl = chain_label_len < sizeof(label) - 6 ? chain_label_len
							: sizeof(label) - 7;
	memcpy(label, "Send ", 5);
	memcpy(&label[5], chain_label, cl);
	label[5 + cl] = '\0';

	if (to_len >= sizeof(to_buf)) { to_len = sizeof(to_buf) - 1; }
	memcpy(to_buf, to_bech32, to_len);
	to_buf[to_len] = '\0';

	if (amount_str_len >= sizeof(amt_buf)) {
		amount_str_len = sizeof(amt_buf) - 1;
	}
	memcpy(amt_buf, amount_str, amount_str_len);
	amt_buf[amount_str_len] = '\0';

	return confirm_tx(label, to_buf, amt_buf);
}
