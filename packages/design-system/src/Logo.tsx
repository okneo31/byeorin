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
 * 컨셉: 동전을 받쳐 든 펼친 손. 빨강(활동가)·노랑(동전)·검정(잉크) 삼색으로
 * 80년대 한국 민중미술 포스터의 단단한 인장(印章) 느낌을 따른다.
 * 사각 인장 안에 손바닥 윤곽 + 가운데 동전(TTL).
 *
 * 16/32/48/128px 모두에서 윤곽이 또렷하도록 stroke 비율을 viewBox(64)
 * 기준으로 고정했다.
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
      {/* 인장(stamp) 배경 — 따뜻한 종이 위에 빨강 사각 */}
      <rect x="2" y="2" width="60" height="60" rx="10" fill="var(--nd-red, #c41e1e)" />
      <rect
        x="5"
        y="5"
        width="54"
        height="54"
        rx="8"
        fill="none"
        stroke="var(--nd-paper, #fffaf0)"
        strokeWidth="1.5"
        opacity="0.6"
      />

      {/* 손바닥 — 단순화된 4지 + 엄지. 위로 펼친 손이 동전을 받친다. */}
      <path
        d="M20 44
           V30
           a3 3 0 0 1 6 0
           V22
           a3 3 0 0 1 6 0
           V20
           a3 3 0 0 1 6 0
           V24
           a3 3 0 0 1 6 0
           V40
           a10 10 0 0 1 -2 6
           H22
           a2 2 0 0 1 -2 -2 Z"
        fill="var(--nd-paper, #fffaf0)"
        stroke="var(--nd-black, #0a0a0a)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* 동전 — 손 위에 놓인 노란 원, TTL 각인 자리 */}
      <circle
        cx="32"
        cy="20"
        r="6"
        fill="var(--nd-yellow, #f4c430)"
        stroke="var(--nd-black, #0a0a0a)"
        strokeWidth="1.5"
      />
      <text
        x="32"
        y="22.5"
        textAnchor="middle"
        fontFamily="var(--nd-font-sans), sans-serif"
        fontSize="6"
        fontWeight="700"
        fill="var(--nd-black, #0a0a0a)"
      >
        ₩
      </text>
    </g>
  );

  if (variant === 'mark') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 64 64"
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

  // mark-with-text: 가로 배치. 워드마크 폭은 대략 mark의 4배.
  const totalWidth = size * 4.2;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 268 64"
      width={totalWidth}
      height={size}
      role="img"
      aria-labelledby={titleId}
      className={className}
    >
      <title id={titleId}>{title}</title>
      {mark}
      <text
        x="76"
        y="42"
        fontFamily="var(--nd-font-sans), sans-serif"
        fontSize="28"
        fontWeight="700"
        fill="var(--nd-black, #0a0a0a)"
      >
        노동자의 지갑
      </text>
    </svg>
  );
}

export default Logo;
