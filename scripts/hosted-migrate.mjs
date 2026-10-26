/** Hosted pre-deploy migration. No dotenv, seed, worker or API startup hook. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseErrorCode, MigrationStateError, readExpectedMigrations, runMigrations } from '@workloom/db';
import { loadConfig } from '../apps/api/dist/config.js';

const argumentErrors = new Set(['MIGRATION_ARGUMENTS_REQUIRED', 'HOSTED_ONLY', 'MIGRATION_MANIFEST_MISMATCH']);

/** --apply uses this image's journal; the optional count/hash pair retains manual pinning. */
export async function migrateHosted(args, env, dependencies = { loadConfig, readExpectedMigrations, runMigrations }) {
  const automatic = args.length === 1 && args[0] === '--apply';
  const pinned = args.length === 5 && args[0] === '--apply' && args[1] === '--expect-count' &&
    /^[1-9]\d*$/.test(args[2] ?? '') && args[3] === '--expect-manifest-sha' && /^[a-f0-9]{64}$/.test(args[4] ?? '');
  if (!automatic && !pinned) throw new Error('MIGRATION_ARGUMENTS_REQUIRED');

  const config = dependencies.loadConfig(env);
  if (config.appEnv === 'local' || config.authMode !== 'shared' || config.database.isLoopback) throw new Error('HOSTED_ONLY');
  const expected = dependencies.readExpectedMigrations();
  const manifestSha = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  if (pinned && (expected.length !== Number(args[2]) || manifestSha !== args[4])) throw new Error('MIGRATION_MANIFEST_MISMATCH');

  // The shared runner locks concurrent runs, validates the applied prefix and migrates atomically.
  // Automatic admission of new files never permits rewriting already applied history.
  const result = await dependencies.runMigrations(config.database.url, { requireLoopback: false });
  return {
    passed: result.state.status === 'current',
    appliedCount: result.appliedNow.length,
    appliedMigrations: result.appliedNow,
    expectedCount: expected.length,
    manifestSha,
  };
}

/** Safe diagnostics only: neither connection strings nor SQL/parameters enter deployment logs. */
export function migrationFailure(error) {
  const reason = argumentErrors.has(error?.message) ? error.message :
    error instanceof MigrationStateError ? 'MIGRATION_HISTORY_INVALID' : 'MIGRATION_FAILED';
  const code = databaseErrorCode(error);
  return { error: 'HOSTED_MIGRATION_FAILED', reason, ...(code && /^[A-Z0-9_]{2,40}$/.test(code) ? { code } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrateHosted(process.argv.slice(2), process.env)
    .then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); })
    .catch(error => { process.stderr.write(`${JSON.stringify(migrationFailure(error))}\n`); process.exitCode = 1; });
}
