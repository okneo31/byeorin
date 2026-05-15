// Cross-platform copy of src/tokens.css -> dist/tokens.css
// Replaces Unix `cp` so the build works on Windows.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const src = resolve(pkgRoot, 'src/tokens.css');
const dest = resolve(pkgRoot, 'dist/tokens.css');

if (!existsSync(src)) {
  console.error(`[copy-tokens] source not found: ${src}`);
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-tokens] ${src} -> ${dest}`);
