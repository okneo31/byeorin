/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — confirmation dialog.
 *
 * Every flow that authorises an action (sign, export pubkey, firmware
 * upgrade, factory reset) goes through this module. It is the *only*
 * place that calls buttons_wait(), so the trusted UI flow is auditable
 * by reading this single file.
 */
#ifndef NODONG_CONFIRM_H_
#define NODONG_CONFIRM_H_

#include <stddef.h>
#include <stdint.h>

enum nodong_confirm_result {
	NODONG_CONFIRM_OK      = 0,
	NODONG_CONFIRM_CANCEL  = 1,
	NODONG_CONFIRM_TIMEOUT = 2,
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
 * (CONFIG_NODONG_CONFIRM_TIMEOUT_SEC).
 *
 * 사용자 물리 버튼 확인 필요 — 절대 자동 승인 금지.
 */
enum nodong_confirm_result confirm_tx(const char *label,
				      const char *to,
				      const char *amount_str);

/* Generic "Sign this digest?" dialog for unknown chain labels. */
enum nodong_confirm_result confirm_generic_sign(void);

/* Free-form confirm with one or two lines of body text. */
enum nodong_confirm_result confirm_message(const char *title,
					   const char *line1,
					   const char *line2);

#endif /* NODONG_CONFIRM_H_ */
