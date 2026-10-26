import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readExpectedMigrations, runMigrations, MigrationStateError } from '@workloom/db';
import { createThrowawayDatabase } from '../tests/integration/support/test-database.ts';
import { migrateHosted } from './hosted-migrate.mjs';

// node --import tsx --test scripts/hosted-migrate.integration.test.mjs
// TEST_DATABASE_URL is required; the shared helper creates and drops its own child database.
test('automatic pre-deploy upgrades, repeats, serializes and refuses broken history without losing data', async () => {
  const db = await createThrowawayDatabase('hosted_predeploy');
  const folder = await mkdtemp(join(tmpdir(), 'workloom-hosted-migrations-'));
  try {
    await mkdir(join(folder, 'meta'));
    const migrations = [
      { tag: '0000_fixture', sql: 'CREATE TABLE fixture (id integer PRIMARY KEY, title text NOT NULL);' },
      { tag: '0001_fixture', sql: 'ALTER TABLE fixture ADD COLUMN color text;' },
      { tag: '0002_fixture', sql: 'ALTER TABLE fixture ADD COLUMN enabled boolean;' },
    ];
    const journal = async count => {
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: migrations.slice(0, count).map((m, idx) => ({ idx, version: '7', when: idx + 1, tag: m.tag, breakpoints: true })) }));
    };
    for (const m of migrations) await writeFile(join(folder, `${m.tag}.sql`), m.sql);
    const dependencies = {
      // Only the environment guard is synthetic; migrations use a real isolated PostgreSQL.
      loadConfig: () => ({ appEnv: 'production', authMode: 'shared', database: { isLoopback: false, url: db.url } }),
      readExpectedMigrations: () => readExpectedMigrations(folder),
      runMigrations: url => runMigrations(url, { requireLoopback: true, migrationsFolder: folder }),
    };
    const apply = () => migrateHosted(['--apply'], {}, dependencies);
    await journal(1);
    assert.equal((await apply()).appliedCount, 1);
    await db.sql`INSERT INTO fixture (id, title) VALUES (1, 'retained')`;
    await journal(2);
    assert.deepEqual((await apply()).appliedMigrations, ['0001_fixture']);
    assert.equal((await apply()).appliedCount, 0);
    await journal(3);
    const parallel = await Promise.all([apply(), apply()]);
    assert.deepEqual(parallel.map(result => result.appliedCount).sort(), [0, 1]);
    const rows = await db.sql`SELECT * FROM fixture`;
    const ledger = await db.sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
    assert.deepEqual([...rows], [{ id: 1, title: 'retained', color: null, enabled: null }]);

    await writeFile(join(folder, '0000_fixture.sql'), migrations[0].sql + '\n-- changed after deployment');
    await assert.rejects(apply(), error => error instanceof MigrationStateError && /diverged/.test(error.message));
    await writeFile(join(folder, '0000_fixture.sql'), migrations[0].sql);
    await journal(2);
    await assert.rejects(apply(), error => error instanceof MigrationStateError && /ahead/.test(error.message));

    migrations.push({ tag: '0003_broken', sql: 'CREATE TABLE must_rollback (id integer);\n--> statement-breakpoint\nINSERT INTO missing_fixture_table VALUES (1);' });
    await writeFile(join(folder, '0003_broken.sql'), migrations[3].sql);
    await journal(4);
    await assert.rejects(apply());
    assert.equal((await db.sql`SELECT to_regclass('must_rollback') AS name`)[0].name, null);
    assert.deepEqual(await db.sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`, ledger);
    assert.deepEqual(await db.sql`SELECT * FROM fixture`, rows);
  } finally {
    await db.drop();
    await rm(folder, { recursive: true, force: true });
  }
});
