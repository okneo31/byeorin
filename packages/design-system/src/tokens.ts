/**
 * 토큰 — TS 미러
 *
 * tokens.css가 단일 진실 소스(SSOT)지만, React Native나 SVG처럼
 * CSS 변수를 쓸 수 없는 타깃에서도 같은 값에 접근할 수 있도록
 * 동일한 값들을 객체로 노출한다.
 */
export const tokens = {
  color: {
    red: '#e84d1a',         // 잉걸 오렌지 — primary action (옛 #c41e1e 대체)
    redHover: '#c73e14',
    redActive: '#a53312',
    black: '#0b0b0d',       // 밤 모루
    yellow: '#f4c430',
    yellowHover: '#d9ac1f',
    paper: '#fafaf7',       // 종이 화이트
    ink: '#1a1a1a',         // 모루 차콜
    gray700: '#3d3d3d',
    gray500: '#7a7a7a',
    gray300: '#c0c0c0',
    gray100: '#ededed',
    gray50: '#f6f5f1',
    success: '#2d6a4f',
    warning: '#e07a00',
    error: '#a53312',
    // Semantic brand aliases (벼린 v2)
    ember: '#e84d1a',
    emberHover: '#c73e14',
    anvil: '#1a1a1a',
    night: '#0b0b0d',
    steel: '#9ca3af',
    sweat: '#2e78d2',
  },
  space: {
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    5: 24,
    6: 32,
    7: 48,
    8: 64,
  },
  radius: {
    sm: 4,
    md: 8,
    lg: 14,
  },
  shadow: {
    1: '0 1px 2px rgba(10, 10, 10, 0.08), 0 1px 1px rgba(10, 10, 10, 0.04)',
    2: '0 4px 12px rgba(10, 10, 10, 0.10), 0 2px 4px rgba(10, 10, 10, 0.06)',
  },
  font: {
    sans:
      '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif',
    mono:
      '"JetBrains Mono", "Cascadia Mono", "Menlo", "Consolas", ui-monospace, monospace',
  },
  fontSize: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 18,
    xl: 22,
    '2xl': 28,
  },
  weight: {
    regular: 400,
    medium: 500,
    bold: 700,
  },
  duration: {
    fast: 120,
    base: 180,
  },
} as const;

export type Tokens = typeof tokens;
