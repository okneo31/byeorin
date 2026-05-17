// Verify every exported PNG/JPG: parse the file header to confirm dimensions match the filename.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const exportDir = resolve(__dirname, '../../branding/export');

function parsePngDims(buf) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function parseJpgDims(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    // SOF markers: 0xC0..0xCF except 0xC4, 0xC8, 0xCC
    if (
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return { w, h };
    }
    const segLen = buf.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  return null;
}

const files = readdirSync(exportDir).sort();
let errs = 0;
for (const f of files) {
  const path = resolve(exportDir, f);
  const buf = readFileSync(path);
  const size = statSync(path).size;
  let dims, kind;
  if (f.endsWith('.png')) {
    dims = parsePngDims(buf);
    kind = 'PNG';
  } else if (f.endsWith('.jpg') || f.endsWith('.jpeg')) {
    dims = parseJpgDims(buf);
    kind = 'JPG';
  } else {
    console.log(`  skip ${f}`);
    continue;
  }
  if (!dims) {
    console.log(`  ✗ ${f}: not a valid ${kind}`);
    errs++;
    continue;
  }
  console.log(`  ${kind} ${f}  ${dims.w}x${dims.h}  ${size} B`);
}
if (errs > 0) {
  console.error(`\n${errs} file(s) failed verification.`);
  process.exit(1);
}
console.log('\nAll exports verified.');
