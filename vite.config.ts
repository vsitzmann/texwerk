import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/** The browser client. `npm run build` emits dist/client, which the server serves. */
export default defineConfig({
  root: resolve(__dirname, 'src/client'),
  base: './',
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    assetsDir: 'app',
    chunkSizeWarningLimit: 3000,
  },
  server: {
    port: 5811,
    proxy: {
      '/ws': { target: 'ws://localhost:5810', ws: true },
      '/api': 'http://localhost:5810',
      '/raw': 'http://localhost:5810',
      '/pdf': 'http://localhost:5810',
      '/texwerk-connect.mjs': 'http://localhost:5810',
    },
  },
});
