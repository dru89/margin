import { defineConfig } from 'vitest/config';

// Live tier: real Docs/Drive APIs, scratch docs, cached credentials.
// Skips (does not fail) when unauthenticated. Serial — quota is the
// shared resource (60 writes/min/user).
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.live.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    maxConcurrency: 1,
    fileParallelism: false,
  },
});
