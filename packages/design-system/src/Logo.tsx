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
 * 컨셉: 광부의 곡괭이 두 자루를 X 자로 교차시킨 미니어즈 길드(miners' guild) 인장.
 * 빨간 도장 위 흰 곡괭이 — 채굴(=mining 의 이중 의미)과 노동의 힘듦을, 그 위에 튀는
 * 스파크(노란 인주 한 점 + 흰 점)로 강조한다. 햄머-시클 같은 차용 없이도 노동의
 * 정체성을 드러내려는 의도.
 *
 * 16×16 픽셀에서도 빨간 둥근 사각형 + 흰 X 의 실루엣으로 식별된다. 더 큰 사이즈에서는
 * pick(긴 첨두) 과 chisel(짧은 끌) 의 비대칭, 자루의 나뭇결 음영, 스파크가 보인다.
 *
 * 모든 모양은 inline SVG bezier 로 그려서 사용자 환경의 폰트/그래픽 라이브러리에
 * 의존하지 않는다. 워드마크 한글("벼린") 만 system Korean font 에 의존하는데,
 * 이는 popup/web 환경 모두 Pretendard/Malgun/Apple SD Gothic Neo 가 보장된다.
 */
export function Logo({
  size = 48,
  variant = 'mark',
  title = '벼린',
  className,
}: LogoProps) {
  const markId = React.useId();
  const titleId = `${markId}-title`;
  const pickaxeId = `${markId}-pickaxe`;

  // Unit pickaxe: handle on -X side, head on +X side.
  // PICK (long sharp tip) extends in -Y direction (~85u). CHISEL (short wedge) extends in +Y (~50u).
  // 손 도장 느낌을 위해 자루 가장자리에 미세한 베지에 흔들림.
  const pickaxe = (
    <g id={pickaxeId}>
      <path
        d="M -100 -8 C -96 -11 -50 -10 0 -10 C 30 -10 56 -9 72 -7 L 72 7 C 56 9 30 10 0 10 C -50 10 -96 11 -100 8 C -103 6 -103 -6 -100 -8 Z"
        fill="var(--nd-paper, #fffaf0)"
      />
      <path
        d="M -88 0 C -50 -2 0 -1 60 0"
        stroke="var(--nd-red, #c41e1e)"
        strokeWidth="1.3"
        opacity="0.25"
        fill="none"
      />
      <path
        d="M -98 -6 C -100 -2 -100 2 -98 6"
        stroke="var(--nd-red, #c41e1e)"
        strokeWidth="1.2"
        opacity="0.28"
        fill="none"
      />
      <path
        d="M 78 -86 L 96 -76 C 100 -54 100 -28 100 -8 C 106 -6 108 -2 108 0 C 108 2 106 6 100 8 C 100 26 102 46 104 56 L 88 62 L 76 36 L 70 12 L 66 0 L 70 -12 L 76 -36 L 78 -86 Z"
        fill="var(--nd-paper, #fffaf0)"
      />
    </g>
  );

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

      <defs>{pickaxe}</defs>

      {/* Pickaxe 1: head upper-right */}
      <g transform="translate(128 134) rotate(-45) scale(0.82)">
        <use href={`#${pickaxeId}`} />
      </g>
      {/* Pickaxe 2: head upper-left */}
      <g transform="translate(128 134) rotate(-135) scale(0.82)">
        <use href={`#${pickaxeId}`} />
      </g>

      {/* Sparks above the strike point — 채굴의 힘듦/불꽃 */}
      <circle cx="128" cy="58" r="6" fill="var(--nd-yellow, #f4c430)" />
      <circle cx="128" cy="58" r="2" fill="var(--nd-red, #c41e1e)" />
      <circle cx="102" cy="50" r="3" fill="var(--nd-paper, #fffaf0)" opacity="0.92" />
      <circle cx="154" cy="50" r="3" fill="var(--nd-paper, #fffaf0)" opacity="0.92" />
      <circle cx="120" cy="38" r="1.8" fill="var(--nd-paper, #fffaf0)" opacity="0.75" />
      <circle cx="136" cy="38" r="1.8" fill="var(--nd-paper, #fffaf0)" opacity="0.75" />
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

  // mark-with-text: 가로 배치. 256-wide mark + Korean wordmark slot.
  // 한글은 시스템 폰트(Pretendard/Malgun/Apple SD)로 렌더 — runtime DOM SVG 라
  // 항상 사용자의 OS Korean font 가 보장된다.
  const totalWidth = size * (800 / 256);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 800 256"
      width={totalWidth}
      height={size}
      role="img"
      aria-labelledby={titleId}
      className={className}
    >
      <title id={titleId}>{title}</title>
      {mark}
      <text
        x="288"
        y="172"
        fontFamily="var(--nd-font-sans), sans-serif"
        fontSize="80"
        fontWeight="700"
        fill="var(--nd-black, #0a0a0a)"
      >
        벼린
      </text>
    </svg>
  );
}

export default Logo;
