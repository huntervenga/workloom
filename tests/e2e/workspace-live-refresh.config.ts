import { defineConfig, devices } from '@playwright/test';

// Run only against the coordinator's already-running frozen compiled checkpoint.
// No server start, seed, migration, worker, or runtime lifecycle belongs to this gate.
export default defineConfig({
  testDir: '.',
  testMatch: 'workspace-live-refresh.spec.ts',
  outputDir: '../../test-results/workspace-live-refresh',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/workspace-live-refresh' }]],
  use: { baseURL: process.env.WORKLOOM_QA_BASE_URL ?? 'http://127.0.0.1:4310', trace: 'on' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: true } }],
});
