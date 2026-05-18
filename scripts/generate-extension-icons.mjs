// 벼린 — extension icon generator (PNG, RGBA8).
//
// Renders the crossed-pickaxes mark (the brand mark.svg) at 16/32/48/128 and
// writes them to apps/extension/public/icon/.
//
// Rendering pipeline: sharp 0.34.x. Source of truth: branding/raw/mark.svg.
// Sharp is run with density tuned per output size for sharp edges (no anti-aliased mush
// at 16px). Output PNG dimensions are then verified by parsing the IHDR chunk.
//
// Idempotent: re-running produces byte-identical output (sharp is deterministic for the
// same input + zlib level).
//
// History: an earlier version of this file shipped a pure-Node SDF rasterizer for the
// "ㄴ stamp" mark. That mark was retired in favor of the crossed-pickaxe brand; rather
// than re-implementing SDF for a vector-rich icon, we adopt sharp here. Sharp is installed
// at the workspace root as a devDependency, so `pnpm install` brings it in automatically.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const markPath = resolve(root, 'branding/raw/mark.svg');
const outDir = resolve(root, 'apps/extension/public/icon');
mkdirSync(outDir, { recursive: true });

const markSvg = readFileSync(markPath);
const sizes = [16, 32, 48, 128];

function verifyPng(buf, expectedW, expectedH, filePath) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error(`${filePath}: not a valid PNG (bad signature)`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== expectedW || height !== expectedH) {
    throw new Error(`${filePath}: dim mismatch — got ${width}x${height}, expected ${expectedW}x${expectedH}`);
  }
}

for (const s of sizes) {
  // density: 2× pixel size, capped, gives crisp edges at all sizes including 16.
  const density = Math.max(96, Math.min(600, Math.round(s * 20)));
  const buf = await sharp(markSvg, { density })
    .resize(s, s, { fit: 'fill' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const file = resolve(outDir, `${s}.png`);
  writeFileSync(file, buf);
  verifyPng(buf, s, s, file);
  console.log(`wrote ${file} (${s}x${s}, ${buf.length} B)`);
}
