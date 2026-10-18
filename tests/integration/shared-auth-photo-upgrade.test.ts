// A populated owned0015 child only: additive users.avatar_url must leave every legacy column value intact.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, runMigrations, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type Database } from '@workloom/db';
import { expect, it } from 'vitest';
import { createLegacyProject, createLegacySection, createLegacyTag, createLegacyTask, insertLegacyAuthPrincipal, insertLegacyAuthSession,
  insertLegacyFixtureOwner, seedLegacyDemoData, insertLegacyLoginAttempt, insertLegacyOptionalWorkspace, sha256Hex } from './support/legacy-upgrade-fixture.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
const migrations = fileURLToPath(new URL('../../packages/db/migrations/', import.meta.url));

interface ColumnShape {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

it('adds0016 users.avatar_url to populated0015 leaving every legacy row byte-exact and receipts plus one', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workloom-photo-upgrade-'));
  let target: ThrowawayDatabase | undefined;
  let db: Database | undefined;
  try {
    const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const oldPrefix = journal.entries.filter(entry => entry.idx < 16);
    expect(oldPrefix).toHaveLength(16);
    expect(oldPrefix.at(-1)?.tag).toBe('0015_workspace_creation');
    await mkdir(join(folder, 'meta'));
    for (const entry of oldPrefix) await copyFile(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: oldPrefix }));
    target = await createThrowawayDatabase('photo_upgrade');
    expect((await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder })).state.appliedCount).toBe(16);
    db = createDatabase(target.url, { requireLoopback: true });
    const sql = db.sql;
    await seedLegacyDemoData(sql);
    // Current stores already select users.avatar_url, so the0015 schema is populated with explicit SQL only.
    const fixture = await insertLegacyFixtureOwner(sql, { userId: FIXTURE_USER_IDS.owner, workspaceId: FIXTURE_WORKSPACE_IDS.team,
      displayName: 'Synthetic Owner', workspaceName: 'Synthetic team' });
    const project = await createLegacyProject(sql, fixture, 'Preserved0015 project');
    const section = await createLegacySection(sql, fixture, project.id, 'Preserved0015 section');
    const tag = await createLegacyTag(sql, fixture, 'Preserved0015 tag');
    const parent = await createLegacyTask(sql, fixture, { projectId: project.id, statusId: project.todoStatusId, sectionId: section.id,
      title: 'Preserved0015 parent', estimateMinutes: 90, dueDate: '2026-10-30', tagIds: [tag.id] });
    const child = await createLegacyTask(sql, fixture, { projectId: project.id, statusId: project.todoStatusId, parentTaskId: parent.id,
      title: 'Preserved0015 child sharing its work package', dueDate: '2026-10-29' });
    expect(child.workPackageId).toBe(parent.workPackageId);
    const principal = await insertLegacyAuthPrincipal(sql, { issuer: 'https://auth.example.test', subject: randomUUID(), displayName: 'Existing real user', workspaceName: 'Existing Auth home', timezone: 'UTC' });
    const expiry = new Date(Date.now() + 3600_000).toISOString();
    await insertLegacyAuthSession(sql, { sessionHash: sha256Hex('synthetic-photo-upgrade-session'), userId: principal.userId,
      encryptedTokens: 'synthetic-opaque-ciphertext', accessExpiresAt: expiry, expiresAt: expiry });
    await insertLegacyLoginAttempt(sql, { stateHash: sha256Hex('synthetic-photo-upgrade-state'), browserHash: sha256Hex('synthetic-photo-upgrade-browser'), returnTo: '/app', expiresAt: expiry });
    await insertLegacyOptionalWorkspace(sql, { actorUserId: principal.userId, name: 'Preserved0015 optional workspace', timezone: 'Asia/Nicosia', idempotencyKey: randomUUID() });

    const tables = await sql<{ name: string }[]>`select tablename as name from pg_tables where schemaname='public' order by tablename`;
    expect(tables).toHaveLength(64);
    const columns = () => sql<ColumnShape[]>`select table_name::text, column_name::text, data_type::text, is_nullable::text, column_default::text
      from information_schema.columns where table_schema='public' order by table_name, ordinal_position`;
    const legacyColumns = await columns();
    const selected = new Map<string, string[]>();
    for (const column of legacyColumns) selected.set(column.table_name, [...(selected.get(column.table_name) ?? []), column.column_name]);
    expect([...selected.keys()].sort()).toEqual(tables.map(table => table.name).sort());
    expect(selected.get('users')).not.toContain('avatar_url');
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    async function legacyRows() {
      const result: Record<string, string[]> = {};
      for (const { name } of tables) {
        // Only pre-0016 columns (names from information_schema, escaped); server-rendered jsonb text keeps values byte-exact.
        const list = (selected.get(name) ?? []).map(quote).join(', ');
        const values = await sql.unsafe<{ row: string }[]>(`select to_jsonb(t)::text as row from (select ${list} from public.${quote(name)}) t`);
        result[name] = values.map(value => value.row).sort();
      }
      return result;
    }
    const before = await legacyRows();
    for (const name of ['users', 'workspaces', 'memberships', 'projects', 'task_statuses', 'sections', 'workspace_tags', 'work_packages', 'tasks',
      'task_tags', 'audit_events', 'command_idempotency', 'shared_auth_identities', 'shared_auth_sessions', 'shared_auth_login_attempts',
      'workspace_creation_receipts']) {
      expect(before[name]?.length, name).toBeGreaterThan(0);
    }
    expect(before['tasks']).toHaveLength(2);
    expect(before['users']).toHaveLength(8);
    const receipts = await sql`select * from drizzle.__drizzle_migrations order by id`;
    expect(receipts).toHaveLength(16);

    const newPrefix = journal.entries.filter(entry => entry.idx <= 16);
    expect(newPrefix).toHaveLength(17);
    const addition = newPrefix.find(entry => entry.idx === 16);
    if (!addition) throw new Error('Expected the additive avatar migration.');
    expect(addition.tag).toMatch(/^0016_/);
    await copyFile(join(migrations, `${addition.tag}.sql`), join(folder, `${addition.tag}.sql`));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: newPrefix }));
    expect((await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder })).appliedNow).toEqual([addition.tag]);

    // Exactly one new nullable text column without a default; every other column shape is unchanged.
    const afterColumns = await columns();
    const added = afterColumns.filter(column => !legacyColumns.some(old => old.table_name === column.table_name && old.column_name === column.column_name));
    expect(added).toEqual([{ table_name: 'users', column_name: 'avatar_url', data_type: 'text', is_nullable: 'YES', column_default: null }]);
    expect(afterColumns.filter(column => !added.includes(column))).toEqual([...legacyColumns]);
    expect((await sql<{ name: string }[]>`select tablename as name from pg_tables where schemaname='public' order by tablename`).map(table => table.name))
      .toEqual(tables.map(table => table.name));
    expect(await legacyRows()).toEqual(before);
    expect(await sql`select count(*)::int as users, count(avatar_url)::int as avatars from users`).toEqual([{ users: 8, avatars: 0 }]);
    const afterReceipts = await sql`select * from drizzle.__drizzle_migrations order by id`;
    expect(afterReceipts.slice(0, receipts.length)).toEqual(receipts);
    expect(afterReceipts).toHaveLength(receipts.length + 1);

    expect((await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder })).appliedNow).toEqual([]);
    expect(await columns()).toEqual(afterColumns);
    expect(await legacyRows()).toEqual(before);
    expect(await sql`select count(avatar_url)::int as avatars from users`).toEqual([{ avatars: 0 }]);
    expect(await sql`select * from drizzle.__drizzle_migrations order by id`).toEqual(afterReceipts);
  } finally {
    await db?.close();
    await target?.drop();
    await rm(folder, { recursive: true, force: true });
  }
});
