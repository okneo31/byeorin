import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 2 recommended Vite config.
// - clearScreen:false so we don't wipe Rust compiler output
// - strict port 1420 matches tauri.conf.json devUrl
// - envPrefix lets us read TAURI_ENV_* variables provided by tauri-cli
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  define: {
    // cosmjs / tronweb 등 일부 의존성이 `global` 을 참조한다 (Node 관습).
    // android 셸과 같은 치환.
    global: 'globalThis',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Buffer polyfill 을 **독립 청크**로 뗀다.
        //
        // 엔트리 안에 인라인되면 그 대입문은 엔트리가 정적으로 import 한 다른
        // 청크들이 전부 평가된 **뒤에** 실행된다(모듈 본문은 import 보다 늦다).
        // 그 청크 중 하나가 최상위에서 Buffer 를 참조해 부팅이 백지가 됐다.
        // 독립 청크로 떼면 main.tsx 의 첫 import 라 가장 먼저 평가된다.
        manualChunks(id) {
          if (id.includes('buffer-polyfill') || id.includes('node_modules/buffer/')) {
            return 'buffer-polyfill';
          }
          return undefined;
        },
      },
    },
  },
});
