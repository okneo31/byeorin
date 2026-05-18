/**
 * Minimal ether-unit helpers (18 decimals).
 *
 * Why local: we deliberately do not depend on `viem` directly from the mobile
 * app — it's a transitive of `@byeorin/wallet-sdk` and we want chain primitives
 * to flow through the SDK's public API. These two helpers cover the v0.1
 * UI need (display balance, parse a TTL amount input).
 */

const DECIMALS = 18n;
const SCALE = 10n ** DECIMALS;

export function formatTtl(wei: bigint, fractionDigits = 6): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  if (frac === 0n) return `${negative ? '-' : ''}${whole.toString()}`;
  // pad fractional to 18 digits, then truncate
  let fracStr = frac.toString().padStart(Number(DECIMALS), '0');
  if (fractionDigits >= 0 && fractionDigits < Number(DECIMALS)) {
    fracStr = fracStr.slice(0, fractionDigits);
  }
  // strip trailing zeros for readability
  fracStr = fracStr.replace(/0+$/, '');
  if (fracStr.length === 0) return `${negative ? '-' : ''}${whole.toString()}`;
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}

export function parseTtl(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('invalid amount');
  }
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > Number(DECIMALS)) {
    throw new Error('too many decimals');
  }
  const padded = frac.padEnd(Number(DECIMALS), '0');
  return BigInt(whole ?? '0') * SCALE + BigInt(padded || '0');
}
