/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — physical button input.
 *
 * Two buttons: OK (P0.13) and CANCEL (P0.15). Both active-low with
 * internal pull-ups (see overlay). Bouncing is handled in software via
 * a 20 ms delayed-work re-sample.
 */
#ifndef BYEORIN_BUTTONS_H_
#define BYEORIN_BUTTONS_H_

#include <stdbool.h>
#include <zephyr/kernel.h>

typedef enum {
	BYEORIN_BUTTON_OK     = 0,
	BYEORIN_BUTTON_CANCEL = 1,
	BYEORIN_BUTTON__COUNT,
} byeorin_button_t;

typedef enum {
	BYEORIN_BUTTON_EV_PRESS,
	BYEORIN_BUTTON_EV_RELEASE,
	BYEORIN_BUTTON_EV_LONG_PRESS, /* >= 2 s */
} byeorin_button_event_t;

typedef void (*byeorin_button_cb_t)(byeorin_button_t which,
				   byeorin_button_event_t event);

int  buttons_init(void);
void buttons_register_cb(byeorin_button_cb_t cb);

/* Synchronous helper: block on the application's main thread until a
 * button event arrives or `timeout` elapses. Returns the button pressed,
 * or BYEORIN_BUTTON__COUNT on timeout. */
byeorin_button_t buttons_wait(k_timeout_t timeout);

#endif /* BYEORIN_BUTTONS_H_ */
