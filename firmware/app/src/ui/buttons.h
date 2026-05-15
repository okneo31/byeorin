/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — physical button input.
 *
 * Two buttons: OK (P0.13) and CANCEL (P0.15). Both active-low with
 * internal pull-ups (see overlay). Bouncing is handled in software via
 * a 20 ms delayed-work re-sample.
 */
#ifndef NODONG_BUTTONS_H_
#define NODONG_BUTTONS_H_

#include <stdbool.h>
#include <zephyr/kernel.h>

typedef enum {
	NODONG_BUTTON_OK     = 0,
	NODONG_BUTTON_CANCEL = 1,
	NODONG_BUTTON__COUNT,
} nodong_button_t;

typedef enum {
	NODONG_BUTTON_EV_PRESS,
	NODONG_BUTTON_EV_RELEASE,
	NODONG_BUTTON_EV_LONG_PRESS, /* >= 2 s */
} nodong_button_event_t;

typedef void (*nodong_button_cb_t)(nodong_button_t which,
				   nodong_button_event_t event);

int  buttons_init(void);
void buttons_register_cb(nodong_button_cb_t cb);

/* Synchronous helper: block on the application's main thread until a
 * button event arrives or `timeout` elapses. Returns the button pressed,
 * or NODONG_BUTTON__COUNT on timeout. */
nodong_button_t buttons_wait(k_timeout_t timeout);

#endif /* NODONG_BUTTONS_H_ */
