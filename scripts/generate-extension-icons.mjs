// Minimal PNG generator for extension icons.
// Produces 16/32/48/128 PNGs with a "stamp" mark: brand red square + white circle center.
// Real branded icons should ship from packages/design-system later.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function makePng(size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);   // 8-bit depth
  ihdr.writeUInt8(2, 9);   // truecolor RGB
  ihdr.writeUInt8(0, 10);  // compression: deflate
  ihdr.writeUInt8(0, 11);  // filter
  ihdr.writeUInt8(0, 12);  // interlace: none

  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rInner = size * 0.30;
  const rRing = size * 0.40;

  // Brand red square + white inner circle + thin yellow ring band
  const RED = [0xc4, 0x1e, 0x1e];
  const WHITE = [0xff, 0xff, 0xff];
  const YELLOW = [0xf4, 0xc4, 0x30];

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      let c;
      if (d2 <= rInner * rInner) c = WHITE;
      else if (d2 <= rRing * rRing) c = YELLOW;
      else c = RED;
      const off = y * stride + 1 + x * 3;
      raw[off] = c[0];
      raw[off + 1] = c[1];
      raw[off + 2] = c[2];
    }
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 32, 48, 128];
const outDir = resolve(__dirname, '../apps/extension/public/icon');
mkdirSync(outDir, { recursive: true });
for (const s of sizes) {
  const file = resolve(outDir, `${s}.png`);
  writeFileSync(file, makePng(s));
  console.log(`wrote ${file} (${s}x${s})`);
}
