import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    port: 5173,
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
        // Buffer polyfill 을 **독립 청크**로 뗀다. 엔트리에 인라인되면 그 대입문이
        // 엔트리의 정적 import 청크들보다 늦게 돌아, 최상위에서 Buffer 를 참조하는
        // 청크가 있으면 부팅이 백지가 된다. desktop 셸과 같은 이유·같은 처리.
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
