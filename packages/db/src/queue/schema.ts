import { PgBoss, getConstructionPlans, getMigrationPlans, type MigrationPartition, type QueuePolicy } from 'pg-boss';
import pgBossPackage from 'pg-boss/package.json' with { type: 'json' };
import postgres from 'postgres';

import { parseDatabaseUrl } from '../database-url.js';
import { describeErrorForLog } from '../database-errors.js';

/**
 * pg-boss schema lifecycle for the Workloom background queue. Only the explicit
 * `db:queue:migrate` command installs or upgrades this schema and registers the
 * known queues; worker runtimes construct PgBoss with `migrate: false` and
 * `createSchema: false` and fail if the schema is not exactly current.
 */
export const WORKLOOM_QUEUE_SCHEMA = 'workloom_queue';
export const RECURRENCE_MATERIALIZE_QUEUE = 'workloom.recurrence.materialize.v1';
export const RECURRENCE_DEAD_LETTER_QUEUE = 'workloom.recurrence.dead_letter.v1';
export const CUTOFF_QUEUE = 'workloom.planning.cutoff.v1';
export const CUTOFF_DEAD_LETTER_QUEUE = 'workloom.planning.cutoff.dead_letter.v1';
/** Root-approved pinned pg-boss release and the schema version its package.json declares. */
export const PG_BOSS_VERSION = '12.38.0';
export const PG_BOSS_SCHEMA_VERSION = 46;
/**
 * Approved queue configurations. `db:queue:migrate` creates each queue with exactly
 * these options and never updates an existing queue; workers compare their runtime
 * `getQueue()` results against `WORKLOOM_QUEUE_REGISTRATIONS`.
 */
export const RECURRENCE_DEAD_LETTER_QUEUE_OPTIONS = {
  policy: 'standard',
  partition: false,
  retryLimit: 0,
  retryDelay: 0,
  retryBackoff: false,
  expireInSeconds: 300,
  retentionSeconds: 604800,
  deleteAfterSeconds: 604800,
} as const;
export const RECURRENCE_MATERIALIZE_QUEUE_OPTIONS = {
  policy: 'standard',
  partition: false,
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 300,
  retentionSeconds: 604800,
  deleteAfterSeconds: 604800,
  deadLetter: RECURRENCE_DEAD_LETTER_QUEUE,
} as const;
/**
 * Registration order (the dead-letter queue must exist before a queue names it) and
 * the state each queue must report. The dead-letter queue itself has no dead letter.
 */
export const RECURRENCE_QUEUE_REGISTRATIONS = [
  {
    name: RECURRENCE_DEAD_LETTER_QUEUE,
    options: RECURRENCE_DEAD_LETTER_QUEUE_OPTIONS,
    expected: { ...RECURRENCE_DEAD_LETTER_QUEUE_OPTIONS, deadLetter: null },
  },
  {
    name: RECURRENCE_MATERIALIZE_QUEUE,
    options: RECURRENCE_MATERIALIZE_QUEUE_OPTIONS,
    expected: RECURRENCE_MATERIALIZE_QUEUE_OPTIONS,
  },
] as const;

/** Additive cutoff queues retain the approved recurrence retry/retention policy. */
export const CUTOFF_DEAD_LETTER_QUEUE_OPTIONS = { ...RECURRENCE_DEAD_LETTER_QUEUE_OPTIONS } as const;
export const CUTOFF_QUEUE_OPTIONS = { ...RECURRENCE_MATERIALIZE_QUEUE_OPTIONS, deadLetter: CUTOFF_DEAD_LETTER_QUEUE } as const;
export const CUTOFF_QUEUE_REGISTRATIONS = [
  { name: CUTOFF_DEAD_LETTER_QUEUE, options: CUTOFF_DEAD_LETTER_QUEUE_OPTIONS, expected: { ...CUTOFF_DEAD_LETTER_QUEUE_OPTIONS, deadLetter: null } },
  { name: CUTOFF_QUEUE, options: CUTOFF_QUEUE_OPTIONS, expected: CUTOFF_QUEUE_OPTIONS },
] as const;
/** Every registration must verify before either consumer starts. Existing queues are never updated. */
export const WORKLOOM_QUEUE_REGISTRATIONS = [...RECURRENCE_QUEUE_REGISTRATIONS, ...CUTOFF_QUEUE_REGISTRATIONS] as const;

export interface QueueOptionMismatch {
  readonly property: string;
  readonly expected: string | number | boolean | null;
  readonly actual: unknown;
}

