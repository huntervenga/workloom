// An owned synthetic child only: populated pre-Auth schema -> additive Auth migration.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, createSharedAuthStore, runMigrations, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type Database } from '@workloom/db';
import { expect, it } from 'vitest';
import { seedLegacyDemoData, createLegacyProject, createLegacySection, createLegacyTag, createLegacyTask,
  insertLegacyFixtureOwner } from './support/legacy-upgrade-fixture.js';
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
    await seedLegacyDemoData(db.sql);
    // Current stores read columns from later migrations, so populate the old schema through explicit
    // old-schema SQL (fixture actor, project/statuses, section, tag, parent + child sharing its work
    // package, audit events and command receipts) before taking the preservation snapshot.
    const actor = await insertLegacyFixtureOwner(db.sql, { userId: FIXTURE_USER_IDS.owner, workspaceId: FIXTURE_WORKSPACE_IDS.team,
      displayName: 'Synthetic Owner', workspaceName: 'Synthetic team' });
    const project = await createLegacyProject(db.sql, actor, 'Populated pre-Auth project');
    const section = await createLegacySection(db.sql, actor, project.id, 'Preserved legacy section');
    const tag = await createLegacyTag(db.sql, actor, 'Preserved legacy tag');
    const parent = await createLegacyTask(db.sql, actor, { projectId: project.id, statusId: project.todoStatusId, sectionId: section.id,
      title: 'Preserved parent', estimateMinutes: 120, dueDate: '2026-10-24', tagIds: [tag.id] });
    const child = await createLegacyTask(db.sql, actor, { projectId: project.id, statusId: project.todoStatusId, parentTaskId: parent.id,
      title: 'Preserved child sharing its work package', dueDate: '2026-10-23' });
    expect(child.workPackageId).toBe(parent.workPackageId);
    const tables = await db.sql<{ name: string }[]>`select tablename as name from pg_tables where schemaname='public' order by tablename`;
    expect(tables).toHaveLength(60);
    const sql = db.sql;
    // Freeze the historical column set before applying any later schema; new columns must
    // not make a legacy-row preservation comparison read today's ORM shape.
    const preservedColumns = await sql<{table_name:string;column_name:string}[]>`select table_name::text,column_name::text from information_schema.columns where table_schema='public' order by table_name,ordinal_position`;
    const quotedIdentifier=(value:string)=>`"${value.replaceAll('"','""')}"`;

    async function legacyRows() {
      const rows: Record<string, string[]> = {};
      for (const { name } of tables) {
        // Names come only from pg_catalog; escape identifiers rather than interpolating values as SQL.
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const values = await sql.unsafe<{ row: unknown }[]>(`select to_jsonb(t) as row from (select ${preservedColumns.filter(c=>c.table_name===name).map(c=>quotedIdentifier(c.column_name)).join(',')} from public.${quoted}) t`);
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
    // The historical0013→0014 preservation oracle above is complete. Explicitly add the
    // remaining current migrations before exercising today's shared Auth application.
    const currentPrefix = journal.entries;
    expect(currentPrefix).toHaveLength(29);
    for (const entry of currentPrefix.filter(entry => entry.idx > 14)) {
      await copyFile(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: currentPrefix }));
    expect((await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder })).appliedNow)
      .toEqual(currentPrefix.filter(entry=>entry.idx>14).map(entry=>entry.tag));
    expect(await legacyRows()).toEqual(before);
    const currentReceipts = await db.sql`select * from drizzle.__drizzle_migrations order by id`;
    expect(currentReceipts.slice(0, afterReceipts.length)).toEqual(afterReceipts);
    expect(currentReceipts).toHaveLength(currentPrefix.length);
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
