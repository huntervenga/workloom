import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { parseDatabaseUrl } from './database-url.js';

/** packages/db/migrations, resolved from this module in both src/ and dist/. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));
export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

export class MigrationStateError extends Error {
  override readonly name = 'MigrationStateError';
}

export interface ExpectedMigration {
  readonly tag: string;
  /** Journal `when`, stored by Drizzle as `created_at`. */
  readonly createdAt: number;
  /** SHA-256 of the SQL file, as computed by Drizzle's migrator. */
  readonly hash: string;
}

interface JournalFile {
  readonly entries: readonly { readonly tag: string; readonly when: unknown }[];
}

/**
 * Journal `when` is a version ordering key, not a domain timestamp. Drizzle's
 * migrator only applies entries newer than the last applied `created_at`, so an
 * entry that is not strictly greater than its predecessor would be skipped
 * silently on upgraded databases. Reject such journals before any connection.
 */
function assertJournalOrder(journal: JournalFile): void {
  let previous: { readonly tag: string; readonly when: number } | undefined;
  for (const entry of journal.entries) {
    const { when } = entry;
    if (typeof when !== 'number' || !Number.isSafeInteger(when)) {
      throw new MigrationStateError(`Migration journal entry ${entry.tag} has an invalid "when" value; expected a finite integer.`);
    }
    if (previous !== undefined && when <= previous.when) {
      throw new MigrationStateError(
        `Migration journal entry ${entry.tag} ("when" ${when}) must be later than ${previous.tag} ("when" ${previous.when}); ` +
          'Drizzle would skip it on databases that already applied the earlier entry.',
      );
    }
    previous = { tag: entry.tag, when };
  }
}

/** Reads the journal and hashes every migration exactly like the Drizzle migrator. */
export function readExpectedMigrations(migrationsFolder: string = MIGRATIONS_FOLDER): readonly ExpectedMigration[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as JournalFile;
  assertJournalOrder(journal);
  const files = readMigrationFiles({ migrationsFolder });
  return journal.entries.map((entry, index) => {
    const file = files[index];
    if (file === undefined || file.folderMillis !== entry.when) {
      throw new MigrationStateError(`Migration journal entry ${entry.tag} does not match its SQL file.`);
    }
    return { tag: entry.tag, createdAt: file.folderMillis, hash: file.hash };
  });
}

export type MigrationStatus =
  /** Every journal migration is applied, in order, with identical hashes. */
  | 'current'
  /** A prefix is applied; later migrations are pending. */
  | 'pending'
  /** No Drizzle migration table exists yet. */
  | 'uninitialized'
  /** Applied history differs from the journal (edited or reordered migration). */
  | 'diverged'
  /** The database has migrations this build does not know (newer schema). */
  | 'ahead';

export interface MigrationState {
  readonly status: MigrationStatus;
  readonly appliedCount: number;
  readonly expectedCount: number;
  readonly latestExpectedTag: string | null;
  readonly latestAppliedTag: string | null;
}

interface AppliedRow {
  readonly hash: string;
  readonly created_at: string | number | null;
}

/** Compares the applied Drizzle history with the journal of this build. Read-only. */
export async function inspectMigrationState(
  sql: postgres.Sql,
  expected: readonly ExpectedMigration[] = readExpectedMigrations(),
): Promise<MigrationState> {
  const latestExpectedTag = expected.at(-1)?.tag ?? null;
  const [presence] = await sql<{ present: boolean }[]>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as present
  `;
  if (presence?.present !== true) {
    return {
      status: expected.length === 0 ? 'current' : 'uninitialized',
      appliedCount: 0,
      expectedCount: expected.length,
      latestExpectedTag,
      latestAppliedTag: null,
    };
  }

  const applied = await sql<AppliedRow[]>`
    select hash, created_at from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)} order by created_at asc, id asc
  `;

  let matching = 0;
  while (matching < applied.length && matching < expected.length) {
    const row = applied[matching];
    const migration = expected[matching];
    if (row === undefined || migration === undefined) {
      break;
    }
    if (row.hash !== migration.hash || Number(row.created_at) !== migration.createdAt) {
      break;
    }
    matching += 1;
  }

  const latestAppliedTag = matching > 0 ? (expected[matching - 1]?.tag ?? null) : null;
  let status: MigrationStatus;
  if (matching < Math.min(applied.length, expected.length)) {
    status = 'diverged';
  } else if (applied.length > expected.length) {
    status = 'ahead';
  } else if (applied.length < expected.length) {
    status = 'pending';
  } else {
    status = 'current';
  }

  return { status, appliedCount: applied.length, expectedCount: expected.length, latestExpectedTag, latestAppliedTag };
}

export interface RunMigrationsOptions {
  readonly migrationsFolder?: string;
  /** Reject non-loopback database servers (local synthetic tooling). */
  readonly requireLoopback?: boolean;
}

export interface MigrationRunResult {
  /** Tags applied by this run; empty when the database was already current. */
  readonly appliedNow: readonly string[];
  readonly state: MigrationState;
  /** Credential-free target description. */
  readonly target: string;
}

/**
 * Applies pending migrations with Drizzle's migrator under a session advisory
 * lock (single connection), so concurrent runs serialize and repeated runs are
 * no-ops. Refuses diverged or newer histories. Always closes its connection.
 */
export async function runMigrations(databaseUrl: string | undefined, options: RunMigrationsOptions = {}): Promise<MigrationRunResult> {
  const info = parseDatabaseUrl(databaseUrl, { requireLoopback: options.requireLoopback ?? false });
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const expected = readExpectedMigrations(migrationsFolder);

  const sql = postgres(info.url, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: { application_name: 'workloom-migrate' },
  });
  try {
    await sql`select pg_advisory_lock(hashtextextended('workloom:migrations', 0))`;
    try {
      const before = await inspectMigrationState(sql, expected);
      if (before.status === 'diverged' || before.status === 'ahead') {
        throw new MigrationStateError(
          `Refusing to migrate: applied migration history is ${before.status} relative to this build ` +
            `(applied ${before.appliedCount}, known ${before.expectedCount}).`,
        );
      }

      if (before.status !== 'current') {
        await migrate(drizzle(sql), {
          migrationsFolder,
          migrationsSchema: MIGRATIONS_SCHEMA,
          migrationsTable: MIGRATIONS_TABLE,
        });
      }

      const after = await inspectMigrationState(sql, expected);
      if (after.status !== 'current') {
        throw new MigrationStateError(`Migration finished but the database is ${after.status}.`);
      }
      return {
        appliedNow: expected.slice(before.appliedCount).map((migration) => migration.tag),
        state: after,
        target: info.description,
      };
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended('workloom:migrations', 0))`.catch(() => undefined);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
