// Only an owned throwaway child database; never DATABASE_URL or a preserved runtime.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessRepository, createDatabase, createSharedAuthStore, runMigrations, seedDemoData, FIXTURE_USER_IDS, type Database } from '@workloom/db';
import type { SharedAuthIdentityInput, SharedAuthStore } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const issuer = 'https://auth.example.test';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8oc-first=s96-c';
const NEXT_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8oc-next=s96-c';
const REFRESH_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8oc-refresh=s96-c';
const INVALID = 'Invalid shared authentication persistence input.';
const identity = (extra: Partial<SharedAuthIdentityInput> = {}): SharedAuthIdentityInput => ({
  issuer, subject: randomUUID(), displayName: 'Real shared-Auth photo test', workspaceName: 'Empty private workspace', timezone: 'UTC', ...extra,
});

describe('shared Auth profile photo persistence on an owned isolated PostgreSQL database', () => {
  let target: ThrowawayDatabase;
  let db: Database;
  let store: SharedAuthStore;
  beforeAll(async () => {
    target = await createThrowawayDatabase('shared_auth_photo');
    await runMigrations(target.url, { requireLoopback: true });
    db = createDatabase(target.url, { requireLoopback: true, applicationName: 'shared-auth-photo' });
    await seedDemoData(db);
    store = createSharedAuthStore(db);
  });
  afterAll(async () => { await db?.close(); await target?.drop(); });
  async function storedPhoto(userId: string) {
    const [row] = await db.sql<{ avatar_url: string | null }[]>`select avatar_url from users where id=${userId}`;
    return row?.avatar_url;
  }
  async function session(input: SharedAuthIdentityInput) {
    const principal = await store.provisionIdentity(input);
    const sessionHash = digest(randomBytes(32).toString('hex'));
    await store.createSession({ sessionHash, userId: principal.user.id, encryptedTokens: 'opaque-api-encrypted-v1', accessExpiresAt: future(), expiresAt: future() });
    return { principal, sessionHash };
  }

  it('stores null for a new user without a picture and the verified URL for one with it', async () => {
    const plain = await store.provisionIdentity(identity());
    expect(plain.user.avatarUrl).toBeNull();
    expect(await storedPhoto(plain.user.id)).toBeNull();
    const pictured = await store.provisionIdentity(identity({ avatarUrl: PHOTO }));
    expect(pictured.user.avatarUrl).toBe(PHOTO);
    expect(await storedPhoto(pictured.user.id)).toBe(PHOTO);
  });

  it('updates on relogin, preserves on omission, clears on null and reloads through user and membership reads', async () => {
    const input = identity({ avatarUrl: PHOTO });
    const first = await store.provisionIdentity(input);
    const updated = await store.provisionIdentity({ ...input, avatarUrl: NEXT_PHOTO });
    expect(updated.user.id).toBe(first.user.id);
    expect(updated.workspaceId).toBe(first.workspaceId);
    expect(await storedPhoto(first.user.id)).toBe(NEXT_PHOTO);

    const { avatarUrl: _omitted, ...withoutPhoto } = input;
    expect((await store.provisionIdentity(withoutPhoto)).user.avatarUrl).toBe(NEXT_PHOTO);
    expect(await storedPhoto(first.user.id)).toBe(NEXT_PHOTO);

    const freshPool = createDatabase(target.url, { requireLoopback: true });
    try {
      const repository = createAccessRepository(freshPool);
      expect((await repository.findUser(first.user.id))?.avatarUrl).toBe(NEXT_PHOTO);
      expect((await repository.listActiveMemberships(first.workspaceId)).map(member => member.avatarUrl)).toEqual([NEXT_PHOTO]);
    } finally { await freshPool.close(); }

    expect((await store.provisionIdentity({ ...input, avatarUrl: null })).user.avatarUrl).toBeNull();
    expect(await storedPhoto(first.user.id)).toBeNull();
    expect(await db.sql`select id from memberships where user_id=${first.user.id}`).toHaveLength(1);
    expect(await db.sql`select id from workspaces where id in (select workspace_id from memberships where user_id=${first.user.id})`).toHaveLength(1);
  });

  it('rejects malformed direct avatar input at the store boundary without writing or echoing it', async () => {
    const input = identity({ avatarUrl: PHOTO });
    const original = await store.provisionIdentity(input);
    for (const avatarUrl of ['javascript:alert(1)', 'https://127.0.0.1/a.png', 'https://photos.example.com/a.png?token=secret-value', 'HTTPS://LH3.GOOGLEUSERCONTENT.COM/a']) {
      const failure = await store.provisionIdentity({ ...input, avatarUrl }).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(INVALID);
      expect(String((failure as Error).stack)).not.toContain('secret-value');
    }
    await expect(store.provisionIdentity(identity({ avatarUrl: 'data:image/png;base64,AAAA' }))).rejects.toThrow(INVALID);
    expect(await storedPhoto(original.user.id)).toBe(PHOTO);
  });

  it('commits a refresh photo atomically with the session patch for the session owner only', async () => {
    const { principal, sessionHash } = await session(identity({ avatarUrl: PHOTO }));
    const bystander = await store.provisionIdentity(identity({ avatarUrl: PHOTO }));

    await store.withLockedSession(sessionHash, async () => ({ result: undefined, update: { encryptedTokens: 'opaque-api-encrypted-v2', profileAvatarUrl: REFRESH_PHOTO } }));
    const [row] = await db.sql<{ encrypted_tokens: string; revision: number }[]>`select encrypted_tokens,revision from shared_auth_sessions where session_hash=${sessionHash}`;
    expect(row).toEqual({ encrypted_tokens: 'opaque-api-encrypted-v2', revision: 2 });
    expect(await storedPhoto(principal.user.id)).toBe(REFRESH_PHOTO);
    expect(await storedPhoto(bystander.user.id)).toBe(PHOTO);

    // Omitted preserves; explicit null clears.
    await store.withLockedSession(sessionHash, async () => ({ result: undefined, update: { encryptedTokens: 'opaque-api-encrypted-v3' } }));
    expect(await storedPhoto(principal.user.id)).toBe(REFRESH_PHOTO);
    await store.withLockedSession(sessionHash, async () => ({ result: undefined, update: { encryptedTokens: 'opaque-api-encrypted-v4', profileAvatarUrl: null } }));
    expect(await storedPhoto(principal.user.id)).toBeNull();

    // A rejected photo rolls back the rotated tokens with it.
    await expect(store.withLockedSession(sessionHash, async () => ({ result: undefined,
      update: { encryptedTokens: 'opaque-api-encrypted-v5', profileAvatarUrl: 'https://localhost/a.png' } }))).rejects.toThrow(INVALID);
    const [after] = await db.sql<{ encrypted_tokens: string }[]>`select encrypted_tokens from shared_auth_sessions where session_hash=${sessionHash}`;
    expect(after?.encrypted_tokens).toBe('opaque-api-encrypted-v4');
    expect(await storedPhoto(principal.user.id)).toBeNull();

    // A later token validation failure must roll back the already-issued user photo UPDATE too.
    const beforeLateFailure = await db.sql`select encrypted_tokens,revision from shared_auth_sessions where session_hash=${sessionHash}`;
    const beforeUser = await db.sql`select avatar_url,updated_at from users where id=${principal.user.id}`;
    await expect(store.withLockedSession(sessionHash, async () => ({ result: undefined,
      update: { encryptedTokens: '', profileAvatarUrl: PHOTO } }))).rejects.toThrow(INVALID);
    expect(await db.sql`select encrypted_tokens,revision from shared_auth_sessions where session_hash=${sessionHash}`).toEqual(beforeLateFailure);
    expect(await db.sql`select avatar_url,updated_at from users where id=${principal.user.id}`).toEqual(beforeUser);

    // A revoking patch never carries a photo write.
    await expect(store.withLockedSession(sessionHash, async () => ({ result: undefined,
      update: { revokedAt: new Date().toISOString(), profileAvatarUrl: PHOTO } }))).rejects.toThrow(INVALID);
    expect(await storedPhoto(principal.user.id)).toBeNull();
  });

  it('keeps fixtures separate: a real identity matching a fixture subject/name never changes the fixture photo', async () => {
    const [fixture] = await db.sql<{ display_name: string; avatar_url: string | null }[]>`select display_name,avatar_url from users where id=${FIXTURE_USER_IDS.owner}`;
    if (!fixture) throw new Error('Expected the seeded fixture owner.');
    expect(fixture.avatar_url).toBeNull();
    const real = await store.provisionIdentity(identity({ subject: FIXTURE_USER_IDS.owner, displayName: fixture.display_name, avatarUrl: PHOTO }));
    expect(real.user.id).not.toBe(FIXTURE_USER_IDS.owner);
    expect(await storedPhoto(real.user.id)).toBe(PHOTO);
    expect(await db.sql`select display_name,avatar_url from users where id=${FIXTURE_USER_IDS.owner}`).toEqual([fixture]);
    const fixtureMembers = await db.sql<{ avatar_url: string | null }[]>`select u.avatar_url from memberships m join users u on u.id=m.user_id where u.kind='fixture'`;
    expect(fixtureMembers.every(member => member.avatar_url === null)).toBe(true);
  });
});