/**
 * Compares every expected option with the queue pg-boss reports (`getQueue()`), by
 * strict equality; a missing property is always a mismatch and null matches only an
 * expected null. Extra reported properties (counts, name, timestamps) are ignored.
 */
export function findQueueOptionMismatches(
  expected: Readonly<Record<string, string | number | boolean | null>>,
  actual: object,
): QueueOptionMismatch[] {
  const reported = actual as Readonly<Record<string, unknown>>;
  return Object.entries(expected)
    .filter(([property, value]) => reported[property] !== value)
    .map(([property, value]) => ({ property, expected: value, actual: reported[property] }));
}

const QUEUE_SCHEMA_LOCK = 'workloom:queue-schema';
const APPLICATION_NAME = 'workloom-queue-migrate';
/** Prefix pg-boss puts on every post-COMMIT index build it inlines into an exported migration plan. */
const INLINED_BUILD_MARKER = '-- inlined from ';

export class QueueSchemaStateError extends Error {
  override readonly name = 'QueueSchemaStateError';
}

export interface MigrateWorkloomQueueOptions {
  /** Reject non-loopback database servers. Default true: local synthetic tooling only. */
  readonly requireLoopback?: boolean;
}

export interface WorkloomQueueMigrationResult {
  readonly schema: typeof WORKLOOM_QUEUE_SCHEMA;
  /** Schema version read back from the database after the run. */
  readonly version: number;
  readonly action: 'installed' | 'upgraded' | 'current';
  readonly queueName: typeof RECURRENCE_MATERIALIZE_QUEUE;
  readonly queueNames: readonly string[];
  /** Only returned after all four approved queue rows were read back with every approved option; any other state throws. */
  readonly queueReady: true;
  /** Credential-free target description. */
  readonly target: string;
}

export interface SplitMigrationPlan {
  /** BEGIN … COMMIT block, including pg-boss's own advisory transaction lock. */
  readonly transactional: string;
  /** CREATE/DROP INDEX CONCURRENTLY statements; each must run alone, outside any transaction. */
  readonly concurrent: readonly string[];
}

/**
 * Splits an official `getConstructionPlans()`/`getMigrationPlans()` script into its transaction and the
 * inlined CONCURRENTLY index builds pg-boss appends after COMMIT. A multi-statement
 * simple query runs in an implicit transaction block, where CONCURRENTLY is
 * rejected, so the builds have to be sent one by one. Unrecognised shapes throw.
 */
export function splitMigrationPlan(plan: string): SplitMigrationPlan {
  const boundary = plan.indexOf(`\n${INLINED_BUILD_MARKER}`);
  const transactional = boundary === -1 ? plan : plan.slice(0, boundary);
  if (!/^\s*BEGIN;/.test(transactional) || !/COMMIT;\s*$/.test(transactional)) {
    throw new QueueSchemaStateError('Refusing to run an unrecognised pg-boss plan (expected one BEGIN … COMMIT block).');
  }
  if (boundary === -1) {
    return { transactional, concurrent: [] };
  }

  const tail = plan.slice(boundary + 1).trimEnd();
  if (!tail.endsWith(';')) {
    throw new QueueSchemaStateError('Refusing to run an unrecognised pg-boss plan (unterminated index build).');
  }
  const concurrent = tail
    .slice(0, -1)
    .split(`;\n${INLINED_BUILD_MARKER}`)
    .map((statement, index) => (index === 0 ? statement : `${INLINED_BUILD_MARKER}${statement}`));
  for (const statement of concurrent) {
    if (!statement.startsWith(INLINED_BUILD_MARKER) || statement.includes(';') || !/\bINDEX CONCURRENTLY\b/.test(statement)) {
      throw new QueueSchemaStateError('Refusing to run an unrecognised pg-boss plan (unexpected post-commit statement).');
    }
  }
  return { transactional, concurrent };
}

function assertPinnedPgBoss(): void {
  if (pgBossPackage.version !== PG_BOSS_VERSION || pgBossPackage.pgboss.schema !== PG_BOSS_SCHEMA_VERSION) {
    throw new QueueSchemaStateError(
      `Installed pg-boss ${pgBossPackage.version} (schema ${pgBossPackage.pgboss.schema}) does not match the pinned ` +
        `${PG_BOSS_VERSION} (schema ${PG_BOSS_SCHEMA_VERSION}); refusing to touch the queue schema.`,
    );
  }
}

