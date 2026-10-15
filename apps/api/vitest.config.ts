import { defineConfig } from 'vitest/config';

// Unit/HTTP tests with injected ports; no database connection is opened.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
