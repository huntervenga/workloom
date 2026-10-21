// Only owned throwaway PostgreSQL; verified mailbox evidence stays in its encrypted session JWT.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createSharedAuthStore, runMigrations, type Database } from '@workloom/db';
import type { SharedAuthStore } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
requireTestDatabaseUrl();
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
const future = () => new Date(Date.now() + 3600_000).toISOString();
describe('shared Auth sessions require a registered principal rather than a real-looking pending person', () => {
  let target: ThrowawayDatabase, db: Database, store: SharedAuthStore;
  beforeAll(async () => { target = await createThrowawayDatabase('shared_auth_email'); await runMigrations(target.url, { requireLoopback: true }); db = createDatabase(target.url, { requireLoopback: true }); store = createSharedAuthStore(db); });
  afterAll(async () => { await db?.close(); await target?.drop(); });
  it('rejects sessions for an unbound real-looking person without a shared Auth principal', async () => {
    const userId = randomUUID();
    await db.sql`insert into users(id,display_name,kind) values(${userId},'Unregistered placeholder','real')`;
    await expect(store.createSession({ sessionHash: hash(), userId, encryptedTokens: 'opaque', accessExpiresAt: future(), expiresAt: future() })).rejects.toThrow('Invalid shared authentication persistence input.');
    expect(await db.sql`select session_hash from shared_auth_sessions where user_id=${userId}`).toHaveLength(0);
  });
  it('permits a registered subject without persisting a separate plaintext mailbox projection', async () => {
    const person = await store.provisionIdentity({ issuer: 'https://auth.example.test', subject: randomUUID(), displayName: 'Registered person', workspaceName: 'Private workspace', timezone: 'UTC' });
    const sessionHash = hash();
    await store.createSession({ sessionHash, userId: person.user.id, encryptedTokens: 'opaque-encrypted-session-jwt', accessExpiresAt: future(), expiresAt: future() });
    expect(await db.sql`select user_id from shared_auth_sessions where session_hash=${sessionHash}`).toEqual([{ user_id: person.user.id }]);
    const emailTables = await db.sql`select table_name from information_schema.tables where table_schema='public' and table_name='shared_auth_verified_emails'`;
    expect(emailTables).toHaveLength(0);
  });
});
