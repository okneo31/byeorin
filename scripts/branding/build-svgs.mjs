// Generate logo-wordmark.svg and og.svg using the traced Hangul glyph paths.
// Run after `node scripts/branding/trace-hangul.mjs`.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawDir = resolve(__dirname, '../../branding/raw');

const glyphs = JSON.parse(readFileSync(resolve(rawDir, '_glyphs.json'), 'utf8'));
const markSvg = readFileSync(resolve(rawDir, 'mark.svg'), 'utf8');

// Extract the *inner* contents of mark.svg (everything between the outer <svg ...> and </svg>)
// so we can embed the mark inside a different parent SVG.
function innerSvg(svg) {
  const m = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  if (!m) throw new Error('mark.svg parse failed');
  return m[1];
}
const markInner = innerSvg(markSvg);

// ── 1. logo-wordmark.svg (800×256) ────────────────────────────────
// Layout:
//   x=0..256   → mark (full)
//   x=288..796 → wordmark "노동자의 지갑" (~508 wide @ 80px)
//   Baseline aligned vertically to mark center; baseline at y ≈ 168.
{
  // Wordmark glyph path is in coords with baseline=y_base=64 (from trace) and cap top at y≈-16.
  // We placed baseline at y=64 in the trace so the visible glyph spans roughly y=-16..y=80.
  // To align baseline with center-ish (y=160) in the 800×256 wordmark canvas:
  //   translate by (288, 96)  → baseline becomes 96+64=160, cap top ≈ 96-16=80, descend ≈ 96+80=176. Centered.
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 256" role="img" aria-label="노동자의 지갑">
  <title>노동자의 지갑 — 로고 + 워드마크</title>
  <!-- Mark — embedded from branding/raw/mark.svg (256×256 viewBox, inlined here unchanged). -->
  ${markInner}
  <!-- Wordmark: '노동자의 지갑'. Hangul outlined from Malgun Gothic Bold (no <text> dependency). -->
  <g transform="translate(288 96)" fill="#0a0a0a">
    <path d="${glyphs.wordmark}"/>
  </g>
</svg>
`;
  writeFileSync(resolve(rawDir, 'logo-wordmark.svg'), out);
  console.log('wrote logo-wordmark.svg');
}

// ── 2. og.svg (1200×630) ──────────────────────────────────────────
// Layout:
//   Background: paper #fffaf0 with subtle dot-grain texture
//   Left:  mark, 400×400 centered at (240, 315) — placed at x=40..440, y=115..515
//   Right: wordmark "노동자의 지갑" @ 120px (~762 wide) at y baseline ~340
//          tagline_ko @ 40px below
//          tagline_en @ 30px below, italic-feeling muted
//   Corner ornaments: small red 'ㄱ' shapes at four corners (echo of stamp motif)
{
  // wordmark_og @ 100pt baseline=80 in trace coords → spans roughly y=-20..y=100
  // Place at (480, 290): baseline ≈ 370, top ≈ 270, descend ≈ 390. Width ≈ 635 → ends at 1115.
  // tagline_ko @40 baseline=32 → at (480, 432) → baseline 464, top ~422, bottom ~472. Width ≈ 682 → ends at 1162.
  // tagline_en @30 baseline=24 → at (480, 502) → baseline 526, top ~492, bottom ~532. Width ≈ 574 → ends at 1054.

  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="노동자의 지갑 OG card">
  <title>노동자의 지갑 — Open Graph card</title>
  <!-- Background: paper -->
  <rect width="1200" height="630" fill="#fffaf0"/>

  <!-- Subtle dot grain texture (low-density paper feel) -->
  <defs>
    <pattern id="grain" x="0" y="0" width="32" height="32" patternUnits="userSpaceOnUse">
      <circle cx="6" cy="6" r="0.8" fill="#0a0a0a" opacity="0.05"/>
      <circle cx="22" cy="18" r="0.6" fill="#0a0a0a" opacity="0.04"/>
      <circle cx="14" cy="26" r="0.5" fill="#0a0a0a" opacity="0.05"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="url(#grain)"/>

  <!-- Corner ornaments: tying to stamp motif. Red brackets at all four corners. -->
  <g fill="#c41e1e">
    <path d="M 36 36 L 92 36 L 92 44 L 44 44 L 44 92 L 36 92 Z"/>
    <path d="M 1164 36 L 1108 36 L 1108 44 L 1156 44 L 1156 92 L 1164 92 Z"/>
    <path d="M 36 594 L 92 594 L 92 586 L 44 586 L 44 538 L 36 538 Z"/>
    <path d="M 1164 594 L 1108 594 L 1108 586 L 1156 586 L 1156 538 L 1164 538 Z"/>
  </g>

  <!-- Mark on left side, 400×400. Embed by transforming a 256-viewBox copy. -->
  <g transform="translate(40 115) scale(1.5625)">
    ${markInner}
  </g>

  <!-- Wordmark "노동자의 지갑" big -->
  <g transform="translate(480 290)" fill="#0a0a0a">
    <path d="${glyphs.wordmark_og}"/>
  </g>

  <!-- A thin red rule between wordmark and taglines -->
  <rect x="480" y="408" width="80" height="3" fill="#c41e1e"/>

  <!-- Tagline (KO) — pro-labor manifesto -->
  <g transform="translate(480 432)" fill="#0a0a0a" opacity="0.88">
    <path d="${glyphs.tagline_ko}"/>
  </g>

  <!-- Tagline (EN) — muted, supportive -->
  <g transform="translate(480 502)" fill="#0a0a0a" opacity="0.55">
    <path d="${glyphs.tagline_en}"/>
  </g>
</svg>
`;
  writeFileSync(resolve(rawDir, 'og.svg'), out);
  console.log('wrote og.svg');
}
