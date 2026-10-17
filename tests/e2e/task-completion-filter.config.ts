import { defineConfig, devices } from '@playwright/test';

// Isolated gate for task-completion-filter.spec.ts against the coordinator's already-running private QA app.
// The origin is required explicitly (no default), so this gate never reaches an unintended runtime.
// It starts no server, seed, migration, worker or lifecycle; one worker, no retries, own output/report folders.
const baseURL = process.env.WORKLOOM_QA_BASE_URL;
if (!baseURL) throw new Error('Set WORKLOOM_QA_BASE_URL to the explicitly authorized private QA origin.');

export default defineConfig({
  testDir: '.',
  testMatch: 'task-completion-filter.spec.ts',
  outputDir: '../../test-results/task-completion-filter',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/task-completion-filter' }]],
  use: { baseURL, trace: 'on' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: true } }],
});
