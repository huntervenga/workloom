import { defineConfig } from 'drizzle-kit';

// drizzle-kit is used only to draft migrations from src/schema.ts. Every generated SQL file is
// reviewed and committed under migrations/; the application never syncs schema at startup.
// `generate` diffs against migrations/meta snapshots and needs no database connection.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
