/** Explicit operator-only hosted migration. No dotenv, seed, worker or startup hook. */
import { createHash } from 'node:crypto';
import { readExpectedMigrations, runMigrations } from '@workloom/db';
import { loadConfig } from '../apps/api/dist/config.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== '--apply' || args[1] !== '--expect-count' ||
    !/^[1-9]\d*$/.test(args[2] ?? '') || args[3] !== '--expect-manifest-sha' || !/^[a-f0-9]{64}$/.test(args[4] ?? '')) {
    throw new Error('MIGRATION_ARGUMENTS_REQUIRED');
  }
  const config = loadConfig(process.env);
  if (config.appEnv === 'local' || config.authMode !== 'shared' || config.database.isLoopback) throw new Error('HOSTED_ONLY');
  const expected = readExpectedMigrations();
  const manifestSha = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  if (expected.length !== Number(args[2]) || manifestSha !== args[4]) throw new Error('MIGRATION_MANIFEST_MISMATCH');
  const result = await runMigrations(config.database.url, { requireLoopback: false });
  process.stdout.write(`${JSON.stringify({ passed: result.state.status === 'current', appliedCount: result.appliedNow.length, expectedCount: expected.length, manifestSha })}\n`);
}
main().catch(() => { process.stderr.write('HOSTED_MIGRATION_FAILED\n'); process.exitCode = 1; });
