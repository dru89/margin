import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { loadEnv } from 'vite';

// The shipped default OAuth client is injected at build time — from .env
// locally (untracked), from repo secrets in CI. Empty values compile to a
// null default (see src/main/defaultOAuthClient.ts).
const dotenv = loadEnv('production', __dirname, 'MARGIN_');
const oauthEnv = (key: string): string =>
  JSON.stringify(process.env[key] ?? dotenv[key] ?? '');

export default defineConfig({
  main: {
    // Keep node_modules external so the Agent SDK can spawn its bundled CLI
    // from disk at runtime instead of being inlined into the bundle.
    // nanoid is ESM-only and can't be require()d from the CJS bundle — inline it.
    plugins: [externalizeDepsPlugin({ exclude: ['nanoid'] })],
    define: {
      __MARGIN_OAUTH_CLIENT_ID__: oauthEnv('MARGIN_GOOGLE_OAUTH_CLIENT_ID'),
      __MARGIN_OAUTH_CLIENT_SECRET__: oauthEnv('MARGIN_GOOGLE_OAUTH_CLIENT_SECRET'),
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        // gdocs-sync is bundled from source: it stays a standalone package
        // (zero Margin imports) but ships inside the main bundle, so no
        // workspace symlinks or packaging changes are needed. Its mdast/
        // micromark deps are inlined along with it (ESM-only, like nanoid).
        'gdocs-sync': resolve(__dirname, 'packages/gdocs-sync/src/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
  },
});
