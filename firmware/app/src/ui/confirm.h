/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — confirmation dialog.
 *
 * Every flow that authorises an action (sign, export pubkey, firmware
 * upgrade, factory reset) goes through this module. It is the *only*
 * place that calls buttons_wait(), so the trusted UI flow is auditable
 * by reading this single file.
 */
#ifndef BYEORIN_CONFIRM_H_
#define BYEORIN_CONFIRM_H_

#include <stddef.h>
#include <stdint.h>

enum byeorin_confirm_result {
	BYEORIN_CONFIRM_OK      = 0,
	BYEORIN_CONFIRM_CANCEL  = 1,
	BYEORIN_CONFIRM_TIMEOUT = 2,
};

/*
 * Show a transaction-confirmation page. Layout:
 *   ┌────────────────────────────┐
 *   │  <label>                  │   (title, ex "Send TTL")
 *   │  To: <to>                 │
 *   │  Amount: <amount_str>     │
 *   │                           │
 *   │  [OK]            [CANCEL] │
 *   └────────────────────────────┘
 *
 * Blocks the calling thread until OK / CANCEL / timeout
 * (CONFIG_BYEORIN_CONFIRM_TIMEOUT_SEC).
 *
 * 사용자 물리 버튼 확인 필요 — 절대 자동 승인 금지.
 */
enum byeorin_confirm_result confirm_tx(const char *label,
				      const char *to,
				      const char *amount_str);

/* Generic "Sign this digest?" dialog for unknown chain labels. */
enum byeorin_confirm_result confirm_generic_sign(void);

/* Free-form confirm with one or two lines of body text. */
enum byeorin_confirm_result confirm_message(const char *title,
					   const char *line1,
					   const char *line2);

#endif /* BYEORIN_CONFIRM_H_ */
