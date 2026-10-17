// An owned synthetic child only: populated pre-Auth schema -> additive Auth migration.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, createSharedAuthStore, createTaskApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type Database } from '@workloom/db';
import { expect, it } from 'vitest';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
const migrations = fileURLToPath(new URL('../../packages/db/migrations/', import.meta.url));

it('upgrades populated 0013 to 0014 without changing any legacy public row or migration receipt', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workloom-auth-upgrade-'));
  let target: ThrowawayDatabase | undefined;
  let db: Database | undefined;
  try {
    const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const prefix = journal.entries.filter(entry => entry.idx < 14);
    expect(prefix).toHaveLength(14);
    expect(prefix.at(-1)?.tag).toMatch(/^0013_/);
    await mkdir(join(folder, 'meta'));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: prefix }));
    for (const entry of prefix) await copyFile(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    target = await createThrowawayDatabase('shared_auth_upgrade');
    const old = await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder });
    expect(old.state.appliedCount).toBe(14);
    db = createDatabase(target.url, { requireLoopback: true });
    await seedDemoData(db);
    // The base identity seed deliberately has no tasks. Populate the old schema
    // through its ordinary domain commands before taking the preservation snapshot.
    const app = createTaskApplication(db);
    const context = () => ({ workspaceId: FIXTURE_WORKSPACE_IDS.team,
      actor: { userId: FIXTURE_USER_IDS.owner, displayName: 'Synthetic Owner', kind: 'fixture' as const },
      source: 'web' as const, requestId: randomUUID(), idempotencyKey: randomUUID() });
    const project = await app.createProject(context(), { name: 'Populated pre-Auth project' });
    const todo = (await app.listStatuses(context(), project.id)).find(status => status.group === 'todo');
    if (!todo) throw new Error('Expected a default todo status on the old schema.');
    const section = await app.createSection(context(), project.id, { name: 'Preserved legacy section' });
    const tag = await app.createTag(context(), { name: 'Preserved legacy tag' });
    const parent = await app.createTask(context(), { projectId: project.id, statusId: todo.id, sectionId: section.id,
      title: 'Preserved parent', estimateMinutes: 120, dueDate: '2026-10-24', tagIds: [tag.id] });
    await app.createTask(context(), { projectId: project.id, statusId: todo.id, parentTaskId: parent.id,
      title: 'Preserved child sharing its work package', dueDate: '2026-10-23' });
    const tables = await db.sql<{ name: string }[]>`select tablename as name from pg_tables where schemaname='public' order by tablename`;
    expect(tables).toHaveLength(60);
    const sql = db.sql;
    async function legacyRows() {
      const rows: Record<string, string[]> = {};
      for (const { name } of tables) {
        // Names come only from pg_catalog; escape identifiers rather than interpolating values as SQL.
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const values = await sql.unsafe<{ row: unknown }[]>(`select to_jsonb(t) as row from public.${quoted} t`);
        rows[name] = values.map(value => JSON.stringify(value.row)).sort();
      }
      return rows;
    }
    const before = await legacyRows();
    expect(before['tasks']?.length).toBe(2);
    expect(before['audit_events']?.length).toBeGreaterThan(0);
    expect(before['command_idempotency']?.length).toBeGreaterThan(0);
    expect(before['memberships']?.length).toBeGreaterThan(0);
    const receipts = await db.sql`select * from drizzle.__drizzle_migrations order by id`;
    // Keep this historical Auth upgrade bounded to0014 as later additive migrations arrive.
    const authPrefix = journal.entries.filter(entry => entry.idx <= 14);
    for (const entry of authPrefix.filter(entry => entry.idx === 14)) {
      await copyFile(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: authPrefix }));
    const upgraded = await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder });
    expect(upgraded.appliedNow).toEqual(['0014_shared_auth']);
    expect(await legacyRows()).toEqual(before);
    const afterReceipts = await db.sql`select * from drizzle.__drizzle_migrations order by id`;
    expect(afterReceipts.slice(0, receipts.length)).toEqual(receipts);
    expect(afterReceipts).toHaveLength(receipts.length + 1);
    for (const name of ['shared_auth_identities', 'shared_auth_sessions', 'shared_auth_login_attempts']) {
      const count = await db.sql.unsafe<{ count: number }[]>(`select count(*)::int as count from public.${name}`);
      expect(count).toEqual([{ count: 0 }]);
    }
    // The committed enum value must also work after the additive migration completes.
    const principal = await createSharedAuthStore(db).provisionIdentity({ issuer: 'https://auth.example.test', subject: 'upgrade-user', displayName: 'Upgrade user', workspaceName: 'Empty upgraded workspace', timezone: 'UTC' });
    expect(principal.user.kind).toBe('real');
    expect(await db.sql`select id from tasks where workspace_id=${principal.workspaceId}`).toHaveLength(0);
    expect(await legacyRows().then(rows => Object.fromEntries(tables.filter(table => !['users', 'workspaces', 'memberships'].includes(table.name)).map(table => [table.name, rows[table.name]]))))
      .toEqual(Object.fromEntries(tables.filter(table => !['users', 'workspaces', 'memberships'].includes(table.name)).map(table => [table.name, before[table.name]])));
    expect((await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder })).appliedNow).toEqual([]);
  } finally {
    await db?.close();
    await target?.drop();
    await rm(folder, { recursive: true, force: true });
  }
});
