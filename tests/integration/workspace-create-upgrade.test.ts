// A populated owned0014 child only; never the preserved main cluster/database.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, createWorkspaceCreateApplication, runMigrations, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS, type Database } from '@workloom/db';
import { expect, it } from 'vitest';
import { createLegacyProject, createLegacyTask, insertLegacyAuthPrincipal, insertLegacyAuthSession, insertLegacyFixtureOwner,
  insertLegacyLoginAttempt, seedLegacyDemoData, sha256Hex } from './support/legacy-upgrade-fixture.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
const migrations = fileURLToPath(new URL('../../packages/db/migrations/', import.meta.url));

it('preserves0014→0015 legacy rows, then upgrades the isolated fixture before the current workspace command', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workloom-workspace-upgrade-'));
  let target: ThrowawayDatabase | undefined;
  let db: Database | undefined;
  try {
    const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const oldPrefix = journal.entries.filter(entry => entry.idx < 15);
    expect(oldPrefix).toHaveLength(15);
    expect(oldPrefix.at(-1)?.tag).toBe('0014_shared_auth');
    await mkdir(join(folder, 'meta'));
    for (const entry of oldPrefix) await copyFile(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: oldPrefix }));
    target = await createThrowawayDatabase('workspace_upgrade');
    expect((await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder })).state.appliedCount).toBe(15);
    db = createDatabase(target.url, { requireLoopback: true });
    await seedLegacyDemoData(db.sql);
    // Current stores read columns from later migrations; populate0014 through explicit old-schema SQL.
    const fixture = await insertLegacyFixtureOwner(db.sql, { userId: FIXTURE_USER_IDS.owner, workspaceId: FIXTURE_WORKSPACE_IDS.team,
      displayName: 'Synthetic Owner', workspaceName: 'Synthetic team' });
    const project = await createLegacyProject(db.sql, fixture, 'Preserved0014 project');
    await createLegacyTask(db.sql, fixture, { projectId: project.id, statusId: project.todoStatusId, title: 'Preserved0014 task', estimateMinutes: 75 });
    const principal = await insertLegacyAuthPrincipal(db.sql, { issuer: 'https://auth.example.test', subject: randomUUID(), displayName: 'Existing real user', workspaceName: 'Existing Auth home', timezone: 'UTC' });
    const expiry = new Date(Date.now() + 3600_000).toISOString();
    await insertLegacyAuthSession(db.sql, { sessionHash: sha256Hex('synthetic-upgrade-session'), userId: principal.userId,
      encryptedTokens: 'synthetic-opaque-ciphertext', accessExpiresAt: expiry, expiresAt: expiry });
    await insertLegacyLoginAttempt(db.sql, { stateHash: sha256Hex('synthetic-upgrade-state'), browserHash: sha256Hex('synthetic-upgrade-browser'), returnTo: '/app', expiresAt: expiry });
    const tables = await db.sql<{ name: string }[]>`select tablename as name from pg_tables where schemaname='public' order by tablename`;
    expect(tables).toHaveLength(63);
    const sql = db.sql;
    // Freeze the historical column set before applying any later schema; new columns must
    // not make a legacy-row preservation comparison read today's ORM shape.
    const preservedColumns = await sql<{table_name:string;column_name:string}[]>`select table_name::text,column_name::text from information_schema.columns where table_schema='public' order by table_name,ordinal_position`;
    const quotedIdentifier=(value:string)=>`"${value.replaceAll('"','""')}"`;

    async function legacyRows() {
      const result: Record<string, string[]> = {};
      for (const { name } of tables) {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const values = await sql.unsafe<{ row: unknown }[]>(`select to_jsonb(t) as row from (select ${preservedColumns.filter(c=>c.table_name===name).map(c=>quotedIdentifier(c.column_name)).join(',')} from public.${quoted}) t`);
        result[name] = values.map(value => JSON.stringify(value.row)).sort();
      }
      return result;
    }
    const before = await legacyRows();
    for (const name of ['tasks', 'audit_events', 'command_idempotency', 'shared_auth_identities', 'shared_auth_sessions', 'shared_auth_login_attempts']) {
      expect(before[name]?.length).toBeGreaterThan(0);
    }
    const receipts = await db.sql`select * from drizzle.__drizzle_migrations order by id`;
    const newPrefix = journal.entries.filter(entry => entry.idx <= 15);
    expect(newPrefix).toHaveLength(16);
    const addition = newPrefix.find(entry => entry.idx === 15);
    if (!addition) throw new Error('Expected the new workspace migration.');
    expect(addition.tag).toBe('0015_workspace_creation');
    await copyFile(join(migrations, `${addition.tag}.sql`), join(folder, `${addition.tag}.sql`));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: newPrefix }));
    expect((await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder })).appliedNow).toEqual([addition.tag]);
    expect(await legacyRows()).toEqual(before);
    const afterReceipts = await db.sql`select * from drizzle.__drizzle_migrations order by id`;
    expect(afterReceipts.slice(0, receipts.length)).toEqual(receipts);
    expect(afterReceipts).toHaveLength(receipts.length + 1);
    expect(await db.sql`select * from workspace_creation_receipts`).toHaveLength(0);
    // Historical0014→0015 proof is complete. Today's command needs the full current schema.
    const currentPrefix=journal.entries;expect(currentPrefix).toHaveLength(29);
    const later=currentPrefix.filter(entry=>entry.idx>15);
    for(const entry of later)await copyFile(join(migrations,`${entry.tag}.sql`),join(folder,`${entry.tag}.sql`));
    await writeFile(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:currentPrefix}));
    expect((await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder})).appliedNow).toEqual(later.map(entry=>entry.tag));
    expect(await legacyRows()).toEqual(before);
    expect(await db.sql`select count(avatar_url)::int as avatars from users`).toEqual([{avatars:0}]);
    const currentReceipts=await db.sql`select * from drizzle.__drizzle_migrations order by id`;
    expect(currentReceipts.slice(0,afterReceipts.length)).toEqual(afterReceipts);expect(currentReceipts).toHaveLength(currentPrefix.length);
    const created = await createWorkspaceCreateApplication(db).createWorkspace({
      actor: { userId: principal.userId, displayName: 'Existing real user', kind: 'real' },
      source: 'web', requestId: randomUUID(), idempotencyKey: randomUUID(),
    }, { name: 'New optional workspace', timezone: 'Asia/Nicosia' });
    expect(created.id).not.toBe(principal.workspaceId);
    expect(created.role).toBe('owner');
    expect(await db.sql`select change_seq::text, permission_epoch::text from workspaces where id=${created.id}`).toEqual([{ change_seq: '1', permission_epoch: '0' }]);
    expect(await db.sql`select * from tasks where workspace_id=${created.id}`).toHaveLength(0);
    expect(await db.sql`select workspace_id from workspace_creation_receipts`).toEqual([{ workspace_id: created.id }]);
    const afterCreation = await legacyRows();
    for (const { name } of tables) expect(afterCreation[name]).toEqual(expect.arrayContaining(before[name] ?? []));
    expect((await runMigrations(target.url, { requireLoopback: true, migrationsFolder: folder })).appliedNow).toEqual([]);
  } finally {
    await db?.close();
    await target?.drop();
    await rm(folder, { recursive: true, force: true });
  }
});
