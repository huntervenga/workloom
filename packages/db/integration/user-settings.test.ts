import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/migrations.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUserSettingsApplication } from '../src/user-settings.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support.js';
const user = 'aa000000-0000-4000-8000-000000000001';
const other = 'aa000000-0000-4000-8000-000000000002';
const context = (id = user) => ({ actor: { userId: id, displayName: 'Synthetic', kind: 'real' as const }, source: 'web' as const, requestId: 'settings-pg' });
let target: ThrowawayDatabase;
beforeAll(async () => {
  target = await createThrowawayDatabase('user_settings');
  const prior = await mkdtemp(join(tmpdir(), 'workloom-settings-migrations-'));
  try {
    const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.slice(0, -1);
    await mkdir(join(prior, 'meta'));
    await writeFile(join(prior, 'meta/_journal.json'), JSON.stringify(journal));
    for (const { tag } of journal.entries) await copyFile(join(MIGRATIONS_FOLDER, tag + '.sql'), join(prior, tag + '.sql'));
    await runMigrations(target.url, { migrationsFolder: prior, requireLoopback: true });
  } finally { await rm(prior, { recursive: true, force: true }); }
  await target.database.sql`insert into users (id,display_name,kind) values (${user},'Synthetic A','real'),(${other},'Synthetic B','real')`;
  const before = await target.database.sql`select * from users order by id`;
  expect((await runMigrations(target.url, { requireLoopback: true })).appliedNow).toEqual(['0034_user_settings']);
  expect(await target.database.sql`select * from users order by id`).toEqual(before);
});
afterAll(async () => { await target?.drop(); });
describe('persisted account settings on PostgreSQL', () => {
  it('keeps reads side-effect free and isolates users across service instances', async () => {
    const app = createUserSettingsApplication(target.database);
    expect(await app.get(context())).toMatchObject({ revision: 0, settings: { theme: 'default' } });
    expect(await target.database.sql`select * from user_settings`).toHaveLength(0);
    await app.update(context(), { expectedUserId: user, expectedRevision: 0, settings: { theme: 'dark' } });
    expect(await createUserSettingsApplication(target.database).get(context())).toMatchObject({ revision: 1, settings: { theme: 'dark' } });
    expect(await app.get(context(other))).toMatchObject({ revision: 0, settings: { theme: 'default' } });
  });
  it('serializes concurrent first saves and never silently overwrites the winner', async () => {
    const app = createUserSettingsApplication(target.database);
    const results = await Promise.allSettled(['light', 'dark'].map(theme => app.update(context(other), { expectedUserId: other, expectedRevision: 0, settings: { theme: theme as 'light' | 'dark' } })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'REVISION_CONFLICT' } });
    expect((await app.get(context(other))).revision).toBe(1);
  });
  it('enforces the JSON document, revision, foreign key and self-only update boundary', async () => {
    const app = createUserSettingsApplication(target.database);
    await expect(app.update(context(), { expectedUserId: other, expectedRevision: 1, settings: { theme: 'light' } })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    for (const value of [{}, { version: 1, theme: 'blue' }, { version: '1', theme: 'dark' }]) {
      await expect(target.database.sql`update user_settings set settings=${JSON.stringify(value)}::jsonb where user_id=${user}`).rejects.toMatchObject({ code: '23514' });
    }
    await expect(target.database.sql`update user_settings set revision=0 where user_id=${user}`).rejects.toMatchObject({ code: '23514' });
    expect((await app.get(context())).settings.theme).toBe('dark');
  });
});
