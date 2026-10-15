import type postgres from 'postgres';

import { describeErrorForLog, type LoggableError } from './database-errors.js';
import { inspectMigrationState, readExpectedMigrations, type ExpectedMigration, type MigrationStatus } from './migrations.js';
import { REQUIRED_TABLES } from './schema.js';

export type ReadinessCheckResult = 'ok' | 'failed' | 'skipped';

export interface ReadinessReport {
  readonly ready: boolean;
  /** Safe to return to clients: fixed check names and outcomes only. */
  readonly checks: {
    readonly database: ReadinessCheckResult;
    readonly schema: ReadinessCheckResult;
  };
  /** For server logs only; never send to clients. */
  readonly diagnostic?: {
    readonly migrationStatus?: MigrationStatus;
    readonly missingTables?: readonly string[];
    readonly error?: LoggableError;
  };
}

export interface ReadinessProbe {
  check(): Promise<ReadinessReport>;
}

export interface ReadinessProbeOptions {
  readonly timeoutMs?: number;
  readonly migrationsFolder?: string;
}

class ReadinessTimeoutError extends Error {
  override readonly name = 'ReadinessTimeoutError';
  readonly code = 'READINESS_TIMEOUT';
}

/**
 * Readiness = PostgreSQL answers AND the applied migration history equals this
 * build's journal exactly AND every required table exists. It never creates
 * or alters schema.
 */
export function createReadinessProbe(
  database: { readonly sql: postgres.Sql },
  options: ReadinessProbeOptions = {},
): ReadinessProbe {
  const timeoutMs = options.timeoutMs ?? 2_000;
  let expected: readonly ExpectedMigration[] | undefined;

  async function evaluate(): Promise<ReadinessReport> {
    try {
      await database.sql`select 1 as ok`;
    } catch (error) {
      return { ready: false, checks: { database: 'failed', schema: 'skipped' }, diagnostic: { error: describeErrorForLog(error) } };
    }

    try {
      expected ??= readExpectedMigrations(options.migrationsFolder);
      const state = await inspectMigrationState(database.sql, expected);
      const missing = await database.sql<{ name: string }[]>`
        select name from unnest(${database.sql.array([...REQUIRED_TABLES])}::text[]) as required(name)
        where to_regclass(format('public.%I', name)) is null
      `;
      const missingTables = missing.map((row) => row.name);
      const schemaOk = state.status === 'current' && missingTables.length === 0;
      return {
        ready: schemaOk,
        checks: { database: 'ok', schema: schemaOk ? 'ok' : 'failed' },
        diagnostic: { migrationStatus: state.status, missingTables },
      };
    } catch (error) {
      return { ready: false, checks: { database: 'ok', schema: 'failed' }, diagnostic: { error: describeErrorForLog(error) } };
    }
  }

  return {
    async check() {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<ReadinessReport>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            ready: false,
            checks: { database: 'failed', schema: 'skipped' },
            diagnostic: { error: describeErrorForLog(new ReadinessTimeoutError('Readiness check timed out')) },
          });
        }, timeoutMs);
        timer.unref();
      });
      try {
        return await Promise.race([evaluate(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
