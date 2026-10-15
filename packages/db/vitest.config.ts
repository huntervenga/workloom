import { defineConfig } from 'vitest/config';

// Unit tests only: no database connection is opened.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
