/*
 * SPDX-License-Identifier: Apache-2.0
 * 노동자의 지갑 Cold — key derivation facade.
 *
 * Intentionally minimal: this is the seam where "key path semantics"
 * (BIP32, SLIP10) meet "SE-bound secrets". The SE does the maths.
 */
#include "keys/derive.h"
#include "log.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

LOG_MODULE_REGISTER(nodong_keys, CONFIG_LOG_DEFAULT_LEVEL);

int keys_derive_pubkey(nodong_se_curve_t curve,
		       const struct nodong_bip32_path *path,
		       uint8_t *out, size_t out_capacity, size_t *out_len)
{
	return se_derive_pubkey(curve, path, out, out_capacity, out_len);
}

int keys_sign_digest(nodong_se_curve_t curve,
		     const struct nodong_bip32_path *path,
		     const uint8_t digest[32],
		     uint8_t *out_sig, size_t out_capacity, size_t *out_len)
{
	return se_sign(curve, path, digest, out_sig, out_capacity, out_len);
}

int keys_parse_path_wire(const uint8_t *wire, size_t wire_len,
			 struct nodong_bip32_path *out)
{
	if (!wire || !out) { return -EINVAL; }
	if ((wire_len % 4) != 0 || wire_len == 0) { return -EINVAL; }
	size_t n = wire_len / 4;
	if (n > 10) { return -E2BIG; }
	out->length = (uint8_t)n;
	for (size_t i = 0; i < n; i++) {
		size_t o = i * 4;
		out->components[i] =
			((uint32_t)wire[o]     << 24) |
			((uint32_t)wire[o + 1] << 16) |
			((uint32_t)wire[o + 2] <<  8) |
			((uint32_t)wire[o + 3]);
	}
	return 0;
}

int keys_parse_path_string(const char *s, struct nodong_bip32_path *out)
{
	if (!s || !out) { return -EINVAL; }
	if (s[0] != 'm' || (s[1] != '/' && s[1] != '\0')) { return -EINVAL; }
	out->length = 0;
	if (s[1] == '\0') { return 0; }
	s += 2;

	while (*s) {
		if (out->length >= 10) { return -E2BIG; }
		char *end;
		unsigned long v = strtoul(s, &end, 10);
		if (end == s) { return -EINVAL; }
		s = end;
		uint32_t comp = (uint32_t)v;
		if (*s == '\'') { comp |= 0x80000000u; s++; }
		out->components[out->length++] = comp;
		if (*s == '/') { s++; }
		else if (*s != '\0') { return -EINVAL; }
	}
	return 0;
}
