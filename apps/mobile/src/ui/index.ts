/**
 * RN UI primitives for `apps/mobile`. Mirrors the API of `@byeorin/design-system`
 * HTML components where the shapes translate cleanly to React Native.
 *
 * These are deliberately NOT shared with web/desktop — they depend on RN core
 * primitives (Pressable, TextInput, View, StyleSheet) that don't exist outside
 * React Native.
 */
export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { Card } from './Card';
export type { CardProps, CardElevation } from './Card';

export { Input } from './Input';
export type { InputProps } from './Input';

export { AddressDisplay } from './AddressDisplay';
export type { AddressDisplayProps } from './AddressDisplay';

export { AmountDisplay } from './AmountDisplay';
export type { AmountDisplayProps, AmountSize } from './AmountDisplay';
