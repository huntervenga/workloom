import { defineConfig } from 'vitest/config';

// Unit tests with injected sinks and steps; no database or queue connection is opened.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
