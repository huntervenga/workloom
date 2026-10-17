import { defineConfig, devices } from '@playwright/test';

// Isolated native gate for gantt-date-move.spec.ts only. Run against the coordinator's already-running
// compiled app; no server start, seed, migration, worker, or runtime lifecycle belongs to this gate.
// Installed Google Chrome, one worker, no retries, full traces, and new output/report folders of its own.
export default defineConfig({
  testDir: '.',
  testMatch: 'gantt-date-move.spec.ts',
  outputDir: '../../test-results/gantt-date-move',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/gantt-date-move' }]],
  use: { baseURL: process.env.WORKLOOM_QA_BASE_URL ?? 'http://127.0.0.1:55519', trace: 'on' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: true } }],
});
