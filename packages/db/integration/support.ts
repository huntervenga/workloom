// Throwaway databases for @workloom/db integration tests. Each file gets its own empty
// database on the loopback server named by TEST_DATABASE_URL; it is dropped afterwards.
// A missing or unsafe TEST_DATABASE_URL fails the run — these tests never skip and never
// fall back to DATABASE_URL or an in-memory substitute.
import { randomBytes } from 'node:crypto';

import postgres from 'postgres';

import { createDatabase, type Database } from '../src/client.js';
import { parseDatabaseUrl } from '../src/database-url.js';

const TEST_DATABASE_NAME = /^workloom_test(_[a-z0-9_]+)?$|^[a-z0-9_]+_test$/;

export interface ThrowawayDatabase {
  readonly url: string;
  readonly name: string;
  readonly database: Database;
  drop(): Promise<void>;
}

export function requireTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const info = parseDatabaseUrl(env.TEST_DATABASE_URL, { variableName: 'TEST_DATABASE_URL', requireLoopback: true });
  if (!TEST_DATABASE_NAME.test(info.database)) {
    throw new Error('TEST_DATABASE_URL must name a synthetic test database ("workloom_test…" or "…_test").');
  }
  const dev = env.DATABASE_URL?.trim();
  if (dev) {
    try {
      const devUrl = new URL(dev);
      const testUrl = new URL(info.url);
      if (devUrl.host === testUrl.host && devUrl.pathname === testUrl.pathname) {
        throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL.');
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('TEST_DATABASE_URL')) throw error;
    }
  }
  return new URL(info.url);
}

function adminClient(url: URL): postgres.Sql {
  return postgres(url.href, { max: 1, onnotice: () => undefined, connect_timeout: 5 });
}

export async function createThrowawayDatabase(label: string): Promise<ThrowawayDatabase> {
  const base = requireTestDatabaseUrl();
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 16);
  const name = `wl_db_${safeLabel}_${randomBytes(4).toString('hex')}_test`;
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new Error(`Generated database name ${name} is not a test database name.`);
  }

  const admin = adminClient(base);
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = new URL(base.href);
  url.pathname = `/${name}`;
  const database = createDatabase(url.href, { requireLoopback: true, maxConnections: 4 });
  return {
    url: url.href,
    name,
    database,
    async drop() {
      await database.close();
      const cleanup = adminClient(base);
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
