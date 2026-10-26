import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { MigrationStateError } from '@workloom/db';
import { migrateHosted, migrationFailure } from './hosted-migrate.mjs';

const hosted = { appEnv: 'production', authMode: 'shared', database: { isLoopback: false, url: 'postgres://fixture:secret@postgres.railway.internal/workloom' } };
const first = { tag: '0000_fixture', createdAt: 1, hash: 'a'.repeat(64) };
const second = { tag: '0001_fixture', createdAt: 2, hash: 'b'.repeat(64) };
const sha = entries => createHash('sha256').update(JSON.stringify(entries)).digest('hex');
function fixture(entries = [first], config = hosted) {
  const calls = [];
  return { calls, dependencies: {
    loadConfig: () => config,
    readExpectedMigrations: () => entries,
    runMigrations: async (url, options) => {
      calls.push({ url, options });
      return { state: { status: 'current' }, appliedNow: entries.map(entry => entry.tag) };
    },
  } };
}

test('automatic mode follows the image journal when new migrations are added', async () => {
  for (const entries of [[first], [first, second]]) {
    const f = fixture(entries);
    const result = await migrateHosted(['--apply'], {}, f.dependencies);
    assert.equal(result.expectedCount, entries.length);
    assert.equal(result.manifestSha, sha(entries));
    assert.deepEqual(result.appliedMigrations, entries.map(entry => entry.tag));
    assert.equal(result.passed, true);
    assert.deepEqual(f.calls, [{ url: hosted.database.url, options: { requireLoopback: false } }]);
    assert(!JSON.stringify(result).includes('secret'));
  }
});

test('explicit count/hash pinning remains compatible and mismatches do not reach the database', async () => {
  const f = fixture();
  await migrateHosted(['--apply', '--expect-count', '1', '--expect-manifest-sha', sha([first])], {}, f.dependencies);
  assert.equal(f.calls.length, 1);
  for (const [count, hash] of [['2', sha([first])], ['1', '0'.repeat(64)]]) {
    const rejected = fixture();
    await assert.rejects(migrateHosted(['--apply', '--expect-count', count, '--expect-manifest-sha', hash], {}, rejected.dependencies), /MIGRATION_MANIFEST_MISMATCH/);
    assert.equal(rejected.calls.length, 0);
  }
});

test('missing, incomplete and extra arguments fail before configuration or database access', async () => {
  for (const args of [[], ['--auto'], ['--apply', '--force'], ['--apply', '--expect-count', '1'], ['--apply', '--expect-count', '1', '--expect-manifest-sha', 'bad']]) {
    await assert.rejects(migrateHosted(args, {}, { loadConfig: () => assert.fail('configuration must not be read') }), /MIGRATION_ARGUMENTS_REQUIRED/);
  }
});

test('automatic mode retains local, dev identity and loopback exclusions', async () => {
  for (const config of [{ ...hosted, appEnv: 'local' }, { ...hosted, authMode: 'dev' }, { ...hosted, database: { ...hosted.database, isLoopback: true } }]) {
    const f = fixture([first], config);
    await assert.rejects(migrateHosted(['--apply'], {}, f.dependencies), /HOSTED_ONLY/);
    assert.equal(f.calls.length, 0);
  }
});

test('migration failures propagate and diagnostics do not expose SQL or credentials', async () => {
  const error = Object.assign(new Error('SQL containing secret and postgres://fixture:secret@host/db'), { code: '42P01' });
  const f = fixture();
  f.dependencies.runMigrations = async () => { throw error; };
  await assert.rejects(migrateHosted(['--apply'], {}, f.dependencies), candidate => candidate === error);
  assert.deepEqual(migrationFailure(error), { error: 'HOSTED_MIGRATION_FAILED', reason: 'MIGRATION_FAILED', code: '42P01' });
  assert.equal(migrationFailure(new MigrationStateError('diverged')).reason, 'MIGRATION_HISTORY_INVALID');
  assert(!JSON.stringify(migrationFailure(new Error('secret'))).includes('secret'));
});

test('CLI failures return nonzero and the pre-deploy command requires no version edits', () => {
  const child = spawnSync(process.execPath, ['scripts/hosted-migrate.mjs'], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.deepEqual(JSON.parse(child.stderr), { error: 'HOSTED_MIGRATION_FAILED', reason: 'MIGRATION_ARGUMENTS_REQUIRED' });
  const config = JSON.parse(readFileSync(new URL('../railway.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.deploy.preDeployCommand, ['node scripts/hosted-migrate.mjs --apply']);
});
