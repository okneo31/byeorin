/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — logging wrapper.
 *
 * Wraps Zephyr's logging subsystem so we can:
 *   1) compile every log call out in release builds (CONFIG_LOG=n);
 *   2) keep secret material (digests, derived pubkeys) out of release logs
 *      using LOG_INF_SAFE / LOG_HEX_SAFE which become no-ops unless
 *      CONFIG_BYEORIN_LOG_SENSITIVE is also enabled.
 *
 * Every translation unit that wants to log must register a module:
 *
 *   #include "log.h"
 *   LOG_MODULE_REGISTER(my_module, CONFIG_LOG_DEFAULT_LEVEL);
 */
#ifndef BYEORIN_LOG_H_
#define BYEORIN_LOG_H_

#include <zephyr/logging/log.h>

#ifdef CONFIG_LOG

#define ND_LOG_INF(...)  LOG_INF(__VA_ARGS__)
#define ND_LOG_WRN(...)  LOG_WRN(__VA_ARGS__)
#define ND_LOG_ERR(...)  LOG_ERR(__VA_ARGS__)
#define ND_LOG_DBG(...)  LOG_DBG(__VA_ARGS__)
#define ND_LOG_HEX(_p,_n,_lbl) LOG_HEXDUMP_DBG((_p),(_n),(_lbl))

#else /* !CONFIG_LOG */

#define ND_LOG_INF(...)  ((void)0)
#define ND_LOG_WRN(...)  ((void)0)
#define ND_LOG_ERR(...)  ((void)0)
#define ND_LOG_DBG(...)  ((void)0)
#define ND_LOG_HEX(_p,_n,_lbl) ((void)0)

#endif /* CONFIG_LOG */

/*
 * "Sensitive" variants. Only emit when explicitly opted-in via Kconfig.
 * Default-off so a production build cannot accidentally leak a digest.
 */
#ifdef CONFIG_BYEORIN_LOG_SENSITIVE
#define ND_LOG_INF_SAFE(...)        ND_LOG_INF(__VA_ARGS__)
#define ND_LOG_HEX_SAFE(_p,_n,_lbl) ND_LOG_HEX((_p),(_n),(_lbl))
#else
#define ND_LOG_INF_SAFE(...)        ((void)0)
#define ND_LOG_HEX_SAFE(_p,_n,_lbl) ((void)0)
#endif

#endif /* BYEORIN_LOG_H_ */
