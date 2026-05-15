/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — key derivation facade.
 *
 * This module is a *thin* wrapper around the SE050. Its only purpose
 * is to keep callers out of `se/se050.h` and to enforce a uniform
 * "private keys never leave the SE" rule at the source-tree level:
 * nothing under firmware/app/src/keys/ ever materialises a privkey.
 */
#ifndef NODONG_KEYS_DERIVE_H_
#define NODONG_KEYS_DERIVE_H_

#include "se/se050.h"

/* Convenience: pubkey buffer is whatever the curve dictates. */
int keys_derive_pubkey(nodong_se_curve_t curve,
		       const struct nodong_bip32_path *path,
		       uint8_t *out, size_t out_capacity, size_t *out_len);

int keys_sign_digest(nodong_se_curve_t curve,
		     const struct nodong_bip32_path *path,
		     const uint8_t digest[32],
		     uint8_t *out_sig, size_t out_capacity, size_t *out_len);

/* Parse "m/44'/60'/0'/0/0" style strings into nodong_bip32_path.
 * Hardened components must carry a trailing apostrophe. */
int keys_parse_path_string(const char *s, struct nodong_bip32_path *out);

/* Parse the wire format (N x uint32 big-endian, hardened bit pre-set
 * by the host) into nodong_bip32_path. */
int keys_parse_path_wire(const uint8_t *wire, size_t wire_len,
			 struct nodong_bip32_path *out);

#endif /* NODONG_KEYS_DERIVE_H_ */
