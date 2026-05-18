/**
 * Brand tokens for 벼린 (mobile shell).
 *
 * Single source of truth: `@byeorin/design-system`'s TS token mirror.
 * The CSS tokens (`tokens.css`) are useless in React Native; we consume the
 * JS mirror so that color/space/radius values stay aligned with the web app.
 *
 * Exports:
 *   - `theme` (new) — flattened DS tokens (color/space/radius/font), used by
 *                     new code and the local `src/ui/*` primitives.
 *   - `colors`, `radius`, `spacing` (legacy) — semantic dark-theme aliases used
 *                     by existing screens. Where possible they point at DS
 *                     tokens; for keys with no DS equivalent (the dark surface
 *                     chrome) we keep the local value and mark a TODO.
 *
 * TODO(design-system): the DS currently only ships a light palette (paper/ink
 *   + neutrals). Once a dark theme lands upstream, drop the local fallbacks
 *   below (bg/surface/surfaceAlt/border/text/textMuted) and source those from
 *   DS too.
 *
 * TODO(ui-primitives): RN-compatible Button/Card/Input live in `src/ui/`.
 *   They mirror the HTML component API from `@byeorin/design-system` but use
 *   RN primitives. Screens may migrate to them incrementally.
 */
import { tokens } from '@byeorin/design-system';

/**
 * Flattened DS-sourced theme. Prefer this for new code.
 *
 * Font handling note: React Native does not understand CSS font stacks. We
 * collapse the DS Korean stack to `'System'` (iOS resolves to Apple SD Gothic
 * Neo; Android resolves to Noto Sans CJK KR / Roboto) and the mono stack to
 * `'Menlo'` (iOS default mono; Android falls back to its platform monospace).
 * Loading Pretendard or JetBrains Mono requires dropping the font files into
 * `ios/<App>/Fonts` + `Info.plist` and `android/app/src/main/assets/fonts/` and
 * is out of scope for v0.1.
 */
export const theme = {
  color: {
    red: tokens.color.red,
    redHover: tokens.color.redHover,
    redActive: tokens.color.redActive,
    black: tokens.color.black,
    yellow: tokens.color.yellow,
    yellowHover: tokens.color.yellowHover,
    paper: tokens.color.paper,
    ink: tokens.color.ink,
    gray100: tokens.color.gray100,
    gray300: tokens.color.gray300,
    gray500: tokens.color.gray500,
    gray700: tokens.color.gray700,
    success: tokens.color.success,
    warning: tokens.color.warning,
    error: tokens.color.error,
  },
  space: tokens.space, // { 1:4, 2:8, 3:12, 4:16, 5:24, 6:32, 7:48, 8:64 }
  radius: tokens.radius, // { sm:4, md:8, lg:14 }
  font: {
    // RN's 'System' picks Apple SD Gothic Neo on iOS and Noto Sans CJK KR on
    // modern Android — both render Korean well.
    korean: 'System',
    // Built-in mono on iOS; Android falls back to its monospace family.
    mono: 'Menlo',
  },
} as const;

/**
 * Legacy semantic dark-theme palette. Backed by DS tokens where possible.
 *
 * Kept for the existing screens that destructure { colors, radius, spacing }.
 * New code should consume `theme` directly.
 */
export const colors = {
  // TODO(design-system): no dark-surface tokens in DS yet — local values.
  bg: '#0f0f10',
  surface: '#1a1a1c',
  surfaceAlt: '#232327',
  border: '#2e2e33',
  text: '#f4f4f4',
  textMuted: '#a0a0a8',

  // Brand red, sourced from DS.
  primary: theme.color.red, //        was '#c8202a'
  primaryPressed: theme.color.redActive, // was '#9a1820'

  // Warn/error/success sourced from DS. Note: DS values target a light bg so
  // they're darker than the previous dark-theme values. Acceptable contrast on
  // our near-black surfaces; revisit when DS ships a dark theme.
  warn: theme.color.yellow, //        was '#f5a623'
  error: theme.color.error, //        was '#ff4d4f'
  success: theme.color.success, //    was '#3fb950'
} as const;

/**
 * Legacy radius. Same names, sourced from DS.
 *   sm: 4 (was 6), md: 8 (was 10), lg: 14 (unchanged).
 */
export const radius = theme.radius;

/**
 * Legacy spacing → DS scale.
 *   xs: 4 (was 4),  sm: 8 (was 8), md: 12 (was 12),
 *   lg: 16 (was 16), xl: 24 (was 24)
 * The DS scale is denser (1=4, 2=8, ...); the mapping below preserves the
 * legacy values exactly so existing layouts don't shift.
 */
export const spacing = {
  xs: theme.space[1],
  sm: theme.space[2],
  md: theme.space[3],
  lg: theme.space[4],
  xl: theme.space[5],
} as const;
