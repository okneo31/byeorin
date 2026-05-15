/**
 * AmountDisplay — RN mirror of `@nodong/design-system`'s HTML AmountDisplay.
 *
 * API parity:
 *   value: bigint                  (DS web accepts bigint | string; RN tightened
 *                                   to bigint per prompt — wallet code already
 *                                   holds balances as bigint.)
 *   decimals: number               (same)
 *   symbol?: string                (same)
 *   maxDecimals?: number  (def 6)  (same)
 *   size?: 'sm' | 'md' | 'lg'      (same)
 *
 * Differences (RN-only):
 *   - Drops `showApprox`, `thousandsSeparator`, `className`.
 *
 * Korean thousands separator: tries `Intl.NumberFormat('ko-KR')`. Hermes ships
 * with minimal Intl support — `Intl.NumberFormat` IS available, but only when
 * the app is built with `org.gradle.project.hermesEnableIntl=true` (default on
 * RN 0.74+) and `JSC` builds always have it. We wrap the call in try/catch and
 * fall back to a regex thousands grouper. The arithmetic itself is done in
 * bigint/string to avoid Number-precision loss — locale formatting is purely
 * cosmetic on the integer part.
 */
import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export type AmountSize = 'sm' | 'md' | 'lg';

export interface AmountDisplayProps {
  value: bigint;
  decimals: number;
  symbol?: string;
  maxDecimals?: number;
  size?: AmountSize;
}

const VALUE_SIZE: Record<AmountSize, number> = {
  sm: 14,
  md: 18,
  lg: 26,
};

const SYMBOL_SIZE: Record<AmountSize, number> = {
  sm: 12,
  md: 14,
  lg: 16,
};

function formatUnits(value: bigint, decimals: number): {
  intPart: string;
  fracPart: string;
  negative: boolean;
} {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const s = abs.toString();
  if (decimals <= 0) {
    return { intPart: s, fracPart: '', negative };
  }
  if (s.length <= decimals) {
    const frac = s.padStart(decimals, '0');
    return { intPart: '0', fracPart: frac, negative };
  }
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals);
  return { intPart, fracPart, negative };
}

function withThousandsKo(intPart: string): string {
  // Try Intl.NumberFormat('ko-KR') first — Hermes may or may not have Intl.
  // intPart is unsigned and digits-only.
  try {
    // BigInt path avoids Number rounding for 16+ digit values.
    return new Intl.NumberFormat('ko-KR').format(BigInt(intPart));
  } catch {
    // Fallback: regex thousands grouping. Identical visual result for ko-KR
    // (which uses commas, same as en-US).
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}

export function AmountDisplay({
  value,
  decimals,
  symbol,
  maxDecimals = 6,
  size = 'md',
}: AmountDisplayProps) {
  const { intPart, fracPart, negative } = formatUnits(value, decimals);

  let frac = fracPart;
  if (frac.length > maxDecimals) {
    frac = frac.slice(0, maxDecimals);
  }
  // Strip trailing zeros for readability (matches DS web behavior).
  frac = frac.replace(/0+$/, '');

  const intDisplay = withThousandsKo(intPart);
  const sign = negative ? '-' : '';
  const decimalStr = frac.length > 0 ? `.${frac}` : '';
  const valueText = `${sign}${intDisplay}${decimalStr}`;

  return (
    <View style={styles.row}>
      <Text style={[styles.value, { fontSize: VALUE_SIZE[size] }]}>{valueText}</Text>
      {symbol && (
        <Text style={[styles.symbol, { fontSize: SYMBOL_SIZE[size] }]}>{symbol}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space[1],
  },
  value: {
    fontFamily: theme.font.mono,
    fontWeight: '700',
    color: theme.color.ink,
  },
  symbol: {
    fontFamily: theme.font.korean,
    fontWeight: '600',
    color: theme.color.gray700,
  },
});

export default AmountDisplay;
