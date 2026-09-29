import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * y-codemirror.next hands remote cursors to Yjs as raw JSON. A caret at the
 * very end of a document serializes without its `item` field, and Yjs then
 * dereferences undefined — crashing the remote-selection plugin in every
 * other participant's editor. Parse the JSON properly first.
 */
function fixRemoteCursors(): Plugin {
  return {
    name: 'texwerk-fix-y-codemirror-cursors',
    transform(code, id) {
      if (!id.includes('y-codemirror.next') || !id.endsWith('y-remote-selections.js')) return null;
      const fixed = code
        .replace('Y.createAbsolutePositionFromRelativePosition(cursor.anchor, ydoc)', 'Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.anchor), ydoc)')
        .replace('Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc)', 'Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), ydoc)');
      if (fixed === code) this.error('y-codemirror cursor fix no longer applies — check the library version');
      return fixed;
    },
  };
}

/** The browser client. `npm run build` emits dist/client, which the server serves. */
export default defineConfig({
  root: resolve(__dirname, 'src/client'),
  plugins: [fixRemoteCursors()],
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
