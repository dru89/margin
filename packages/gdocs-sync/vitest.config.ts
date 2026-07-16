import { defineConfig } from 'vitest/config';

// Default run = offline tier only (CI runs this). The live tier is
// opt-in: `npm run test:live` (vitest.live.config.ts).
export default defineConfig({
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
  },
});
