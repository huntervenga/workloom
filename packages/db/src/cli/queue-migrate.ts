/**
 * `npm run db:queue:migrate` — installs or upgrades the pg-boss `workloom_queue`
 * schema in the local synthetic database and registers the known queues. The
 * only command that changes the queue schema; workers never migrate it. Safe to
 * repeat; concurrent runs serialize on an advisory lock. Accepts only
 * APP_ENV=local and a loopback server.
 */
import { DatabaseConfigError } from '../database-url.js';
import { describeErrorForLog } from '../database-errors.js';
import { UnsafeEnvironmentError, assertLocalSyntheticEnvironment } from '../env-guard.js';
import { QueueSchemaStateError, migrateWorkloomQueue } from '../queue/schema.js';
import { loadRepositoryEnv, printFailure } from './repo-env.js';

async function main(): Promise<void> {
  loadRepositoryEnv();
  assertLocalSyntheticEnvironment(process.env, 'db:queue:migrate');
  const result = await migrateWorkloomQueue(process.env.DATABASE_URL, { requireLoopback: true });
  const schemaState =
    result.action === 'current'
      ? `schema ${result.schema} is up to date (pg-boss schema ${result.version})`
      : `${result.action} schema ${result.schema} at pg-boss schema ${result.version}`;
  process.stdout.write(`db:queue:migrate: ${schemaState} on ${result.target}; queues ${result.queueNames.join(', ')} are ready.\n`);
}

main().catch((error: unknown) => {
  if (error instanceof DatabaseConfigError || error instanceof UnsafeEnvironmentError || error instanceof QueueSchemaStateError) {
    printFailure('db:queue:migrate', [error.message]);
  } else {
    const described = describeErrorForLog(error);
    printFailure('db:queue:migrate', [
      `${described.type}${described.code === undefined ? '' : ` (${described.code})`}${
        described.message === undefined ? '' : `: ${described.message}`
      }`,
      'Check that PostgreSQL is running (npm run db:up) and that DATABASE_URL is correct.',
    ]);
  }
  process.exitCode = 1;
});
