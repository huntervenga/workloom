// Only an owned throwaway child database; never DATABASE_URL or a preserved runtime.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessRepository, createDatabase, createSharedAuthStore, createTaskApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS, type Database } from '@workloom/db';
import type { SharedAuthSessionRecord, SharedAuthStore } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const issuer = 'https://auth.example.test';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const identity = (extra: Partial<{ issuer: string; subject: string; displayName: string; workspaceName: string; timezone: string }> = {}) => ({
  issuer, subject: randomUUID(), displayName: 'Real shared-Auth test', workspaceName: 'Empty private workspace', timezone: 'UTC', ...extra,
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('shared Auth persistence on an owned isolated PostgreSQL database', () => {
  let target: ThrowawayDatabase;
  let db: Database, peer: Database;
  let store: SharedAuthStore, other: SharedAuthStore;
  const peerName = `shared-auth-peer-${randomBytes(4).toString('hex')}`;
  beforeAll(async () => {
    target = await createThrowawayDatabase('shared_auth_store');
    await runMigrations(target.url, { requireLoopback: true });
    db = createDatabase(target.url, { requireLoopback: true, applicationName: 'shared-auth-main' });
    peer = createDatabase(target.url, { requireLoopback: true, applicationName: peerName });
    await seedDemoData(db);
    store = createSharedAuthStore(db); other = createSharedAuthStore(peer);
  });
  afterAll(async () => { await peer?.close(); await db?.close(); await target?.drop(); });
  async function session() {
    const principal = await store.provisionIdentity(identity());
    const sessionHash = digest(randomBytes(32).toString('hex'));
    await store.createSession({ sessionHash, userId: principal.user.id, encryptedTokens: 'opaque-api-encrypted-v1', accessExpiresAt: future(), expiresAt: future() });
    return { principal, sessionHash };
  }
  async function read(hash: string) { return other.withLockedSession(hash, async value => ({ result: value })); }
  async function peerWaiting() {
    for (let tries = 0; tries < 200; tries++) {
      const [row] = await db.sql<{ count: number }[]>`select count(*)::int as count from pg_stat_activity where application_name=${peerName} and wait_event_type='Lock'`;
      if (row?.count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected the independent peer connection to wait on the session row lock.');
  }

  it('serializes concurrent first logins across stores into exactly one real user, empty workspace and owner', async () => {
    const input = identity();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? other : store).provisionIdentity(input)));
    expect(new Set(results.map(value => value.user.id)).size).toBe(1);
    expect(new Set(results.map(value => value.workspaceId)).size).toBe(1);
    const result = results[0];
    if (!result) throw new Error('Expected a provisioned identity.');
    expect(result.user.kind).toBe('real'); expect(result.user.id).not.toBe(input.subject);
    const mapped = await db.sql`select * from shared_auth_identities where issuer=${input.issuer} and subject=${input.subject}`;
    expect(mapped).toHaveLength(1);
    const members = await db.sql`select user_id,role,state,revision from memberships where workspace_id=${result.workspaceId}`;
    expect(members).toEqual([{ user_id: result.user.id, role: 'owner', state: 'active', revision: 1 }]);
    const [head] = await db.sql`select change_seq::text,permission_epoch::text from workspaces where id=${result.workspaceId}`;
    expect(head).toEqual({ change_seq: '0', permission_epoch: '0' });
    expect(await db.sql`select id from projects where workspace_id=${result.workspaceId}`).toHaveLength(0);
    expect(await db.sql`select id from tasks where workspace_id=${result.workspaceId}`).toHaveLength(0);
    expect(await db.sql`select id from audit_events where workspace_id=${result.workspaceId}`).toHaveLength(0);
    const visible = await createAccessRepository(db).listAccessibleWorkspaces(result.user.id);
    expect(visible.map(value => value.workspace.id)).toEqual([result.workspaceId]);
  });

  it('retains mapping after reload without restoring revoked membership, and ordinary project creation works', async () => {
    const input = identity(); const original = await store.provisionIdentity(input);
    const freshPool = createDatabase(target.url, { requireLoopback: true });
    try { expect(await createSharedAuthStore(freshPool).provisionIdentity(input)).toEqual(original); } finally { await freshPool.close(); }
    const project = await createTaskApplication(db).createProject({ workspaceId: original.workspaceId,
      actor: { userId: original.user.id, displayName: original.user.displayName, kind: 'real' }, source: 'web', requestId: randomUUID(), idempotencyKey: randomUUID() }, { name: 'First real project' });
    expect(project.workspaceId).toBe(original.workspaceId);
    await db.sql`update memberships set state='revoked',revoked_at=now(),revision=revision+1 where id=${original.membershipId}`;
    expect(await other.provisionIdentity(input)).toEqual(original);
    expect(await createAccessRepository(peer).listAccessibleWorkspaces(original.user.id)).toEqual([]);
    expect(await db.sql`select id from memberships where user_id=${original.user.id}`).toHaveLength(1);
  });

  it('never merges a fixture by sub/name or joins its workspace; issuer scopes the same subject', async () => {
    const [fixture] = await db.sql<{ display_name: string; kind: string }[]>`select display_name,kind::text from users where id=${FIXTURE_USER_IDS.owner}`;
    const before = await db.sql`select * from memberships where user_id=${FIXTURE_USER_IDS.owner} order by id`;
    if (!fixture) throw new Error('Expected the seeded fixture owner.');
    const input = identity({ subject: FIXTURE_USER_IDS.owner, displayName: fixture.display_name });
    const one = await store.provisionIdentity(input);
    const two = await other.provisionIdentity({ ...input, issuer: 'https://second-issuer.example.test' });
    expect(one.user.id).not.toBe(input.subject); expect(two.user.id).not.toBe(one.user.id);
    expect(one.workspaceId).not.toBe(two.workspaceId);
    expect(await db.sql`select * from memberships where user_id=${FIXTURE_USER_IDS.owner} order by id`).toEqual(before);
    expect(await db.sql`select display_name,kind::text from users where id=${FIXTURE_USER_IDS.owner}`).toEqual([fixture]);
    expect((await createAccessRepository(db).listAccessibleWorkspaces(one.user.id)).map(value => value.workspace.id)).toEqual([one.workspaceId]);
  });

  it('rolls back the new user/workspace/membership on a late identity-insert failure', async () => {
    const input = identity();
    const counts = async () => (await db.sql`select (select count(*)::int from users) as users,(select count(*)::int from workspaces) as workspaces,(select count(*)::int from memberships) as memberships`)[0];
    const before = await counts();
    await db.sql.unsafe(`alter table shared_auth_identities add constraint test_reject_subject check (subject <> '${input.subject}')`);
    try { await expect(store.provisionIdentity(input)).rejects.toThrow(); } finally { await db.sql`alter table shared_auth_identities drop constraint test_reject_subject`; }
    expect(await counts()).toEqual(before);
    expect(await db.sql`select user_id from shared_auth_identities where subject=${input.subject}`).toHaveLength(0);
  });

  it('persists opaque payload/hash across pool reload, rejects fixture sessions and never adds audit/receipts', async () => {
    const before = await db.sql`select (select count(*)::int from audit_events) as audit,(select count(*)::int from command_idempotency) as receipts`;
    const { sessionHash, principal } = await session();
    const loaded = await read(sessionHash);
    expect(loaded).toMatchObject({ sessionHash, userId: principal.user.id, encryptedTokens: 'opaque-api-encrypted-v1', revision: 1, revokedAt: null });
    const columns = await db.sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_schema='public' and table_name='shared_auth_sessions'`;
    expect(columns.some(value => ['access_token', 'refresh_token', 'cookie', 'session_token'].includes(value.column_name))).toBe(false);
    await expect(store.createSession({ sessionHash: digest('fixture-session'), userId: FIXTURE_USER_IDS.owner, encryptedTokens: 'opaque', accessExpiresAt: future(), expiresAt: future() })).rejects.toThrow('Invalid shared authentication persistence input.');
    expect(await db.sql`select (select count(*)::int from audit_events) as audit,(select count(*)::int from command_idempotency) as receipts`).toEqual(before);
  });

  it('holds a cross-pool row lock across refresh callback and commit so the second sees the replacement', async () => {
    const { sessionHash } = await session(); const entered = deferred(), release = deferred();
    const first = store.withLockedSession(sessionHash, async current => { entered.resolve(); await release.promise;
      if (!current) throw new Error('Expected a persisted session.');
      return { result: current.revision, update: { encryptedTokens: 'encrypted-replacement-v2' } }; });
    await entered.promise;
    let secondObserved: SharedAuthSessionRecord | null = null;
    const second = other.withLockedSession(sessionHash, async current => { secondObserved = current;
      if (!current) throw new Error('Expected a persisted session.');
      return { result: current.revision, update: { encryptedTokens: 'encrypted-replacement-v3' } }; });
    try { await peerWaiting(); expect(secondObserved).toBeNull(); } finally { release.resolve(); }
    expect(await first).toBe(1); expect(await second).toBe(2);
    expect(await read(sessionHash)).toMatchObject({ revision: 3, encryptedTokens: 'encrypted-replacement-v3' });
  });

  it('serializes exact-session logout with refresh; another session survives and revoke is idempotent', async () => {
    const firstSession = await session(), secondSession = await session(); const entered = deferred(), release = deferred();
    const refresh = store.withLockedSession(firstSession.sessionHash, async () => { entered.resolve(); await release.promise;
      return { result: true, update: { encryptedTokens: 'rotated-before-logout' } }; });
    await entered.promise; const logout = other.revokeSession(firstSession.sessionHash);
    try { await peerWaiting(); } finally { release.resolve(); }
    await refresh; await logout;
    const revoked = await read(firstSession.sessionHash); expect(revoked?.revokedAt).not.toBeNull(); expect(revoked?.revision).toBe(3);
    await other.revokeSession(firstSession.sessionHash); expect(await read(firstSession.sessionHash)).toEqual(revoked);
    expect((await read(secondSession.sessionHash))?.revokedAt).toBeNull();
  });

  it('surfaces expired rows, commits tagged revocation before result, and rolls back callback throws', async () => {
    const { sessionHash } = await session(); const expired = new Date(Date.now() - 1000).toISOString();
    await store.withLockedSession(sessionHash, async () => ({ result: null, update: { expiresAt: expired } }));
    expect((await read(sessionHash))?.expiresAt).toBe(expired);
    const before = await read(sessionHash);
    await expect(store.withLockedSession(sessionHash, async () => { throw new Error('Synthetic refresh failure'); })).rejects.toThrow('Synthetic refresh failure');
    expect(await read(sessionHash)).toEqual(before);
    const outcome = await store.withLockedSession(sessionHash, async () => ({ result: 'denied' as const, update: { revokedAt: new Date().toISOString() } }));
    expect(outcome).toBe('denied'); expect((await read(sessionHash))?.revokedAt).not.toBeNull();
    expect(await read(digest('missing-session'))).toBeNull();
    await expect(store.withLockedSession(digest('missing-session'), async () => ({ result: null, update: { encryptedTokens: 'cannot-create' } }))).rejects.toThrow();
  });

  it('persists browser-bound attempts and consumes exactly once across stores without burning wrong binding', async () => {
    const stateHash = digest(randomUUID()), browserHash = digest(randomUUID()), returnTo = '/app/w/one?view=gantt#kept';
    await store.createLoginAttempt({ stateHash, browserHash, returnTo, expiresAt: future() });
    const now = new Date().toISOString();
    expect(await other.consumeLoginAttempt({ stateHash, browserHash: digest('wrong-browser'), now })).toBeNull();
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? other : store).consumeLoginAttempt({ stateHash, browserHash, now })));
    expect(results.filter(Boolean)).toEqual([{ returnTo }]);
    expect(await other.consumeLoginAttempt({ stateHash, browserHash, now })).toBeNull();
  });

  it('rejects expired/boundary attempts and external return targets without echoing material', async () => {
    const stateHash = digest(randomUUID()), browserHash = digest(randomUUID()), now = new Date().toISOString();
    await store.createLoginAttempt({ stateHash, browserHash, returnTo: '/app', expiresAt: now });
    expect(await other.consumeLoginAttempt({ stateHash, browserHash, now })).toBeNull();
    await expect(store.createLoginAttempt({ stateHash: digest('external'), browserHash, returnTo: '//outside.example/app', expiresAt: future() })).rejects.toThrow('Invalid shared authentication persistence input.');
    await expect(store.createLoginAttempt({ stateHash: 'RAW-STATE-MUST-NOT-ECHO', browserHash, returnTo: '/app', expiresAt: future() })).rejects.not.toThrow('RAW-STATE-MUST-NOT-ECHO');
  });
});
