import { defineConfig } from 'vitest/config';

// Real PostgreSQL only (TEST_DATABASE_URL). A missing database fails the run; nothing is skipped.
export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
