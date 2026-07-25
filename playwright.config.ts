import { defineConfig } from '@playwright/test';

/**
 * Journey tests (#131). These drive the built Electron app, so they need
 * `npm run build` first — `npm run test:e2e` does both.
 *
 * One app at a time: each test launches its own Electron instance with an
 * isolated userData directory, and running several at once makes window
 * assertions meaningless.
 *
 * No browsers are downloaded. Playwright's Electron support uses the
 * Electron already in devDependencies, so CI needs no `playwright install`.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
});
