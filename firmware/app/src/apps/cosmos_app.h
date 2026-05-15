/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — Cosmos-family chain app.
 */
#ifndef NODONG_APP_COSMOS_H_
#define NODONG_APP_COSMOS_H_

#include <stddef.h>
#include <stdint.h>
#include "ui/confirm.h"

enum nodong_confirm_result cosmos_app_confirm(const uint8_t *chain_label,
					      size_t chain_label_len,
					      const uint8_t *to_bech32,
					      size_t to_len,
					      const uint8_t *amount_str,
					      size_t amount_str_len);

#endif /* NODONG_APP_COSMOS_H_ */