async function readSchemaVersion(sql: postgres.Sql): Promise<number | null> {
  const [presence] = await sql<{ present: boolean }[]>`
    select to_regclass(${`${WORKLOOM_QUEUE_SCHEMA}.version`}) is not null as present
  `;
  if (presence?.present !== true) {
    return null;
  }
  const rows = await sql<{ version: string | number | null }[]>`
    select version from ${sql(WORKLOOM_QUEUE_SCHEMA)}.version
  `;
  const version = rows.length === 1 ? Number(rows[0]?.version) : Number.NaN;
  if (!Number.isSafeInteger(version)) {
    throw new QueueSchemaStateError(`${WORKLOOM_QUEUE_SCHEMA}.version must hold exactly one integer schema version.`);
  }
  return version;
}

async function readPartitionTables(sql: postgres.Sql): Promise<MigrationPartition[]> {
  const rows = await sql<{ table_name: string; policy: QueuePolicy }[]>`
    select table_name, policy from ${sql(WORKLOOM_QUEUE_SCHEMA)}.queue where partition = true order by table_name
  `;
  return rows.map((row) => ({ tableName: row.table_name, policy: row.policy }));
}

/** Runs one official plan as a single simple-protocol script; pg-boss supplies BEGIN/COMMIT itself. */
async function runPlan(sql: postgres.Sql, plan: string): Promise<void> {
  try {
    await sql.unsafe(plan).simple();
  } catch (error) {
    // A failed statement leaves the plan's explicit transaction aborted on this session.
    await sql.unsafe('ROLLBACK').simple().catch(() => undefined);
    throw error;
  }
}

async function upgrade(sql: postgres.Sql, fromVersion: number): Promise<void> {
  const partitionTables = await readPartitionTables(sql);
  let plan: SplitMigrationPlan;
  try {
    plan = splitMigrationPlan(getMigrationPlans(WORKLOOM_QUEUE_SCHEMA, fromVersion, { partitionTables }));
  } catch (error) {
    if (error instanceof QueueSchemaStateError) {
      throw error;
    }
    const described = describeErrorForLog(error);
    throw new QueueSchemaStateError(
      `pg-boss ${PG_BOSS_VERSION} has no supported migration from schema ${fromVersion}` +
        `${described.message === undefined ? '' : `: ${described.message}`}`,
    );
  }

  await runPlan(sql, plan.transactional);
  for (const [index, statement] of plan.concurrent.entries()) {
    try {
      await sql.unsafe(statement).simple();
    } catch (error) {
      const described = describeErrorForLog(error);
      throw new QueueSchemaStateError(
        `${WORKLOOM_QUEUE_SCHEMA} was migrated to schema ${PG_BOSS_SCHEMA_VERSION}, but index build ` +
          `${index + 1}/${plan.concurrent.length} failed (${described.type}${described.code === undefined ? '' : ` ${described.code}`}). ` +
          'Drop any invalid index it left and finish the remaining builds before starting workers ' +
          '(`npx pg-boss doctor` and `npx pg-boss plans migrate` list them).',
      );
    }
  }
}

/**
 * Verifies the schema shape, then registers the approved queues (dead-letter queue
 * first) through pg-boss's public API on a non-migrating instance (no supervision,
 * schedules, instance registry, telemetry or handlers), reading each queue row back
 * before the next. Always stops the instance.
 */
