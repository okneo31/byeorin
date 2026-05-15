/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — EVM-family chain app (Ethereum / TTL / etc).
 *
 * "Apps" are display-and-confirm layers only. They never see the
 * private key. They receive the digest, the human-readable chain
 * label, recipient (hex), and amount (already formatted by the
 * SDK on the host) and decide how to render the confirmation.
 */
#ifndef NODONG_APP_EVM_H_
#define NODONG_APP_EVM_H_

#include <stddef.h>
#include <stdint.h>
#include "ui/confirm.h"

enum nodong_confirm_result evm_app_confirm(const uint8_t *chain_label,
					   size_t chain_label_len,
					   const uint8_t *to,
					   size_t to_len,
					   const uint8_t *amount_str,
					   size_t amount_str_len);

#endif /* NODONG_APP_EVM_H_ */
