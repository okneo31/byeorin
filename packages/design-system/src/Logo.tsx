import * as React from 'react';

export interface LogoProps {
  /** Pixel size of the mark. Wordmark variants will scale proportionally. */
  size?: number;
  /** 'mark' = symbol only. 'mark-with-text' = symbol + 노동자의 지갑 wordmark. */
  variant?: 'mark' | 'mark-with-text';
  /** Optional title for accessibility (default: "노동자의 지갑"). */
  title?: string;
  /** Optional class on the outer <svg>. */
  className?: string;
}

/**
 * 노동자의 지갑 — 로고
 *
 * 컨셉: 조선 시대 인장(印章) — 둥근 사각 도장 안에 "ㄴ"(노동의 첫 자모).
 * 손으로 찍은 듯한 미세한 윤곽 흔들림 + 우측 상단 노란 점(印朱) 악센트로
 * 민중미술 포스터의 단단함과 문서 도장의 권위를 동시에 갖는다.
 *
 * "ㄴ"은 bezier 패스로 직접 그려서 사용자 머신의 한글 폰트가 없어도 항상
 * 같은 모양으로 렌더된다 (완벽주의자는 전용 타이포그래퍼 패스를 권장).
 */
export function Logo({
  size = 48,
  variant = 'mark',
  title = '노동자의 지갑',
  className,
}: LogoProps) {
  const markId = React.useId();
  const titleId = `${markId}-title`;

  const mark = (
    <g>
      {/* Stamp body: rounded square with hand-stamped wobble. */}
      <path
        d="M 56 22
           C 80 18 178 18 200 24
           C 232 30 236 56 236 80
           C 240 110 240 152 234 178
           C 230 210 206 234 178 236
           C 148 240 104 240 78 234
           C 48 232 22 208 20 178
           C 16 148 16 104 22 78
           C 26 48 32 26 56 22 Z"
        fill="var(--nd-red, #c41e1e)"
      />

      {/* Inner hairline ring — "ink edge" feel */}
      <path
        d="M 64 36
           C 86 32 172 32 192 38
           C 218 42 220 64 220 84
           C 224 110 224 148 218 172
           C 214 200 196 218 172 220
           C 146 224 110 224 84 218
           C 58 216 38 196 36 172
           C 32 146 32 108 38 86
           C 42 60 46 38 64 36 Z"
        fill="none"
        stroke="var(--nd-paper, #fffaf0)"
        strokeWidth="2"
        opacity="0.45"
      />

      {/* ㄴ jamo — bezier path (no font dependency). */}
      <path
        d="M 88 64
           C 86 62 84 64 84 68
           L 84 178
           C 84 188 90 192 100 192
           L 184 192
           C 192 192 194 188 192 180
           L 188 168
           C 186 162 180 160 172 160
           L 110 160
           C 104 160 102 156 102 150
           L 102 72
           C 102 66 96 62 88 64 Z"
        fill="var(--nd-paper, #fffaf0)"
      />

      {/* Yellow accent (印朱) — small dot top-right */}
      <circle cx="200" cy="68" r="8" fill="var(--nd-yellow, #f4c430)" />
      <circle cx="200" cy="68" r="3" fill="var(--nd-red, #c41e1e)" />
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

  // mark-with-text: 가로 배치. mark 256 wide + 워드마크 영역.
  const totalWidth = size * 4.2;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1075 256"
      width={totalWidth}
      height={size}
      role="img"
      aria-labelledby={titleId}
      className={className}
    >
      <title id={titleId}>{title}</title>
      {mark}
      <text
        x="296"
        y="170"
        fontFamily="var(--nd-font-sans), sans-serif"
        fontSize="112"
        fontWeight="700"
        fill="var(--nd-black, #0a0a0a)"
      >
        노동자의 지갑
      </text>
    </svg>
  );
}

export default Logo;
