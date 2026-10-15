/**
 * `npm run db:seed:demo` — inserts the synthetic demo fixtures into the local
 * database. Idempotent and non-destructive; refuses non-local environments,
 * remote servers and databases whose migrations are not current.
 */
import { createDatabase } from '../client.js';
import { DatabaseConfigError } from '../database-url.js';
import { describeErrorForLog } from '../database-errors.js';
import { UnsafeEnvironmentError, assertLocalSyntheticEnvironment } from '../env-guard.js';
import { MigrationStateError, inspectMigrationState } from '../migrations.js';
import { seedDemoData, type SeedTableResult } from '../seed/demo-seed.js';
import { loadRepositoryEnv, printFailure } from './repo-env.js';

function summary(label: string, result: SeedTableResult): string {
  return `${label}: ${result.inserted} inserted, ${result.alreadyPresent} already present`;
}

async function main(): Promise<void> {
  loadRepositoryEnv();
  assertLocalSyntheticEnvironment(process.env, 'db:seed:demo');
  const database = createDatabase(process.env.DATABASE_URL ?? '', {
    requireLoopback: true,
    maxConnections: 1,
    applicationName: 'workloom-seed',
  });
  try {
    const state = await inspectMigrationState(database.sql);
    if (state.status !== 'current') {
      throw new MigrationStateError(`Database migrations are ${state.status}; run npm run db:migrate first.`);
    }
    const result = await seedDemoData(database);
    process.stdout.write(
      `db:seed:demo: ${database.info.description}\n` +
        `  ${summary('users', result.users)}\n` +
        `  ${summary('workspaces', result.workspaces)}\n` +
        `  ${summary('memberships', result.memberships)}\n`,
    );
    for (const item of result.drift) {
      process.stdout.write(`  warning: ${item}; left unchanged\n`);
    }
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof DatabaseConfigError || error instanceof UnsafeEnvironmentError || error instanceof MigrationStateError) {
    printFailure('db:seed:demo', [error.message]);
  } else {
    const described = describeErrorForLog(error);
    printFailure('db:seed:demo', [
      `${described.type}${described.code === undefined ? '' : ` (${described.code})`}${
        described.message === undefined ? '' : `: ${described.message}`
      }`,
      'Check that PostgreSQL is running (npm run db:up) and that DATABASE_URL is correct.',
    ]);
  }
  process.exitCode = 1;
});
