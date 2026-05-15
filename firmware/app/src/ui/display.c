/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — e-ink display wrapper (SSD1681).
 */
#include "ui/display.h"
#include "log.h"

#include <errno.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/display.h>

LOG_MODULE_REGISTER(nodong_disp, CONFIG_LOG_DEFAULT_LEVEL);

#define FB_BYTES  ((ND_DISPLAY_W * ND_DISPLAY_H) / 8)

static uint8_t       m_fb[FB_BYTES];
static const struct device *m_dev;

int display_init(void)
{
	m_dev = DEVICE_DT_GET_ANY(solomon_ssd1681);
	if (!m_dev) {
		ND_LOG_WRN("display: no SSD1681 node in DT, using stub");
		return 0; /* keep boot going on dev boards without the panel */
	}
	if (!device_is_ready(m_dev)) {
		ND_LOG_ERR("display: device not ready");
		return -ENODEV;
	}
	/* TODO: display_blanking_off(m_dev); set framebuffer pixel format. */
	memset(m_fb, 0xFF, sizeof(m_fb)); /* white */
	return 0;
}

void display_clear(void)
{
	memset(m_fb, 0xFF, sizeof(m_fb));
}

int display_refresh_full(void)
{
	if (!m_dev) { return 0; }
	/* TODO: struct display_buffer_descriptor + display_write(). */
	return -ENOSYS;
}

int display_refresh_partial(uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
	(void)x; (void)y; (void)w; (void)h;
	/* TODO: partial-window command sequence. */
	return -ENOSYS;
}

int display_draw_text(uint16_t x, uint16_t y, uint8_t font_id, const char *utf8)
{
	(void)x; (void)y; (void)font_id; (void)utf8;
	/* TODO: blit glyphs from compiled font table into m_fb.
	 *       For Korean we need a UTF-8 → glyph-index step (NanumGothic
	 *       Coding subsetted to common syllables to fit in flash). */
	return -ENOSYS;
}

int display_draw_qr(uint16_t x, uint16_t y, uint16_t size,
		    const uint8_t *data, size_t len)
{
	(void)x; (void)y; (void)size; (void)data; (void)len;
	/* TODO: use lib/qrcodegen (Project Nayuki, MIT). */
	return -ENOSYS;
}

int display_draw_icon(uint16_t x, uint16_t y, nodong_icon_t icon)
{
	(void)x; (void)y; (void)icon;
	return -ENOSYS;
}
