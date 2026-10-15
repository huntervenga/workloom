/**
 * `npm run db:migrate` — applies reviewed migrations to the local synthetic
 * database. Safe to repeat; concurrent runs serialize on an advisory lock.
 * P0 accepts only APP_ENV=local and a loopback server; the P6 Railway
 * migration job will add its own explicitly configured mode.
 */
import { DatabaseConfigError } from '../database-url.js';
import { describeErrorForLog } from '../database-errors.js';
import { UnsafeEnvironmentError, assertLocalSyntheticEnvironment } from '../env-guard.js';
import { MigrationStateError, runMigrations } from '../migrations.js';
import { loadRepositoryEnv, printFailure } from './repo-env.js';

async function main(): Promise<void> {
  loadRepositoryEnv();
  assertLocalSyntheticEnvironment(process.env, 'db:migrate');
  const result = await runMigrations(process.env.DATABASE_URL, { requireLoopback: true });
  if (result.appliedNow.length === 0) {
    process.stdout.write(`db:migrate: ${result.target} is up to date (${result.state.appliedCount} migration(s)).\n`);
  } else {
    process.stdout.write(
      `db:migrate: applied ${result.appliedNow.join(', ')} to ${result.target} ` +
        `(${result.state.appliedCount} migration(s) total).\n`,
    );
  }
}

main().catch((error: unknown) => {
  if (error instanceof DatabaseConfigError || error instanceof UnsafeEnvironmentError || error instanceof MigrationStateError) {
    printFailure('db:migrate', [error.message]);
  } else {
    const described = describeErrorForLog(error);
    printFailure('db:migrate', [
      `${described.type}${described.code === undefined ? '' : ` (${described.code})`}${
        described.message === undefined ? '' : `: ${described.message}`
      }`,
      'Check that PostgreSQL is running (npm run db:up) and that DATABASE_URL is correct.',
    ]);
  }
  process.exitCode = 1;
});
