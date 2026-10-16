import { defineConfig, devices } from '@playwright/test';

// Isolated gate for asana-table-interactions.spec.ts against the already running compiled app on 4310.
// It starts no server, uses installed Google Chrome and writes only to its own new output/report folders.
export default defineConfig({
  testDir: '.',
  testMatch: 'asana-table-interactions.spec.ts',
  outputDir: '../../test-results/asana-table-interactions',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/asana-table-interactions' }]],
  use: { baseURL: 'http://127.0.0.1:4310', trace: 'on' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: true } }],
});
