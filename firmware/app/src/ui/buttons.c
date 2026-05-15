/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — physical button input.
 *
 * GPIO interrupt -> mark "pending", schedule k_work delayed by 20 ms ->
 * on expiry, re-read level. If still asserted, emit PRESS event. Mirror
 * for release. Long-press detection runs a second work item.
 */
#include "ui/buttons.h"
#include "log.h"

#include <errno.h>
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/devicetree.h>

LOG_MODULE_REGISTER(nodong_btn, CONFIG_LOG_DEFAULT_LEVEL);

#define OK_NODE     DT_ALIAS(ok_button)
#define CANCEL_NODE DT_ALIAS(cancel_button)

static const struct gpio_dt_spec k_btn[NODONG_BUTTON__COUNT] = {
#if DT_NODE_EXISTS(OK_NODE)
	[NODONG_BUTTON_OK]     = GPIO_DT_SPEC_GET(OK_NODE, gpios),
#endif
#if DT_NODE_EXISTS(CANCEL_NODE)
	[NODONG_BUTTON_CANCEL] = GPIO_DT_SPEC_GET(CANCEL_NODE, gpios),
#endif
};

K_SEM_DEFINE(m_sem, 0, 1);
static nodong_button_cb_t m_cb;
static nodong_button_t    m_last;

static struct gpio_callback m_cb_data[NODONG_BUTTON__COUNT];
static struct k_work_delayable m_debounce[NODONG_BUTTON__COUNT];

/*
 * Debounce timing — current 20 ms is conservative for tactile dome
 * switches; the recommended hold time for a clean PRESS event is 5–10 ms.
 *
 * TODO(bring-up): tune to 5–10 ms once we have scope traces of the
 * real switches on the production board, and implement:
 *   - RELEASE event emission (re-sample on falling edge, emit
 *     NODONG_BUTTON_EV_RELEASE iff level==0 after the same window).
 *   - LONG_PRESS event (schedule a second k_work_delayable for 2 s
 *     after PRESS; cancel on RELEASE).
 *   - Clear-press-on-release semantics: discard any sem token left
 *     behind by a press whose release happened during a UI transition,
 *     so a held button cannot fall through into the next confirm dialog.
 */
static void debounce_handler(struct k_work *w)
{
	struct k_work_delayable *dw = k_work_delayable_from_work(w);
	for (int i = 0; i < NODONG_BUTTON__COUNT; i++) {
		if (dw != &m_debounce[i]) { continue; }
		if (!device_is_ready(k_btn[i].port)) { return; }
		int level = gpio_pin_get_dt(&k_btn[i]);
		if (level == 1) {
			m_last = (nodong_button_t)i;
			if (m_cb) { m_cb(m_last, NODONG_BUTTON_EV_PRESS); }
			k_sem_give(&m_sem);
		}
	}
}

static void on_gpio(const struct device *port,
		    struct gpio_callback *cb_data, gpio_port_pins_t pins)
{
	(void)port; (void)pins;
	for (int i = 0; i < NODONG_BUTTON__COUNT; i++) {
		if (cb_data == &m_cb_data[i]) {
			(void)k_work_reschedule(&m_debounce[i], K_MSEC(20));
			return;
		}
	}
}

void buttons_register_cb(nodong_button_cb_t cb) { m_cb = cb; }

int buttons_init(void)
{
	int rc;
	for (int i = 0; i < NODONG_BUTTON__COUNT; i++) {
		if (!device_is_ready(k_btn[i].port)) {
			ND_LOG_WRN("buttons: btn %d port not ready", i);
			continue;
		}
		rc = gpio_pin_configure_dt(&k_btn[i], GPIO_INPUT);
		if (rc) { return rc; }
		rc = gpio_pin_interrupt_configure_dt(&k_btn[i], GPIO_INT_EDGE_BOTH);
		if (rc) { return rc; }
		gpio_init_callback(&m_cb_data[i], on_gpio, BIT(k_btn[i].pin));
		gpio_add_callback(k_btn[i].port, &m_cb_data[i]);
		k_work_init_delayable(&m_debounce[i], debounce_handler);
	}
	return 0;
}

nodong_button_t buttons_wait(k_timeout_t timeout)
{
	if (k_sem_take(&m_sem, timeout) != 0) {
		return NODONG_BUTTON__COUNT;
	}
	return m_last;
}
