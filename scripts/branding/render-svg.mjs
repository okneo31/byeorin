// Render an SVG to PNG (or JPG) at given dimensions, preserving aspect ratio.
// Usage: node render-svg.mjs <svg> <width>x<height>? <out>
// If only width is given, height is auto from SVG viewBox.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const [, , svgPath, dims, outPath] = process.argv;
if (!svgPath || !dims || !outPath) {
  console.error('usage: node render-svg.mjs <svg> <WxH or W> <out.[png|jpg]>');
  process.exit(2);
}
const svg = readFileSync(resolve(svgPath));
const [wStr, hStr] = dims.split('x');
const w = parseInt(wStr, 10);
const h = hStr ? parseInt(hStr, 10) : undefined;

// Sharp doesn't natively know the SVG viewBox; we tell it explicit width/height via resize.
// `density` controls how the SVG is rasterized internally before resize — higher = sharper.
const density = Math.max(96, Math.min(600, w * 1.5));

let pipeline = sharp(svg, { density });
if (h) {
  pipeline = pipeline.resize(w, h, { fit: 'fill' });
} else {
  pipeline = pipeline.resize({ width: w });
}

const ext = outPath.toLowerCase().split('.').pop();
let buf;
if (ext === 'jpg' || ext === 'jpeg') {
  buf = await pipeline.flatten({ background: '#fffaf0' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
} else {
  buf = await pipeline.png({ compressionLevel: 9 }).toBuffer();
}

writeFileSync(resolve(outPath), buf);
console.log(`wrote ${outPath} (${buf.length} B)`);
