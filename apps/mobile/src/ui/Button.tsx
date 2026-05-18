/**
 * Button — RN mirror of `@byeorin/design-system`'s HTML Button.
 *
 * API parity with the web DS Button:
 *   variant: 'primary' | 'secondary' | 'ghost' | 'danger'   (same)
 *   size:    'sm' | 'md' | 'lg'                             (same)
 *   loading: boolean                                        (same)
 *   disabled: boolean                                       (same)
 *   children: ReactNode                                     (same)
 *
 * Differences (RN-only):
 *   - `onPress` instead of HTML `onClick`.
 *   - `fullWidth` added (HTML defaults to inline-flex; RN defaults to block-ish
 *     because the Pressable hugs its content — fullWidth gives back the
 *     auto-stretch behavior callers usually want on mobile).
 *   - Drops `leadingIcon`/`trailingIcon` (out of scope for v0.1 — the screens
 *     don't use them).
 *   - Drops HTML pass-through props (type, aria-*, name, form, ...).
 *
 * All Korean labels are caller-provided via `children`.
 */
import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { theme } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  children: React.ReactNode;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
}

// Hardcoded font sizes. The DS exports `fontSize.{sm,md,lg}` = 14/16/18 but the
// mobile `theme.ts` re-export does not surface fontSize yet. Mirror those exact
// values so a future theme update (adding `fontSize`) can drop the hardcoding.
const FONT_SIZE: Record<ButtonSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
};

const PADDING_V: Record<ButtonSize, number> = {
  sm: theme.space[2], // 8
  md: theme.space[3], // 12
  lg: theme.space[4], // 16
};

const PADDING_H: Record<ButtonSize, number> = {
  sm: theme.space[3], // 12
  md: theme.space[4], // 16
  lg: theme.space[5], // 24
};

export function Button({
  children,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        {
          paddingVertical: PADDING_V[size],
          paddingHorizontal: PADDING_H[size],
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          width: fullWidth ? '100%' : undefined,
        },
        variantContainerStyle(variant, pressed && !isDisabled),
        isDisabled && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variantSpinnerColor(variant)} />
      ) : (
        // Wrap children in a View so callers can pass a string OR multiple
        // nodes (e.g. icon + label) without RN complaining about a raw string.
        <View style={styles.contentRow}>
          {typeof children === 'string' || typeof children === 'number' ? (
            <Text
              style={[
                styles.labelBase,
                { fontSize: FONT_SIZE[size] },
                variantTextStyle(variant),
              ]}
            >
              {children}
            </Text>
          ) : (
            children
          )}
        </View>
      )}
    </Pressable>
  );
}

function variantContainerStyle(variant: ButtonVariant, pressed: boolean): ViewStyle {
  switch (variant) {
    case 'primary':
      return {
        backgroundColor: pressed ? theme.color.redActive : theme.color.red,
      };
    case 'secondary':
      return {
        backgroundColor: pressed ? theme.color.gray100 : theme.color.paper,
        borderWidth: 1,
        borderColor: theme.color.red,
      };
    case 'ghost':
      return {
        backgroundColor: pressed ? theme.color.gray100 : 'transparent',
      };
    case 'danger':
      // DS `error` is the same hex as `redHover`; use redHover→redActive cascade
      // for the pressed state to stay consistent with primary's contract.
      return {
        backgroundColor: pressed ? theme.color.redActive : theme.color.error,
      };
  }
}

function variantTextStyle(variant: ButtonVariant): TextStyle {
  switch (variant) {
    case 'primary':
    case 'danger':
      // Pure white on brand red. DS `paper` (#fffaf0) is too warm here — same
      // call the existing screens make for their inline primary buttons.
      return { color: '#ffffff', fontWeight: '700' };
    case 'secondary':
    case 'ghost':
      return { color: theme.color.red, fontWeight: '600' };
  }
}

function variantSpinnerColor(variant: ButtonVariant): string {
  switch (variant) {
    case 'primary':
    case 'danger':
      return '#ffffff';
    case 'secondary':
    case 'ghost':
      return theme.color.red;
  }
}

const styles = StyleSheet.create({
  base: {
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
  },
  labelBase: {
    fontFamily: theme.font.korean,
    textAlign: 'center',
  },
  disabled: {
    opacity: 0.4,
  },
});

export default Button;
