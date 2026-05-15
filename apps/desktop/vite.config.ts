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
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
