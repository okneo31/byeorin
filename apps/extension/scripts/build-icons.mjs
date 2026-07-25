// build-icons.mjs — render the 벼린 toolbar icon set (16/32/48/128) from
// the project's master PNG. We just resize — no SVG path math — because
// the master is a raster illustration with effects (glow, gradients,
// alpha edges) that don't round-trip cleanly through SVG.
//
// Master source:
//   D:\TTLCOINWalet\icons\NewLogo0_512.png  (512×512, RGBA)
//
// Output:
//   apps/extension/public/icon/{16,32,48,128}.png  (overwritten)
//
// Why a script (vs checking in 4 hand-resized PNGs):
//   - Single source of truth → swapping master = one command.
//   - Lanczos3 resampling is consistent across machines.
//   - CI can regenerate without a designer.
//
// Run with: pnpm --filter @byeorin/extension build:icons

import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(__dirname, '../../../icons/NewLogo0_512.png');
const OUT_DIR = resolve(__dirname, '../public/icon');
const SIZES = [16, 32, 48, 128];

if (!existsSync(SOURCE)) {
  throw new Error(`build-icons: master not found at ${SOURCE}`);
}

const meta = await sharp(SOURCE).metadata();
console.log(
  `master: ${SOURCE}  (${meta.width}×${meta.height}, ${meta.channels} ch, alpha=${meta.hasAlpha})`,
);

// Step 1: trim transparent edges so the mark itself defines the bounds —
// otherwise a non-square master (e.g. 274×256) gets padded back to square
// and the mark ends up smaller. We trim then expand to a square canvas
// centered on the mark so the toolbar icon fills its slot fully.
const trimmed = await sharp(SOURCE).trim().toBuffer();
const trimmedMeta = await sharp(trimmed).metadata();
const square = Math.max(trimmedMeta.width, trimmedMeta.height);
console.log(
  `  trimmed: ${trimmedMeta.width}×${trimmedMeta.height}  → square canvas ${square}×${square}`,
);

const squaredBuffer = await sharp(trimmed)
  .resize(square, square, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    kernel: 'lanczos3',
  })
  .png()
  .toBuffer();

for (const size of SIZES) {
  await sharp(squaredBuffer)
    .resize(size, size, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(resolve(OUT_DIR, `${size}.png`));
  console.log(`  → ${size}×${size}`);
}
console.log(`done. ${SIZES.length} icons written to ${OUT_DIR}`);
