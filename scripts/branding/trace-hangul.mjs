// Trace the wordmark "노동자의 지갑" + tagline glyphs from Malgun Gothic Bold to SVG paths.
// Writes a JSON file with `{ wordmark: '<path d="..."/>', tagline_ko: '...', tagline_en: '...' }`
// that the SVG generators can paste into their final SVGs.
//
// Why: brief mandates outlined Hangul so the SVG renders identically without a Korean font.
import opentype from 'opentype.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// loadSync is deprecated; use parse + readFileSync per newer opentype.js API.
const fontBold = opentype.parse(readFileSync('C:/Windows/Fonts/malgunbd.ttf').buffer);
const fontReg = opentype.parse(readFileSync('C:/Windows/Fonts/malgun.ttf').buffer);

function traceGlyphs(font, text, fontSize, x, y) {
  const path = font.getPath(text, x, y, fontSize);
  return path.toPathData(2); // 2 decimal places
}

// Glyph sizes chosen to fit 800x256 wordmark area (mark on left = 256w, gap ≈ 32, text ≈ 512w).
//   wordmark @ 80px → ~508 wide for "노동자의 지갑"
//   OG taglines: scaled larger for 1200x630 card; ko @ 56px ≈ 956 wide, en @ 38px ≈ 727 wide.
const out = {
  // Mark + wordmark logo
  wordmark: traceGlyphs(fontBold, '노동자의 지갑', 80, 0, 64),
  // OG card big wordmark (will be placed on right of card)
  wordmark_og: traceGlyphs(fontBold, '노동자의 지갑', 100, 0, 80),
  // OG card taglines
  tagline_ko: traceGlyphs(fontReg, '체인이 자유롭다면 노동자도 자유롭다', 40, 0, 32),
  tagline_en: traceGlyphs(fontReg, 'When the chain is free, the worker is free.', 30, 0, 24),
};

const outFile = resolve(__dirname, '../../branding/raw/_glyphs.json');
writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`wrote ${outFile}`);
console.log('  wordmark path length:', out.wordmark.length);
console.log('  tagline_ko length:', out.tagline_ko.length);
console.log('  tagline_en length:', out.tagline_en.length);

// Also measure widths for layout
const wmW = fontBold.getAdvanceWidth('노동자의 지갑', 80);
const wmOgW = fontBold.getAdvanceWidth('노동자의 지갑', 100);
const tklW = fontReg.getAdvanceWidth('체인이 자유롭다면 노동자도 자유롭다', 40);
const tkeW = fontReg.getAdvanceWidth('When the chain is free, the worker is free.', 30);
console.log(`  wordmark width @80 ≈ ${wmW.toFixed(1)}`);
console.log(`  wordmark width @100 (OG) ≈ ${wmOgW.toFixed(1)}`);
console.log(`  tagline_ko width @40 ≈ ${tklW.toFixed(1)}`);
console.log(`  tagline_en width @30 ≈ ${tkeW.toFixed(1)}`);
