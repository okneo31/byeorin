/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — e-ink display wrapper.
 *
 * Panel: 1.54" 200x200, SSD1681 controller (UC8151 is the fallback
 * variant on dev boards). Connected over SPI3 plus DC/RST/BUSY GPIOs
 * as wired in app/boards/nrf52840_byeorin_yose.overlay.
 *
 * Frame buffer is 1bpp (200*200/8 = 5000 bytes). Partial updates are
 * supported on SSD1681 and let us refresh the "current selection"
 * highlight without ghosting the whole screen.
 */
#ifndef BYEORIN_DISPLAY_H_
#define BYEORIN_DISPLAY_H_

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#define ND_DISPLAY_W  200
#define ND_DISPLAY_H  200

int  display_init(void);
void display_clear(void);

/* Whole-frame "full" refresh — slow (~700ms) but ghost-free. */
int  display_refresh_full(void);
/* Region refresh — fast (~150ms), can ghost after many calls. */
int  display_refresh_partial(uint16_t x, uint16_t y, uint16_t w, uint16_t h);

/* Text rendering. font_id 0 = small (8px), 1 = body (12px), 2 = title (24px). */
int  display_draw_text(uint16_t x, uint16_t y,
		       uint8_t font_id, const char *utf8);

/* QR code (used for address-display flow). */
int  display_draw_qr(uint16_t x, uint16_t y,
		     uint16_t size, const uint8_t *data, size_t len);

/* Status icons in the top bar. */
typedef enum {
	ND_ICON_BATTERY_FULL,
	ND_ICON_BATTERY_LOW,
	ND_ICON_USB,
	ND_ICON_BLE,
	ND_ICON_LOCK,
} byeorin_icon_t;
int  display_draw_icon(uint16_t x, uint16_t y, byeorin_icon_t icon);

#endif /* BYEORIN_DISPLAY_H_ */
