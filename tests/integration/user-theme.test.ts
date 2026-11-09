// Real PostgreSQL: theme names are validated by the shared contract; the database only checks their shape (0040).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createUserSettingsApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, type Database } from '@workloom/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
requireTestDatabaseUrl();

describe('user theme names', () => {
  let target: ThrowawayDatabase | undefined, db: Database;
  beforeAll(async () => {
    target = await createThrowawayDatabase('user_theme');
    db = createDatabase(target.url, { requireLoopback: true });
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
  }, 90000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30000);

  it('stores Omnissiah, rejects unknown names in the contract and malformed names in the database', async () => {
    const settings = createUserSettingsApplication(db);
    const actor = { actor: { userId: U.owner, displayName: 'Synthetic owner', kind: 'fixture' as const }, source: 'web' as const, requestId: randomUUID() };
    const before = await settings.get(actor);
    const saved = await settings.update(actor, { expectedUserId: U.owner, expectedRevision: before.revision, settings: { theme: 'omnissiah' } });
    expect(saved.settings.theme).toBe('omnissiah');
    expect((await settings.get(actor)).settings.theme).toBe('omnissiah');
    await expect(settings.update(actor, { expectedUserId: U.owner, expectedRevision: saved.revision, settings: { theme: 'sepia' as 'dark' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(db.sql`update user_settings set settings = '{"version":1,"theme":"Robert'');"}'::jsonb where user_id = ${U.owner}`).rejects.toMatchObject({ code: '23514' });
    expect((await db.sql`select settings->>'theme' as theme from user_settings where user_id = ${U.owner}`)[0]?.theme).toBe('omnissiah');
  });
});
