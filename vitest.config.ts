import { defineConfig } from 'vitest/config';

// Workspace imports (@workloom/*) resolve to built dist, so root test scripts run build:libs first.
// packages/ui is excluded and has no separate suite. apps/web owns its jsdom Vitest config;
// test:unit runs it via `npm run test -w @workloom/web`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/src/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'packages/ui/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          // Files share one real PostgreSQL database; run them one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
