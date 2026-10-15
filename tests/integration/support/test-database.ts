// Per-file throwaway PostgreSQL databases on the server named by TEST_DATABASE_URL.
// Each test file gets an empty database, so migration tests really start from nothing
// and destructive steps (revoking memberships, dropping tables) never leak between files
// or into the developer's DATABASE_URL.
import { randomBytes } from 'node:crypto';

import postgres from 'postgres';

import {
  TestDatabaseConfigError,
  databaseName,
  redactDatabaseUrl,
  requireTestDatabaseUrl,
  withDatabaseName,
} from './test-database-url.js';

export interface ThrowawayDatabase {
  readonly name: string;
  readonly url: string;
  /** Raw SQL client for assertions and fixture surgery inside this database only. */
  readonly sql: postgres.Sql;
  drop(): Promise<void>;
}

function adminClient(url: URL): postgres.Sql {
  return postgres(url.href, { max: 1, onnotice: () => undefined, connect_timeout: 5 });
}

/** Creates `<base>_<label>_<random>_test`; the base database only serves as the admin connection. */
export async function createThrowawayDatabase(label: string): Promise<ThrowawayDatabase> {
  const baseUrl = requireTestDatabaseUrl();
  const suffix = randomBytes(4).toString('hex');
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
  const stem = `${databaseName(baseUrl)}_${safeLabel}_${suffix}`.slice(0, 58);
  const url = withDatabaseName(baseUrl, `${stem}_test`);
  const name = databaseName(url);

  const admin = adminClient(baseUrl);
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (error) {
    throw new TestDatabaseConfigError(
      `Could not create throwaway database via ${redactDatabaseUrl(baseUrl)}: ${errorMessage(error)}. ` +
        'Check that PostgreSQL is running (npm run db:up), that the TEST_DATABASE_URL database exists ' +
        '(docker compose -f infra/docker/compose.yaml exec postgres createdb -U workloom workloom_test) ' +
        'and that the role may CREATE DATABASE.',
    );
  } finally {
    await admin.end({ timeout: 5 });
  }

  const sql = postgres(url.href, { max: 2, onnotice: () => undefined });
  return {
    name,
    url: url.href,
    sql,
    async drop() {
      await sql.end({ timeout: 5 });
      const cleanup = adminClient(baseUrl);
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}

function errorMessage(error: unknown): string {
  // postgres.js error messages carry no credentials; never print the URL itself.
  return error instanceof Error ? error.message : String(error);
}