async function registerKnownQueues(databaseUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: WORKLOOM_QUEUE_SCHEMA,
    application_name: APPLICATION_NAME,
    max: 2,
    migrate: false,
    createSchema: false,
    schedule: false,
    supervise: false,
    registerInstance: false,
    openTelemetry: { enabled: false },
  });
  let backgroundError: Error | undefined;
  boss.on('error', (error) => {
    backgroundError ??= error;
  });

  try {
    await boss.start();

    const drift = await boss.detectSchemaDrift();
    if (!drift.ok) {
      throw new QueueSchemaStateError(
        `${WORKLOOM_QUEUE_SCHEMA} differs from pg-boss ${PG_BOSS_VERSION}: ` +
          `${drift.missingTables.length} missing table(s), ${drift.missing.length} missing index(es), ` +
          `${drift.invalid.length} invalid index(es), ${drift.mismatched.length} mismatched index(es), ` +
          `${drift.missingFunctions.length + drift.mismatchedFunctions.length} function difference(s), ` +
          `${drift.columnDrift.length + drift.constraintDrift.length} table definition difference(s)` +
          `${drift.enumDrift === null ? '' : ', job_state enum drift'}. Run \`npx pg-boss doctor\` with schema ${WORKLOOM_QUEUE_SCHEMA}.`,
      );
    }

    // Sequential: each queue is read back and verified before the next one may reference it.
    for (const { name, options, expected } of WORKLOOM_QUEUE_REGISTRATIONS) {
      const existing = await boss.getQueue(name);
      if (existing === null) {
        await boss.createQueue(name, options);
      }
      const queue = await boss.getQueue(name);
      if (queue === null) {
        throw new QueueSchemaStateError(`Queue ${name} is missing after registration.`);
      }
      const mismatches = findQueueOptionMismatches(expected, queue);
      if (mismatches.length > 0) {
        throw new QueueSchemaStateError(
          `Queue ${name} ${existing === null ? 'was created' : 'exists'} with an incompatible configuration (` +
            mismatches
              .map(({ property, expected: want, actual }) => `${property}: expected ${JSON.stringify(want)}, found ${JSON.stringify(actual ?? null)}`)
              .join('; ') +
            '). db:queue:migrate never updates an existing queue; reconcile it explicitly before starting workers.',
        );
      }
    }
    if (backgroundError !== undefined) {
      const described = describeErrorForLog(backgroundError);
      throw new QueueSchemaStateError(
        `pg-boss reported an error during queue registration (${described.type}${described.code === undefined ? '' : ` ${described.code}`}` +
          `${described.message === undefined ? '' : `: ${described.message}`}).`,
      );
    }
  } finally {
    await boss.stop({ close: true, graceful: false });
  }
}

/**
 * Installs (official construction plan), upgrades (official migration plan from
 * the actual version, with the actual partition tables) or confirms the
 * `workloom_queue` schema at the pinned pg-boss version, then registers and
 * verifies the approved queue. Refuses newer-than-pinned schemas. Concurrent runs
 * serialize on a session advisory lock; every connection is closed on return.
 */
export async function migrateWorkloomQueue(
  databaseUrl: string | undefined,
  options: MigrateWorkloomQueueOptions = {},
): Promise<WorkloomQueueMigrationResult> {
  const info = parseDatabaseUrl(databaseUrl, { requireLoopback: options.requireLoopback ?? true });
  assertPinnedPgBoss();

  const sql = postgres(info.url, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: { application_name: APPLICATION_NAME },
  });
  try {
    await sql`select pg_advisory_lock(hashtextextended(${QUEUE_SCHEMA_LOCK}::text, 0))`;
    try {
      const before = await readSchemaVersion(sql);
      let action: WorkloomQueueMigrationResult['action'];
      if (before === null) {
        const plan = splitMigrationPlan(getConstructionPlans(WORKLOOM_QUEUE_SCHEMA, { createSchema: true }));
        if (plan.concurrent.length > 0) {
          throw new QueueSchemaStateError('Refusing to run a pg-boss construction plan with post-commit statements.');
        }
        await runPlan(sql, plan.transactional);
        action = 'installed';
      } else if (before > PG_BOSS_SCHEMA_VERSION) {
        throw new QueueSchemaStateError(
          `Refusing to touch ${WORKLOOM_QUEUE_SCHEMA}: schema ${before} is newer than pinned pg-boss ${PG_BOSS_VERSION} (schema ${PG_BOSS_SCHEMA_VERSION}).`,
        );
      } else if (before < PG_BOSS_SCHEMA_VERSION) {
        await upgrade(sql, before);
        action = 'upgraded';
      } else {
        action = 'current';
      }

      const after = await readSchemaVersion(sql);
      if (after !== PG_BOSS_SCHEMA_VERSION) {
        throw new QueueSchemaStateError(
          `${WORKLOOM_QUEUE_SCHEMA} is at schema ${after ?? 'none'} after the run; expected ${PG_BOSS_SCHEMA_VERSION}.`,
        );
      }

      await registerKnownQueues(info.url);
      return {
        schema: WORKLOOM_QUEUE_SCHEMA,
        version: after,
        action,
        queueName: RECURRENCE_MATERIALIZE_QUEUE,
        queueNames: WORKLOOM_QUEUE_REGISTRATIONS.map(({ name }) => name),
        queueReady: true,
        target: info.description,
      };
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${QUEUE_SCHEMA_LOCK}::text, 0))`.catch(() => undefined);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
