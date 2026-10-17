import { defineConfig, devices } from '@playwright/test';

// Isolated native gate for daily-entry-recovery.spec.ts only. Run against the coordinator's already-running
// compiled app; no server start, seed, migration, worker, or runtime lifecycle belongs to this gate.
// The base URL must be explicit: there is deliberately no fallback port.
// Installed Google Chrome, one worker, no retries, full traces, and new output/report folders of its own.
const baseURL = process.env.WORKLOOM_QA_BASE_URL;
if (!baseURL) throw new Error('WORKLOOM_QA_BASE_URL is required for daily-entry-recovery; no fallback is used.');

export default defineConfig({
  testDir: '.',
  testMatch: 'daily-entry-recovery.spec.ts',
  outputDir: '../../test-results/daily-entry-recovery',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 150_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/daily-entry-recovery' }]],
  use: { baseURL, trace: 'on' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: true } }],
});
