/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — confirmation dialog.
 */
#include "ui/confirm.h"
#include "ui/display.h"
#include "ui/buttons.h"
#include "log.h"

#include <zephyr/kernel.h>

LOG_MODULE_REGISTER(nodong_confirm, CONFIG_LOG_DEFAULT_LEVEL);

static enum nodong_confirm_result render_and_wait(const char *title,
						  const char *line1,
						  const char *line2,
						  const char *line3)
{
	display_clear();
	if (title) { (void)display_draw_text(8,  4, 2, title); }
	if (line1) { (void)display_draw_text(8, 56, 1, line1); }
	if (line2) { (void)display_draw_text(8, 88, 1, line2); }
	if (line3) { (void)display_draw_text(8, 120, 1, line3); }
	(void)display_draw_text(8,  176, 1, "[OK]");
	(void)display_draw_text(152, 176, 1, "[CANCEL]");
	(void)display_refresh_full();

	k_timeout_t to = K_SECONDS(CONFIG_NODONG_CONFIRM_TIMEOUT_SEC);
	nodong_button_t b = buttons_wait(to);
	switch (b) {
	case NODONG_BUTTON_OK:     return NODONG_CONFIRM_OK;
	case NODONG_BUTTON_CANCEL: return NODONG_CONFIRM_CANCEL;
	default:                   return NODONG_CONFIRM_TIMEOUT;
	}
}

enum nodong_confirm_result confirm_tx(const char *label,
				      const char *to,
				      const char *amount_str)
{
	/* 사용자 물리 버튼 확인 필요. */
	char to_line[64];
	char amt_line[64];
	(void)snprintk(to_line, sizeof(to_line), "To: %s", to ? to : "?");
	(void)snprintk(amt_line, sizeof(amt_line), "Amount: %s",
		       amount_str ? amount_str : "?");
	return render_and_wait(label ? label : "Sign",
			       to_line, amt_line, NULL);
}

enum nodong_confirm_result confirm_generic_sign(void)
{
	return render_and_wait("Sign?",
			       "Unknown chain.",
			       "Signing a raw digest.",
			       "Are you sure?");
}

enum nodong_confirm_result confirm_message(const char *title,
					   const char *line1,
					   const char *line2)
{
	return render_and_wait(title, line1, line2, NULL);
}
