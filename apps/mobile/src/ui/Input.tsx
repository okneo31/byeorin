/**
 * Input — RN mirror of `@byeorin/design-system`'s HTML Input.
 *
 * API parity:
 *   label?: string                         (same; web accepts ReactNode, RN string)
 *   hint?: string                          (same)
 *   error?: string                         (same; web accepts ReactNode, RN string)
 *   mono?: boolean                         (same)
 *
 * Differences (RN-only):
 *   - `value` + `onChangeText` replace HTMLInput's value/onChange/defaultValue.
 *     RN's TextInput uses `onChangeText: (text: string) => void`.
 *   - Adds RN TextInput props: `multiline`, `numberOfLines`, `keyboardType`,
 *     `autoCapitalize`, `autoCorrect`, `secureTextEntry`.
 *   - Drops HTML pass-through (`type`, `name`, `pattern`, `inputMode`, ...).
 *
 * Error visual: red border + red error message below.
 * Korean font is applied by default; `mono` switches to the monospace stack.
 */
import * as React from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
} from 'react-native';
import { theme } from '../theme';

export interface InputProps {
  label?: string;
  hint?: string;
  error?: string;
  mono?: boolean;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  numberOfLines?: number;
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'decimal-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  secureTextEntry?: boolean;
}

export function Input({
  label,
  hint,
  error,
  mono = false,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  numberOfLines,
  keyboardType = 'default',
  autoCapitalize = 'sentences',
  autoCorrect = true,
  secureTextEntry = false,
}: InputProps) {
  const hasError = Boolean(error);

  return (
    <View style={styles.field}>
      {label && <Text style={styles.label}>{label}</Text>}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.color.gray500}
        // RN inherits autoCorrect/spellCheck differently per platform; pin both
        // when the caller turns it off (addresses, mnemonics, hashes).
        autoCorrect={autoCorrect}
        spellCheck={autoCorrect}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType as KeyboardTypeOptions}
        multiline={multiline}
        numberOfLines={multiline ? numberOfLines : undefined}
        style={[
          styles.input,
          mono ? styles.inputMono : styles.inputKorean,
          multiline && styles.inputMultiline,
          hasError && styles.inputError,
        ]}
        // Multiline TextInput on Android centers text vertically by default;
        // top-align makes long input read like a textarea (matches Home.tsx).
        textAlignVertical={multiline ? 'top' : 'auto'}
        accessibilityLabel={label}
        accessibilityHint={hint}
      />
      {hasError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : (
        hint && <Text style={styles.hint}>{hint}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: theme.space[1],
  },
  label: {
    color: theme.color.gray700,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: theme.font.korean,
    marginBottom: theme.space[1],
  },
  input: {
    borderWidth: 1,
    borderColor: theme.color.gray300,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.paper,
    color: theme.color.ink,
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[3],
    fontSize: 15,
  },
  inputKorean: {
    fontFamily: theme.font.korean,
  },
  inputMono: {
    fontFamily: theme.font.mono,
  },
  inputMultiline: {
    minHeight: 96,
  },
  inputError: {
    borderColor: theme.color.error,
  },
  hint: {
    color: theme.color.gray500,
    fontSize: 12,
    fontFamily: theme.font.korean,
    marginTop: theme.space[1],
  },
  error: {
    color: theme.color.error,
    fontSize: 12,
    fontFamily: theme.font.korean,
    marginTop: theme.space[1],
  },
});

export default Input;
