import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The mirror bridge as one self-contained file, like DeckWerk's
 * deckwerk-connect.mjs: a collaborator downloads it with curl and runs it with
 * Node 22+. yjs and friends are inlined; Node built-ins stay external.
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  build: {
    ssr: resolve(__dirname, 'src/bridge/connect.ts'),
    target: 'node22',
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'texwerk-connect.mjs', format: 'es', inlineDynamicImports: true } },
  },
  ssr: { noExternal: true },
});
