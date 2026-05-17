// 노동자의 지갑 — extension icon generator (PNG, RGBA8).
//
// Renders the "ㄴ stamp" mark (Concept A) at 16/32/48/128 with a tiny
// pure-JS rasterizer (PNG via deflate). The image is super-sampled 4x for
// smooth edges, then box-downsampled.
//
// Composition at viewBox 256:
//   - Rounded-square stamp body (red), corner radius ~38.
//   - White "ㄴ" jamo: vertical bar + bottom bar joined at lower-left.
//   - Optional yellow notch at top-right (only at 48px and up).
//
// Pure stdlib: no sharp/canvas dependency.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RED = [0xc4, 0x1e, 0x1e, 0xff];
const PAPER = [0xff, 0xfa, 0xf0, 0xff];
const YELLOW = [0xf4, 0xc4, 0x30, 0xff];
const TRANSPARENT = [0, 0, 0, 0];

function crc32(buf) {
  let crc = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc ^ buf[i]) >>> 0;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // colour type: truecolour + alpha
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distance to an axis-aligned rounded rectangle.
// (x,y) is the sample, rect [x0,y0,x1,y1], radius r.
function sdfRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(x - cx) - hx;
  const dy = Math.abs(y - cy) - hy;
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  return sdfRoundRect(x, y, x0, y0, x1, y1, r) <= 0;
}

function insideCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Render the "ㄴ stamp" at given output size with supersampling.
function renderStamp(size) {
  const ss = size >= 48 ? 4 : 6; // super-sample factor; smaller icons need MORE supersampling for clean edges
  const W = size * ss;
  const H = size * ss;
  const big = Buffer.alloc(W * H * 4);

  // Geometry in 256-unit design space, mapped to W,H.
  const s = W / 256;
  const stamp = { x0: 16 * s, y0: 16 * s, x1: 240 * s, y1: 240 * s, r: 38 * s };
  // Inner hairline ring (drawn as ring between two SDFs)
  const ring = { x0: 32 * s, y0: 32 * s, x1: 224 * s, y1: 224 * s, r: 32 * s, w: 2 * s };

  // ㄴ geometry: vertical left bar + horizontal bottom bar, joined at lower-left.
  // Use 16/32 simplified shape vs 48/128 with brush thickening.
  const small = size <= 32;
  // Vertical bar
  const vBar = {
    x0: small ? 70 * s : 78 * s,
    y0: small ? 56 * s : 60 * s,
    x1: small ? 110 * s : 110 * s,
    y1: small ? 200 * s : 198 * s,
    r: small ? 8 * s : 14 * s,
  };
  // Horizontal bottom bar (overlaps vertical at lower-left)
  const hBar = {
    x0: small ? 70 * s : 78 * s,
    y0: small ? 160 * s : 156 * s,
    x1: small ? 200 * s : 198 * s,
    y1: small ? 200 * s : 198 * s,
    r: small ? 8 * s : 14 * s,
  };

  // Yellow corner accent (only at 48 and above)
  const showAccent = size >= 48;
  const accentOuter = { cx: 200 * s, cy: 70 * s, r: 12 * s };
  const accentInner = { cx: 200 * s, cy: 70 * s, r: 5 * s };

  function shade(x, y) {
    if (!insideRoundRect(x, y, stamp.x0, stamp.y0, stamp.x1, stamp.y1, stamp.r)) {
      return TRANSPARENT;
    }
    // Yellow corner notch
    if (showAccent) {
      if (insideCircle(x, y, accentInner.cx, accentInner.cy, accentInner.r)) return RED;
      if (insideCircle(x, y, accentOuter.cx, accentOuter.cy, accentOuter.r)) return YELLOW;
    }
    // ㄴ in paper colour
    if (insideRoundRect(x, y, vBar.x0, vBar.y0, vBar.x1, vBar.y1, vBar.r)) return PAPER;
    if (insideRoundRect(x, y, hBar.x0, hBar.y0, hBar.x1, hBar.y1, hBar.r)) return PAPER;

    // Inner hairline (paper @ low opacity) — only visible at large sizes
    if (size >= 48) {
      const dRing = sdfRoundRect(x, y, ring.x0, ring.y0, ring.x1, ring.y1, ring.r);
      if (Math.abs(dRing) <= ring.w / 2) {
        // Blend paper at 40% over red
        const a = 0.4;
        return [
          Math.round(RED[0] * (1 - a) + PAPER[0] * a),
          Math.round(RED[1] * (1 - a) + PAPER[1] * a),
          Math.round(RED[2] * (1 - a) + PAPER[2] * a),
          0xff,
        ];
      }
    }
    return RED;
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = shade(x + 0.5, y + 0.5);
      const off = (y * W + x) * 4;
      big[off] = c[0];
      big[off + 1] = c[1];
      big[off + 2] = c[2];
      big[off + 3] = c[3];
    }
  }

  // Box-downsample ss x ss → 1 px
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const off = ((y * ss + sy) * W + (x * ss + sx)) * 4;
          const aa = big[off + 3];
          // premultiply for correct alpha blend
          r += big[off] * aa;
          g += big[off + 1] * aa;
          b += big[off + 2] * aa;
          a += aa;
        }
      }
      const total = ss * ss;
      const aFinal = a / total;
      const outOff = (y * size + x) * 4;
      if (aFinal < 1) {
        out[outOff] = 0;
        out[outOff + 1] = 0;
        out[outOff + 2] = 0;
        out[outOff + 3] = 0;
      } else {
        out[outOff] = Math.round(r / a);
        out[outOff + 1] = Math.round(g / a);
        out[outOff + 2] = Math.round(b / a);
        out[outOff + 3] = Math.round(aFinal);
      }
    }
  }
  return out;
}

const sizes = [16, 32, 48, 128];
const outDir = resolve(__dirname, '../apps/extension/public/icon');
mkdirSync(outDir, { recursive: true });
for (const s of sizes) {
  const rgba = renderStamp(s);
  const png = encodePng(s, s, rgba);
  const file = resolve(outDir, `${s}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${s}x${s}, ${png.length} B)`);
}
