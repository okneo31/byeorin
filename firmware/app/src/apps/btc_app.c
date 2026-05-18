/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — BTC chain app.
 */
#include "apps/btc_app.h"
#include "log.h"

#include <stdbool.h>
#include <string.h>

LOG_MODULE_REGISTER(byeorin_btc, CONFIG_LOG_DEFAULT_LEVEL);

static bool m_session_approved;

void btc_app_end_session(void)
{
	m_session_approved = false;
}

enum byeorin_confirm_result btc_app_confirm(const uint8_t *chain_label,
					   size_t chain_label_len,
					   const uint8_t *to_summary,
					   size_t to_len,
					   const uint8_t *amount_summary,
					   size_t amount_len)
{
	(void)chain_label; (void)chain_label_len;

	if (m_session_approved) {
		/* Subsequent inputs in an already-approved batch. */
		return BYEORIN_CONFIRM_OK;
	}

	char to_buf[64];
	char amt_buf[32];
	size_t tl = to_len < sizeof(to_buf) - 1 ? to_len : sizeof(to_buf) - 1;
	size_t al = amount_len < sizeof(amt_buf) - 1 ? amount_len
						     : sizeof(amt_buf) - 1;
	memcpy(to_buf, to_summary, tl);  to_buf[tl] = '\0';
	memcpy(amt_buf, amount_summary, al); amt_buf[al] = '\0';

	enum byeorin_confirm_result r = confirm_tx("Send BTC", to_buf, amt_buf);
	if (r == BYEORIN_CONFIRM_OK) { m_session_approved = true; }
	return r;
}
