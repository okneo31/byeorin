import * as React from 'react';

export interface LogoProps {
  /** Pixel size of the mark. Wordmark variants will scale proportionally. */
  size?: number;
  /** 'mark' = symbol only. 'mark-with-text' = symbol + 벼린 wordmark. */
  variant?: 'mark' | 'mark-with-text';
  /** Optional title for accessibility (default: "벼린"). */
  title?: string;
  /** Optional class on the outer <svg>. */
  className?: string;
}

/**
 * 벼린 — 로고
 *
 * 컨셉: **모루 위의 불꽃** (단조의 순간).
 * - 검정 모루: 옆에서 본 클래식 형태 (뿔 — 윗면 — 받침대).
 * - 오렌지 불꽃: 모루 위에서 솟아오르는 세 갈래. 노랑-주황-빨강 그라데이션.
 * - 원형 프레임: 빨강-오렌지 그라데이션. TTL 코인 로고와 시각적 시리즈성.
 *
 * 16~32px 같은 작은 사이즈에서는 모루의 검정 실루엣 + 불꽃의 오렌지 점이
 * 식별 가능. 더 큰 사이즈에서는 불꽃 그라데이션과 모루 디테일이 살아난다.
 *
 * 모든 모양은 inline SVG bezier 로 그려서 사용자 환경의 폰트/그래픽
 * 라이브러리에 의존하지 않는다. 워드마크 "벼린"만 system Korean font 사용.
 */
export function Logo({
  size = 48,
  variant = 'mark',
  title = '벼린',
  className,
}: LogoProps) {
  const markId = React.useId();
  const titleId = `${markId}-title`;
  const frameGrad = `${markId}-frame`;
  const flameGrad = `${markId}-flame`;
  const flameCore = `${markId}-core`;

  const mark = (
    <g>
      <defs>
        {/* 원형 프레임: 위쪽 옅은 오렌지 → 아래쪽 진한 빨강 */}
        <linearGradient id={frameGrad} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFA040" />
          <stop offset="55%" stopColor="#E84D1A" />
          <stop offset="100%" stopColor="#A53312" />
        </linearGradient>
        {/* 불꽃 본체: 노랑 → 오렌지 → 빨강 */}
        <linearGradient id={flameGrad} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFE082" />
          <stop offset="35%" stopColor="#FF8F00" />
          <stop offset="75%" stopColor="#E84D1A" />
          <stop offset="100%" stopColor="#A53312" />
        </linearGradient>
        {/* 불꽃 핵심부: 흰-노랑 */}
        <radialGradient id={flameCore} cx="0.5" cy="0.7" r="0.5">
          <stop offset="0%" stopColor="#FFF8D6" />
          <stop offset="100%" stopColor="#FFE082" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 원형 프레임 (stroke만, 내부 투명) */}
      <circle
        cx="128"
        cy="128"
        r="118"
        fill="none"
        stroke={`url(#${frameGrad})`}
        strokeWidth="10"
      />

      {/* 모루 — 검정 실루엣, 옆모습 */}
      <g fill="#1A1A1A">
        {/* 윗면 (모루의 평평한 작업면) */}
        <path d="M 70 158 L 186 158 L 186 172 L 70 172 Z" />
        {/* 왼쪽 뿔 (anvil horn) */}
        <path d="M 46 162 L 70 158 L 70 172 L 46 168 Z" />
        {/* 허리 (잘록한 부분) */}
        <path d="M 96 172 L 160 172 L 152 196 L 104 196 Z" />
        {/* 받침대 */}
        <path d="M 76 196 L 180 196 L 174 212 L 82 212 Z" />
      </g>

      {/* 불꽃 — 세 갈래, 모루 위에서 솟아오름 */}
      <path
        d="M 128 62
           C 114 76 112 96 122 112
           C 128 122 130 130 128 142
           C 124 130 122 124 116 116
           C 108 124 106 134 110 144
           C 100 138 96 124 100 110
           C 94 122 94 138 102 150
           L 154 150
           C 162 138 162 122 156 110
           C 160 124 156 138 146 144
           C 150 134 148 124 140 116
           C 134 124 132 130 128 142
           C 126 130 128 122 134 112
           C 144 96 142 76 128 62 Z"
        fill={`url(#${flameGrad})`}
      />

      {/* 불꽃 핵심부 (흰-노랑 빛) */}
      <ellipse cx="128" cy="124" rx="10" ry="22" fill={`url(#${flameCore})`} />

      {/* 스파크 */}
      <circle cx="100" cy="86" r="1.6" fill="#FFE082" opacity="0.8" />
      <circle cx="156" cy="92" r="1.4" fill="#FFE082" opacity="0.75" />
      <circle cx="112" cy="68" r="1.2" fill="#FFE082" opacity="0.6" />
      <circle cx="146" cy="74" r="1.2" fill="#FFE082" opacity="0.65" />
    </g>
  );

  if (variant === 'mark') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 256 256"
        width={size}
        height={size}
        role="img"
        aria-labelledby={titleId}
        className={className}
      >
        <title id={titleId}>{title}</title>
        {mark}
      </svg>
    );
  }

  // mark-with-text: 가로 배치. 한글은 system Korean font 사용.
  const totalWidth = size * (560 / 256);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 560 256"
      width={totalWidth}
      height={size}
      role="img"
      aria-labelledby={titleId}
      className={className}
    >
      <title id={titleId}>{title}</title>
      {mark}
      <text
        x="290"
        y="170"
        fontFamily="var(--nd-font-sans), sans-serif"
        fontSize="124"
        fontWeight="900"
        fill="#1A1A1A"
      >
        벼린
      </text>
    </svg>
  );
}

export default Logo;
