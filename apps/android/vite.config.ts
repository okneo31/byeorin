import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 벼린 — 안드로이드 셸(WebView) 번들 구성.
//
// 왜 Vite + WebView 인가:
//   9 체인 어댑터(@scure/btc-signer · @solana/web3.js · cosmjs · tronweb ·
//   @ton/ton · xrpl · aptos · sui · viem)는 WASM / WebCrypto / Buffer 를 전제로
//   한다. Android WebView 는 Chromium 이라 셋 다 그대로 지원하지만, RN 의
//   Hermes 는 WebAssembly 자체가 없어 BTC/SOL 어댑터가 원천적으로 못 돈다.
//   그래서 확장 popup 과 동일한 웹 런타임을 안드로이드에 그대로 얹는다.
//
// 번들 전략은 확장과 동일:
//   - 초기 진입은 core + evm 만 (가벼움)
//   - `@byeorin/wallet-sdk/multichain` 은 App 마운트 후 dynamic import →
//     별도 chunk 로 떨어져 첫 페인트를 막지 않는다.
export default defineConfig({
  plugins: [react()],
  // Capacitor 는 https://localhost 루트에서 index.html 을 서빙한다.
  base: '/',
  define: {
    // cosmjs / tronweb 등 일부 의존성이 `global` 을 참조한다 (Node 관습).
    // Buffer 와 달리 값 자체는 globalThis 면 충분하므로 컴파일 타임 치환.
    global: 'globalThis',
  },
  build: {
    // Android System WebView 가 오래된 단말도 있으므로 보수적으로 잡는다.
    // BigInt 리터럴(0n)·optional chaining 이 필수라 es2020 이 하한선.
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    // multichain chunk 는 5MB 를 넘긴다 — 의도된 것이므로 경고를 올려 잡는다.
    chunkSizeWarningLimit: 8000,
    sourcemap: false,
  },
  server: {
    port: 5183,
    strictPort: true,
    host: true,
  },
});
