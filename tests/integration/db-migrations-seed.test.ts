// Real PostgreSQL: migrations from an empty database and the demo seed, each applied twice.
// Runs the same CLIs as `npm run db:migrate` / `npm run db:seed:demo`.
import { DEMO_USERS, DEMO_WORKSPACES, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS } from '@workloom/db/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { catalogSnapshot, idSets, rowCounts, runDbCli, userTables } from './support/db-cli.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

// Fails the file at collection time when TEST_DATABASE_URL is missing or unsafe.
requireTestDatabaseUrl();

describe('migrations and demo seed on an empty database', () => {
  let db: ThrowawayDatabase;

  beforeAll(async () => {
    db = await createThrowawayDatabase('migrate');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('starts from a database without user tables, and the seed refuses to run before migrations', async () => {
    expect(await userTables(db.sql)).toEqual([]);
    const seed = await runDbCli('seed-demo', db.url);
    expect(seed.code, seed.output).toBe(1);
    expect(seed.output).toContain('run npm run db:migrate first');
    expect(await userTables(db.sql)).toEqual([]);
  });

  it('applies migrations, then a second run changes neither schema nor migration journal', async () => {
    const first = await runDbCli('migrate', db.url);
    expect(first.code, first.output).toBe(0);
    const schemaAfterFirst = await catalogSnapshot(db.sql);
    const countsAfterFirst = await rowCounts(db.sql);
    expect(Object.keys(countsAfterFirst).length).toBeGreaterThan(1);

    const second = await runDbCli('migrate', db.url);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain('is up to date');
    expect(await catalogSnapshot(db.sql)).toEqual(schemaAfterFirst);
    // Includes the migration journal table: a re-applied migration would add a row.
    expect(await rowCounts(db.sql)).toEqual(countsAfterFirst);
  });

  it('seeds synthetic data, and a second seed keeps the same rows and stable ids', async () => {
    const before = await rowCounts(db.sql);
    const first = await runDbCli('seed-demo', db.url);
    expect(first.code, first.output).toBe(0);
    const countsAfterFirst = await rowCounts(db.sql);
    const idsAfterFirst = await idSets(db.sql);
    expect(countsAfterFirst).not.toEqual(before);

    const second = await runDbCli('seed-demo', db.url);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain(`users: 0 inserted, ${DEMO_USERS.length} already present`);
    expect(second.output).not.toContain('warning:');
    expect(await rowCounts(db.sql)).toEqual(countsAfterFirst);
    expect(await idSets(db.sql)).toEqual(idsAfterFirst);
  });

  it('holds exactly two workspaces: six team members, and an outsider only in the second', async () => {
    const workspaces = await db.sql<{ id: string; name: string }[]>`select id, name from workspaces order by id`;
    expect(workspaces).toEqual(DEMO_WORKSPACES.map(({ id, name }) => ({ id, name })));
    expect(await db.sql`select id from users order by id`).toHaveLength(DEMO_USERS.length);

    const perWorkspace = await db.sql<{ workspace_id: string; active: number; total: number }[]>`
      select workspace_id, count(*) filter (where state = 'active')::int as active, count(*)::int as total
      from memberships group by workspace_id order by workspace_id`;
    expect(perWorkspace).toEqual([
      { workspace_id: FIXTURE_WORKSPACE_IDS.team, active: 6, total: 6 },
      { workspace_id: FIXTURE_WORKSPACE_IDS.outside, active: 1, total: 1 },
    ]);

    const outsider = await db.sql<{ workspace_id: string }[]>`
      select workspace_id from memberships where user_id = ${FIXTURE_USER_IDS.outsider}`;
    expect(outsider).toEqual([{ workspace_id: FIXTURE_WORKSPACE_IDS.outside }]);
    const users = await db.sql<{ kind: string }[]>`select distinct kind::text as kind from users`;
    expect(users).toEqual([{ kind: 'fixture' }]);
  });

  it('does not print database credentials while migrating or seeding', async () => {
    const password = new URL(db.url).password;
    const results = [await runDbCli('migrate', db.url), await runDbCli('seed-demo', db.url)];
    for (const result of results) {
      expect(result.code, result.output).toBe(0);
      if (password) expect(result.output).not.toContain(password);
    }
  });
});
