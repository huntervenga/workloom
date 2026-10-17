import { defineConfig, devices } from '@playwright/test';

// Isolated gate for night-ux.spec.ts against an already running app: the compiled app on 4310 by default;
// WORKLOOM_QA_BASE_URL may point an exploratory source preview at 4311.
// It starts no server, uses installed Google Chrome with one worker and no retries, and writes only to its
// own new output/report folders.
export default defineConfig({
  testDir: '.',
  testMatch: 'night-ux.spec.ts',
  outputDir: '../../test-results/night-ux',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/night-ux' }]],
  use: { baseURL: process.env.WORKLOOM_QA_BASE_URL ?? 'http://127.0.0.1:4310', trace: 'on' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: true } }],
});
