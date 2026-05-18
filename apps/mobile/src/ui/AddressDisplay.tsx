/**
 * AddressDisplay — RN mirror of `@byeorin/design-system`'s HTML AddressDisplay.
 *
 * API parity:
 *   address: string                (same)
 *   head?: number  (default 6)     (same)
 *   tail?: number  (default 4)     (same)
 *   onCopy?: () => void            (same; web passes `(address) => void`,
 *                                   the prompt asks for `() => void` — we keep
 *                                   the simpler RN signature.)
 *   copyLabel?: string             (same)
 *
 * Differences (RN-only):
 *   - Drops `copyable` (always tappable; tap the address itself to copy).
 *   - Drops `copiedLabel` (the prompt's API doesn't include it) — we surface
 *     the copied state via the `onCopy` callback, leaving the toast to the
 *     caller. A local "복사됨" indicator is shown briefly so the user gets
 *     feedback without forcing the caller to wire an Alert.
 *
 * Clipboard: uses `Clipboard.setString` from react-native core. It is marked
 * `@deprecated` since RN 0.66 (extracted to `@react-native-clipboard/clipboard`)
 * but still ships and works in RN 0.76. The prompt explicitly forbids adding
 * the new dep, so we use the legacy export and accept the deprecation warning.
 */
import * as React from 'react';
// eslint-disable-next-line @typescript-eslint/no-deprecated -- core Clipboard
// is intentionally used; see file header.
import { Clipboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export interface AddressDisplayProps {
  address: string;
  head?: number;
  tail?: number;
  onCopy?: () => void;
  copyLabel?: string;
}

function truncate(addr: string, head: number, tail: number): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function AddressDisplay({
  address,
  head = 6,
  tail = 4,
  onCopy,
  copyLabel = '복사',
}: AddressDisplayProps) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = React.useCallback(() => {
    try {
      Clipboard.setString(address);
      setCopied(true);
      onCopy?.();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent: legacy Clipboard may be unavailable on some forks. The caller's
      // onCopy is not invoked in that case.
    }
  }, [address, onCopy]);

  const shown = truncate(address, head, tail);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${address}, ${copyLabel}`}
      onPress={handleCopy}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Text style={styles.address} numberOfLines={1}>
        {shown}
      </Text>
      <View style={styles.copyBadge}>
        <Text style={styles.copyLabel}>{copied ? '복사됨' : copyLabel}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space[2],
    paddingVertical: theme.space[1],
    paddingHorizontal: theme.space[2],
    borderRadius: theme.radius.sm,
  },
  rowPressed: {
    backgroundColor: theme.color.gray100,
  },
  address: {
    fontFamily: theme.font.mono,
    fontSize: 14,
    color: theme.color.ink,
  },
  copyBadge: {
    paddingHorizontal: theme.space[2],
    paddingVertical: theme.space[1],
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.gray100,
  },
  copyLabel: {
    fontFamily: theme.font.korean,
    fontSize: 12,
    color: theme.color.gray700,
    fontWeight: '600',
  },
});

export default AddressDisplay;
