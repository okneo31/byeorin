/*
 * SPDX-License-Identifier: Apache-2.0
 * SECURITY-CRITICAL: changes require security review.
 * 노동자의 지갑 Cold — NXP SE050 wrapper.
 *
 * This is the *only* layer that talks to the secure element. Higher
 * layers (keys/, apps/) call into this interface and never see raw
 * NXP types.
 *
 * Underlying vendor middleware: "EdgeLock SE05x Plug & Trust Middleware".
 * Its sources are *not* committed here — they will live under
 * firmware/third_party/se05x/ (pulled at vendor-onboarding time) and
 * be linked from app/CMakeLists.txt.
 *
 * Curves matched to packages/wallet-sdk/ChainAdapter expectations:
 *   - secp256k1 -> EVM / TTL / BTC ECDSA
 *   - ed25519   -> Cosmos / Solana
 *   - secp256r1 -> attestation only
 */
#ifndef NODONG_SE050_H_
#define NODONG_SE050_H_

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef enum {
	NODONG_SE_CURVE_SECP256K1 = 0,
	NODONG_SE_CURVE_ED25519   = 1,
	NODONG_SE_CURVE_SECP256R1 = 2,
} nodong_se_curve_t;

/* BIP32 path encoded as up-to-10 hardened/unhardened components.
 * Caller is responsible for setting the hardened bit (0x80000000). */
struct nodong_bip32_path {
	uint8_t  length;       /* number of components used */
	uint32_t components[10];
};

/* Lifecycle */
int  se_init(void);
int  se_is_provisioned(bool *out);

/*
 * Seed lifecycle. Both forms write the seed into a SE050 PersistentObject
 * with a fixed object ID. Once stored the MCU has no further access to
 * the raw seed.
 */
int  se_generate_seed(void);
int  se_import_seed(const uint8_t *seed, size_t seed_len);
int  se_wipe(void);

/*
 * Derive the public key for `curve` + `path`. Output format:
 *   secp256k1/secp256r1 : 65-byte uncompressed (0x04 || X || Y)
 *   ed25519             : 32-byte raw A
 * `out_capacity` must be large enough; on success *out_len is set.
 */
int  se_derive_pubkey(nodong_se_curve_t curve,
		      const struct nodong_bip32_path *path,
		      uint8_t *out, size_t out_capacity, size_t *out_len);

/*
 * Sign a 32-byte digest. Output format:
 *   secp256k1/secp256r1 : 64-byte (R || S), low-S enforced by SE
 *   ed25519             : 64-byte (R || S)
 */
int  se_sign(nodong_se_curve_t curve,
	     const struct nodong_bip32_path *path,
	     const uint8_t digest[32],
	     uint8_t *out_sig, size_t out_capacity, size_t *out_len);

/*
 * Monotonic counter used for anti-rollback in the bootloader.
 * Reads only; writes happen during validated firmware-upgrade flow.
 *
 * Two naming conventions live in the tree:
 *   - se_anti_rollback_get / _set  : terse, used by app code
 *   - se_anti_rollback_get_counter / _increment : as named in
 *     bootloader/README.md and referenced by the early-boot
 *     anti-rollback hook spec.
 * Both names refer to the same underlying SE object SE_OID_ROLLBACK;
 * the *_increment form additionally enforces strict-monotonic semantics
 * inside the SE policy (any new_value <= current is rejected by the SE).
 */
int  se_anti_rollback_get(uint32_t *out);
int  se_anti_rollback_set(uint32_t new_value);
int  se_anti_rollback_get_counter(uint32_t *out);
int  se_anti_rollback_increment(uint32_t new_value);

/* Attestation (signed device-identity certificate). */
int  se_attest(const uint8_t *challenge, size_t challenge_len,
	       uint8_t *out_cert, size_t cap, size_t *out_len);

/* Apply / refresh the SE keystore policy. Stub today — calls into the
 * vendor middleware's `se050_apply_keystore` once integrated. */
int  se050_apply_keystore(void);

#endif /* NODONG_SE050_H_ */
