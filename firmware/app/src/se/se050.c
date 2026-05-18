/*
 * SPDX-License-Identifier: Apache-2.0
 * SECURITY-CRITICAL: changes require security review.
 * 벼린 요세 — SE050 wrapper.
 *
 * NOTE: every function in this file is a stub. Real implementation will
 * delegate to NXP's EdgeLock SE05x Plug & Trust middleware, which we
 * pull into firmware/third_party/se05x/ at the vendor-onboarding step
 * (NDA required). The middleware exposes T=1' over I2C — we point it at
 * the i2c0 node from the devicetree overlay.
 */
#include "se/se050.h"
#include "log.h"

#include <errno.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/i2c.h>

LOG_MODULE_REGISTER(byeorin_se050, CONFIG_LOG_DEFAULT_LEVEL);

/* SE object IDs — these are stable across the device's lifetime and
 * referenced by everything in keys/ and apps/. Layout convention:
 *   0xBADD_SEED         -> single binary object holding the encrypted seed
 *   0xBADD_S1xx         -> per-curve master key handles
 *   0xBADD_ROLLBACK     -> monotonic counter object
 */
#define SE_OID_SEED         0xBADDSEED
#define SE_OID_K1_MASTER    0xBADDS100
#define SE_OID_ED_MASTER    0xBADDS101
#define SE_OID_ROLLBACK     0xBADDR0CB

int se_init(void)
{
	/* TODO: open i2c0, run SE050 OEF reset sequence, fetch UID,
	 *       LOG_INF the SE serial. */
	ND_LOG_INF("se_init (stub)");
	return 0;
}

int se_is_provisioned(bool *out)
{
	if (!out) { return -EINVAL; }
	/* TODO: probe SE_OID_SEED existence. */
	*out = false;
	return 0;
}

int se_generate_seed(void)
{
	/* TODO: invoke SE050 TRNG → BIP39 entropy → master seed.
	 *       Store as PersistentObject SE_OID_SEED with
	 *       policy = "no read, derive only". */
	ND_LOG_WRN("se_generate_seed: not implemented");
	return -ENOSYS;
}

int se_import_seed(const uint8_t *seed, size_t seed_len)
{
	(void)seed; (void)seed_len;
	/* TODO: write seed bytes into SE_OID_SEED, then memset(seed). */
	return -ENOSYS;
}

int se_wipe(void)
{
	/* TODO: delete every PersistentObject owned by us. */
	return -ENOSYS;
}

int se_derive_pubkey(byeorin_se_curve_t curve,
		     const struct byeorin_bip32_path *path,
		     uint8_t *out, size_t out_capacity, size_t *out_len)
{
	(void)curve; (void)path;
	if (!out || !out_len) { return -EINVAL; }
	if (out_capacity < 65) { return -ENOMEM; }
	/* TODO: BIP32 derivation inside SE; export pubkey only. */
	memset(out, 0, out_capacity);
	*out_len = 0;
	return -ENOSYS;
}

int se_sign(byeorin_se_curve_t curve,
	    const struct byeorin_bip32_path *path,
	    const uint8_t digest[32],
	    uint8_t *out_sig, size_t out_capacity, size_t *out_len)
{
	(void)curve; (void)path; (void)digest;
	if (!out_sig || !out_len) { return -EINVAL; }
	if (out_capacity < 64) { return -ENOMEM; }
	/* TODO: invoke SE050 ECDSA/EdDSA sign with the derived child key.
	 *       Enforce low-S for secp256k1 inside the SE policy. */
	*out_len = 0;
	return -ENOSYS;
}

int se_anti_rollback_get(uint32_t *out)
{
	if (!out) { return -EINVAL; }
	/* TODO: read SE_OID_ROLLBACK monotonic counter. */
	*out = 0;
	return 0;
}

int se_anti_rollback_set(uint32_t new_value)
{
	(void)new_value;
	/* TODO: bump counter — only allowed inside the validated upgrade flow,
	 *       and the SE will reject any new_value <= current. */
	return -ENOSYS;
}

/*
 * README-named aliases (see bootloader/README.md "Anti-rollback policy").
 * Kept as thin wrappers so that the spec language and the C symbol names
 * line up under code review — there is no behavioural difference today,
 * but the real implementation may diverge once the SE policy is locked
 * (e.g. _increment may need to take a separate `auth_blob`).
 */
int se_anti_rollback_get_counter(uint32_t *out)
{
	return se_anti_rollback_get(out);
}

int se_anti_rollback_increment(uint32_t new_value)
{
	return se_anti_rollback_set(new_value);
}

int se_attest(const uint8_t *challenge, size_t challenge_len,
	      uint8_t *out_cert, size_t cap, size_t *out_len)
{
	(void)challenge; (void)challenge_len; (void)out_cert; (void)cap;
	if (!out_len) { return -EINVAL; }
	*out_len = 0;
	return -ENOSYS;
}

int se050_apply_keystore(void)
{
	/* TODO: bind vendor middleware's keystore policy descriptor. */
	ND_LOG_INF("se050_apply_keystore (stub) — vendor blob not yet present");
	return -ENOSYS;
}
