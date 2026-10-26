import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { MIGRATIONS_FOLDER, readExpectedMigrations, runMigrations } from '@workloom/db';
import { rawRequest } from '../tests/integration/support/http.ts';
import { createThrowawayDatabase } from '../tests/integration/support/test-database.ts';

// Run after building the API: TEST_DATABASE_URL=... node --import tsx --test scripts/hosted-startup.integration.test.mjs
// The child runs the real compiled hosted entrypoint. Only its private DB hostname
// is mapped to the isolated loopback test server; config/auth/migrations are not mocked.
test('compiled hosted API upgrades the old schema before serving, repeats and refuses changed history', { timeout: 90_000 }, async () => {
  const db = await createThrowawayDatabase('hosted_startup');
  const folder = await mkdtemp(join(tmpdir(), 'workloom-hosted-startup-'));
  const children = [];
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  try {
    const previousFolder = join(folder, 'migrations');
    await cp(MIGRATIONS_FOLDER, previousFolder, { recursive: true });
    const journalFile = join(previousFolder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8'));
    const settingsIndex = journal.entries.findIndex(entry => entry.tag === '0034_user_settings');
    assert(settingsIndex > 0);
    journal.entries = journal.entries.slice(0, settingsIndex);
    await writeFile(journalFile, JSON.stringify(journal));
    await runMigrations(db.url, { migrationsFolder: previousFolder, requireLoopback: true });
    await db.sql`INSERT INTO users (id, display_name, kind) VALUES ('00000000-0000-4000-8000-000000000001', 'Retained person', 'real')`;
    const users = await db.sql`SELECT * FROM users`;
    assert.equal((await db.sql`SELECT to_regclass('public.user_settings') AS name`)[0].name, null);

    const hook = join(folder, 'private-dns.mjs');
    await writeFile(hook, `import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
const lookup = dns.lookup;
dns.lookup = (hostname, ...args) => {
  if (hostname === '0.0.0.0' || hostname === '127.0.0.1') return lookup.call(dns, hostname, ...args);
  if (hostname !== 'startup-fixture.railway.internal') throw new Error('Unexpected external DNS in test');
  return lookup.call(dns, '127.0.0.1', ...args);
};
syncBuiltinESMExports();
`);
    const url = new URL(db.url);
    url.hostname = 'startup-fixture.railway.internal';

    async function launch() {
      const portServer = createServer();
      portServer.listen(0, '127.0.0.1');
      await once(portServer, 'listening');
      const port = portServer.address().port;
      await new Promise(resolve => portServer.close(resolve));
      const child = spawn(process.execPath, ['--import', hook, 'apps/api/dist/main.js'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: {
          PATH: process.env.PATH ?? '', APP_ENV: 'production', NODE_ENV: 'production', AUTH_MODE: 'shared',
          HOST: '0.0.0.0', PORT: String(port), DATABASE_URL: url.href,
          AUTH_BASE_URL: 'https://auth.example.com', AUTH_ISSUER: 'https://auth.example.com', AUTH_AUDIENCE: 'pet-projects',
          AUTH_APP_ORIGIN: 'https://workloom.example.com', AUTH_SESSION_KEY: Buffer.alloc(32, 17).toString('base64url'),
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let output = '';
      child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      const baseUrl = `http://127.0.0.1:${port}`;
      return { child, baseUrl, output: () => output };
    }

    async function waitForReady(api) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        assert.equal(api.child.exitCode, null, api.output());
        try {
          const response = await rawRequest(api.baseUrl, '/healthz/ready', { headers: { host: 'workloom.example.com' } });
          assert.equal(response.status, 200, response.text());
          assert.deepEqual(response.json(), { status: 'ok', checks: { database: 'ok', schema: 'ok' } });
          return;
        } catch (error) {
          if (error.code !== 'ECONNREFUSED') throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail(`API readiness timed out: ${api.output()}`);
    }

    for (const appliedCount of [readExpectedMigrations().length - settingsIndex, 0]) {
      const api = await launch();
      await waitForReady(api);
      const receipt = api.output().split('\n').filter(Boolean).map(line => JSON.parse(line))
        .find(line => line.event === 'HOSTED_MIGRATION_COMPLETE');
      assert.equal(receipt.appliedCount, appliedCount);
      assert.equal(receipt.phase, 'startup');
      assert.equal(receipt.expectedCount, readExpectedMigrations().length);
      assert.deepEqual(await db.sql`SELECT * FROM users`, users);
      assert.equal((await db.sql`SELECT count(*)::integer AS count FROM user_settings`)[0].count, 0);
      await stop(api.child);
    }

    await db.sql`UPDATE drizzle.__drizzle_migrations SET hash = ${'0'.repeat(64)} WHERE id = (SELECT min(id) FROM drizzle.__drizzle_migrations)`;
    const ledger = await db.sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
    const rejected = await launch();
    const [code] = await once(rejected.child, 'exit');
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(rejected.output()), {
      error: 'HOSTED_MIGRATION_FAILED', phase: 'startup', reason: 'MIGRATION_HISTORY_INVALID',
    });
    await assert.rejects(rawRequest(rejected.baseUrl, '/healthz/live'), { code: 'ECONNREFUSED' });
    assert.deepEqual(await db.sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`, ledger);
    assert.deepEqual(await db.sql`SELECT * FROM users`, users);
  } finally {
    await Promise.all(children.map(stop));
    await db.drop();
    await rm(folder, { recursive: true, force: true });
  }
});
