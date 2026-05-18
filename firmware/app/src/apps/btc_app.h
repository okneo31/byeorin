/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — Bitcoin chain app.
 *
 * Unlike EVM/Cosmos, BTC psbt signing involves multiple inputs and
 * potentially multiple outputs. We expose one "confirm" call per
 * signing session; the caller drives a loop over inputs (each input
 * is its own digest from the SDK).
 */
#ifndef BYEORIN_APP_BTC_H_
#define BYEORIN_APP_BTC_H_

#include <stddef.h>
#include <stdint.h>
#include "ui/confirm.h"

/*
 * For a single-input transaction this is identical to evm/cosmos. For
 * multi-input PSBTs, the SDK sends N sign requests; we either:
 *   (a) prompt once at the start with the *aggregate summary*
 *       ("Sending 0.1 BTC to bc1q... and 0.02 BTC to bc1q... change"),
 *       and silently auto-confirm subsequent input digests during the
 *       same session; or
 *   (b) prompt per input (paranoid mode).
 * The companion sets P2 to choose. Default = (a).
 */
enum byeorin_confirm_result btc_app_confirm(const uint8_t *chain_label,
					   size_t chain_label_len,
					   const uint8_t *to_summary,
					   size_t to_len,
					   const uint8_t *amount_summary,
					   size_t amount_len);

/* Drop the "session approved" flag after the last input is signed. */
void btc_app_end_session(void);

#endif /* BYEORIN_APP_BTC_H_ */
