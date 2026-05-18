/*
 * SPDX-License-Identifier: Apache-2.0
 * 벼린 요세 — Cosmos-family chain app.
 */
#ifndef BYEORIN_APP_COSMOS_H_
#define BYEORIN_APP_COSMOS_H_

#include <stddef.h>
#include <stdint.h>
#include "ui/confirm.h"

enum byeorin_confirm_result cosmos_app_confirm(const uint8_t *chain_label,
					      size_t chain_label_len,
					      const uint8_t *to_bech32,
					      size_t to_len,
					      const uint8_t *amount_str,
					      size_t amount_str_len);

#endif /* BYEORIN_APP_COSMOS_H_ */
