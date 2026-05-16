import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'es2022',
  // wallet-sdk 와 그 subpath 들은 외부로 둔다 — 컨슈머(브라우저 확장) 가 본 ESM 을
  // import 할 때 wallet-sdk/core 가 그대로 보존돼야 tree-shaking 이 동작한다.
  external: ['@nodong/wallet-sdk', /^@nodong\/wallet-sdk\//],
});
