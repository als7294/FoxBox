import { defineConfig } from '@playwright/test'

// Electron end-to-end: no browser downloads needed (Playwright drives the app's own Electron).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
