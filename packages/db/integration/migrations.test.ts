import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inspectMigrationState, MigrationStateError, readExpectedMigrations, runMigrations } from '../src/migrations.js';
import { createReadinessProbe } from '../src/readiness.js';
import { REQUIRED_TABLES } from '../src/schema.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support.js';

describe('migrations on real PostgreSQL', () => {
  let target: ThrowawayDatabase;
  const expectedMigrations = readExpectedMigrations();
  async function expectExactLedger(): Promise<void> {
    const rows = await target.database.sql<{ hash: string; created_at: string }[]>`
      select hash, created_at::text from drizzle.__drizzle_migrations order by created_at, id
    `;
    expect(Array.from(rows, row => ({ hash: row.hash, createdAt: Number(row.created_at) }))).toEqual(
      expectedMigrations.map(migration => ({ hash: migration.hash, createdAt: migration.createdAt })),
    );
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase('migrations');
  });

  afterAll(async () => {
    await target?.drop();
  });

  it('reports an empty database as uninitialized and not ready', async () => {
    expect((await inspectMigrationState(target.database.sql)).status).toBe('uninitialized');
    const report = await createReadinessProbe(target.database).check();
    expect(report.ready).toBe(false);
    expect(report.checks).toEqual({ database: 'ok', schema: 'failed' });
  });

  it('applies the schema to an empty database', async () => {
    const result = await runMigrations(target.url, { requireLoopback: true });
    expect(result.appliedNow).toEqual(expectedMigrations.map(migration => migration.tag));
    await expectExactLedger();
    expect(result.state.status).toBe('current');
    expect(result.target).not.toContain('@');

    const tables = await target.database.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([...REQUIRED_TABLES].sort());
  });

  it('detects that nothing is pending on a repeated run', async () => {
    const again = await runMigrations(target.url, { requireLoopback: true });
    expect(again.appliedNow).toEqual([]);
    expect(again.state).toMatchObject({ status: 'current', appliedCount: expectedMigrations.length, expectedCount: expectedMigrations.length });
    await expectExactLedger();
  });

  it('serializes concurrent runs without duplicating history', async () => {
    const results = await Promise.all([
      runMigrations(target.url, { requireLoopback: true }),
      runMigrations(target.url, { requireLoopback: true }),
    ]);
    expect(results.every((result) => result.appliedNow.length === 0)).toBe(true);
    await expectExactLedger();
  });

  it('is ready only with the exact migration history and required tables', async () => {
    const report = await createReadinessProbe(target.database).check();
    expect(report).toMatchObject({ ready: true, checks: { database: 'ok', schema: 'ok' } });
  });

  it('enforces the documented constraints', async () => {
    const sql = target.database.sql;
    await expect(sql`insert into users (id, display_name, kind) values (gen_random_uuid(), 'Real Person', 'person')`).rejects.toMatchObject({
      code: '22P02',
    });
    await expect(sql`insert into users (id, display_name, kind) values (gen_random_uuid(), '   ', 'fixture')`).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      sql`insert into workspaces (id, name, timezone, week_start) values (gen_random_uuid(), 'Synthetic', 'UTC', 8)`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`insert into workspaces (id, name, timezone) values (gen_random_uuid(), 'Synthetic', 'not a zone; drop')`,
    ).rejects.toMatchObject({ code: '23514' });

    await sql.begin(async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        insert into users (id, display_name, kind) values (gen_random_uuid(), 'Synthetic Check', 'fixture') returning id
      `;
      const [workspace] = await tx<{ id: string }[]>`
        insert into workspaces (id, name, timezone) values (gen_random_uuid(), 'Synthetic Check', 'UTC') returning id
      `;
      await tx`insert into memberships (id, workspace_id, user_id, role) values (gen_random_uuid(), ${workspace?.id ?? ''}, ${user?.id ?? ''}, 'member')`;
      await expect(
        tx`insert into memberships (id, workspace_id, user_id, role) values (gen_random_uuid(), ${workspace?.id ?? ''}, ${user?.id ?? ''}, 'viewer')`,
      ).rejects.toMatchObject({ code: '23505' });
      throw new RollbackSignal();
    }).catch((error: unknown) => {
      if (!(error instanceof RollbackSignal)) throw error;
    });
  });

  it('refuses to migrate a database with unknown newer history', async () => {
    await target.database.sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('future', 9999999999999)`;
    expect((await inspectMigrationState(target.database.sql)).status).toBe('ahead');
    await expect(runMigrations(target.url, { requireLoopback: true })).rejects.toBeInstanceOf(MigrationStateError);
    const report = await createReadinessProbe(target.database).check();
    expect(report).toMatchObject({ ready: false, checks: { database: 'ok', schema: 'failed' } });
    await target.database.sql`delete from drizzle.__drizzle_migrations where hash = 'future'`;
  });
});

class RollbackSignal extends Error {}
