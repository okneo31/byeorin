/**
 * Card — RN mirror of `@nodong/design-system`'s HTML Card.
 *
 * API parity:
 *   elevation: 'flat' | 'default' | 'elevated'   (same)
 *   children: ReactNode                          (same)
 *
 * Differences (RN-only):
 *   - Drops `as` (semantic HTML tag). Everything is a View.
 *   - Drops HTML `className` / data-* pass-through.
 *   - Adds optional `style` so screens can compose layout (margins/flex) on top
 *     without subclassing.
 *
 * Shadow note: RN requires BOTH `shadowColor`/`shadowOffset`/`shadowOpacity`/
 * `shadowRadius` (iOS) AND `elevation` (Android) to render a shadow. Setting
 * only one results in no shadow on the other platform.
 */
import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { theme } from '../theme';

export type CardElevation = 'flat' | 'default' | 'elevated';

export interface CardProps {
  children: React.ReactNode;
  elevation?: CardElevation;
  style?: ViewStyle;
}

export function Card({ children, elevation = 'default', style }: CardProps) {
  return (
    <View style={[styles.base, elevationStyle(elevation), style]}>{children}</View>
  );
}

function elevationStyle(elevation: CardElevation): ViewStyle {
  switch (elevation) {
    case 'flat':
      return {
        borderRadius: theme.radius.md,
      };
    case 'default':
      return {
        borderRadius: theme.radius.md,
        // iOS shadow.
        shadowColor: theme.color.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 2,
        // Android shadow.
        elevation: 2,
      };
    case 'elevated':
      return {
        borderRadius: theme.radius.lg,
        // iOS shadow.
        shadowColor: theme.color.black,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 12,
        // Android shadow.
        elevation: 6,
      };
  }
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: theme.color.paper,
    padding: theme.space[4],
  },
});

export default Card;
