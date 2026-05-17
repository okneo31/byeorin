// Build all branding deliverables from the SVG sources.
//
// Pipeline:
//   1. (assumed already run) trace-hangul.mjs — outlines Hangul into _glyphs.json
//   2. (assumed already run) build-svgs.mjs — generates logo-wordmark.svg, og.svg
//   3. THIS script — rasterizes every PNG/JPG export and copies to app public dirs.
//
// Rendering: sharp 0.34.x with `density` tuned per output size for sharp edges.
// Re-runnable; outputs are idempotent.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const rawDir = resolve(root, 'branding/raw');
const exportDir = resolve(root, 'branding/export');
mkdirSync(exportDir, { recursive: true });

const markSvg = readFileSync(resolve(rawDir, 'mark.svg'));
const wordmarkSvg = readFileSync(resolve(rawDir, 'logo-wordmark.svg'));
const ogSvg = readFileSync(resolve(rawDir, 'og.svg'));

async function renderPng(svg, w, h, outPath) {
  // density: higher → sharper raster but slower. Cap at 600 to avoid runaway memory.
  const density = Math.max(96, Math.min(600, Math.round(w * 2.0)));
  const buf = await sharp(svg, { density })
    .resize(w, h, { fit: 'fill' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  writeFileSync(outPath, buf);
  const { width, height } = parsePngDims(buf);
  if (width !== w || height !== h) {
    throw new Error(`dim mismatch ${outPath}: got ${width}x${height}, expected ${w}x${h}`);
  }
  return buf.length;
}

async function renderJpg(svg, w, h, outPath, bg = '#fffaf0', quality = 90) {
  const density = Math.max(96, Math.min(600, Math.round(w * 2.0)));
  const buf = await sharp(svg, { density })
    .resize(w, h, { fit: 'fill' })
    .flatten({ background: bg })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  writeFileSync(outPath, buf);
  // Verify JPG signature
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
    throw new Error(`not a valid JPG: ${outPath}`);
  }
  return buf.length;
}

function parsePngDims(buf) {
  // IHDR is first chunk after 8-byte signature. width at bytes 16-19, height at 20-23.
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('not a valid PNG');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

// ── Mark exports ──────────────────────────────────────────────────
const markSizes = [16, 32, 48, 128, 180, 256, 512, 1024];
const markBytes = {};
for (const s of markSizes) {
  const out = resolve(exportDir, `mark-${s}.png`);
  markBytes[s] = await renderPng(markSvg, s, s, out);
  console.log(`  mark-${s}.png ${s}x${s} → ${markBytes[s]} B`);
}

// favicon-32
{
  const out = resolve(exportDir, 'favicon-32.png');
  const bytes = await renderPng(markSvg, 32, 32, out);
  console.log(`  favicon-32.png 32x32 → ${bytes} B`);
}

// ── Logo wordmark exports ─────────────────────────────────────────
for (const w of [400, 800]) {
  const out = resolve(exportDir, `logo-wordmark-${w}.png`);
  const h = Math.round(w * 256 / 800); // preserve 800:256 = 3.125:1 ratio
  const bytes = await renderPng(wordmarkSvg, w, h, out);
  console.log(`  logo-wordmark-${w}.png ${w}x${h} → ${bytes} B`);
}

// ── OG card exports ───────────────────────────────────────────────
{
  const out = resolve(exportDir, 'og.png');
  const bytes = await renderPng(ogSvg, 1200, 630, out);
  console.log(`  og.png 1200x630 → ${bytes} B`);
}
{
  const out = resolve(exportDir, 'og.jpg');
  const bytes = await renderJpg(ogSvg, 1200, 630, out);
  console.log(`  og.jpg 1200x630 → ${bytes} B (true JPG)`);
}

// ── App-specific copies ───────────────────────────────────────────
const extensionIconDir = resolve(root, 'apps/extension/public/icon');
mkdirSync(extensionIconDir, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  copyFileSync(
    resolve(exportDir, `mark-${s}.png`),
    resolve(extensionIconDir, `${s}.png`),
  );
  console.log(`  copy → apps/extension/public/icon/${s}.png`);
}

const webPublicDir = resolve(root, 'apps/web/public');
mkdirSync(webPublicDir, { recursive: true });
copyFileSync(resolve(exportDir, 'og.png'), resolve(webPublicDir, 'og.png'));
copyFileSync(resolve(exportDir, 'og.jpg'), resolve(webPublicDir, 'og.jpg'));
copyFileSync(resolve(exportDir, 'favicon-32.png'), resolve(webPublicDir, 'favicon.png'));
copyFileSync(resolve(exportDir, 'mark-180.png'), resolve(webPublicDir, 'apple-touch-icon.png'));
console.log('  copy → apps/web/public/{og.png, og.jpg, favicon.png, apple-touch-icon.png}');

console.log('\nAll branding assets built.');
