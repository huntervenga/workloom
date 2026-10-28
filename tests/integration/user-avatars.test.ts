import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessRepository, createDatabase, createSharedAuthStore, createTaskApplication, createTaskCommentsApplication, createUserAvatarStore,
  runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M,
  type Database, type UserAvatarStore } from '@workloom/db';
import { unauthenticatedError, type ActorContext, type CommandContext } from '@workloom/domain';
import { uploadedAvatarUrl } from '@workloom/contracts';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';

requireTestDatabaseUrl();
const context = (userId: string = U.owner): ActorContext => ({ actor: { userId, displayName: 'Avatar test', kind: 'fixture' }, source: 'web', requestId: randomUUID() });
const command = (): CommandContext => ({ ...context(), workspaceId: W.team, idempotencyKey: randomUUID() });
const headers = { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' };
const input = (revision: number, userId: string = U.owner) => ({ expectedUserId: userId, expectedRevision: revision });
const required = <T>(value: T | null | undefined): T => { if (value === null || value === undefined) throw new Error('Missing avatar fixture'); return value; };

describe('private user avatars: real API, PostgreSQL, image decoder and SDK with local S3 fixture', () => {
  let target: ThrowawayDatabase, db: Database, store: UserAvatarStore, app: Awaited<ReturnType<typeof createApp>>;
  let currentActor: string | null = U.owner, port: number, png: Buffer, failPut = false, puts = 0;
  const files = new Map<string, Buffer>();
  const objects = createServer(async (request, reply) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'PUT') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      files.set(path, Buffer.concat(chunks)); puts++;
      if (failPut) { reply.writeHead(503, { 'content-type': 'application/xml' }); reply.end('<Error><Code>ServiceUnavailable</Code></Error>'); return; }
      reply.writeHead(200, { 'x-amz-version-id': `avatar-version-${puts}`, etag: 'test-etag' }); reply.end(); return;
    }
    if (!files.has(path)) { reply.writeHead(404, { 'content-type': 'application/xml' }); reply.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
    if (request.method === 'DELETE') { files.delete(path); reply.writeHead(204); reply.end(); return; }
    reply.writeHead(200, { 'content-type': 'image/webp', 'content-length': required(files.get(path)).length });
    reply.end(request.method === 'HEAD' ? undefined : files.get(path));
  });
  const config = (enabled = true) => loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: target.url,
    ...(enabled ? { ATTACHMENTS_S3_BUCKET: 'avatar-test', ATTACHMENTS_S3_REGION: 'auto', ATTACHMENTS_S3_ENDPOINT: `http://127.0.0.1:${port}`,
      ATTACHMENTS_S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: 'synthetic-access', AWS_SECRET_ACCESS_KEY: 'synthetic-secret' } : {}) });
  const identity = { mode: 'dev' as const, resolveActor: async () => { if (!currentActor) throw unauthenticatedError(); return context(currentActor).actor; } };
  beforeAll(async () => {
    target = await createThrowawayDatabase('user_avatars');
    await runMigrations(target.url, { requireLoopback: true }); db = createDatabase(target.url, { requireLoopback: true }); await seedDemoData(db);
    store = createUserAvatarStore(db);
    await new Promise<void>(resolve => objects.listen(0, '127.0.0.1', resolve)); port = (objects.address() as AddressInfo).port;
    app = await createApp(config(), { database: db, logger: false, webDistDir: null, identityAdapter: identity });
    png = await sharp({ create: { width: 700, height: 400, channels: 3, background: '#4488bb' } }).png().toBuffer();
  }, 90_000);
  afterAll(async () => { await app?.close(); await new Promise<void>(resolve => objects.close(() => resolve())); await db?.close(); await target?.drop(); }, 30_000);
  const upload = (revision: number, payload = png, actor: string = U.owner) => app.inject({ method: 'PUT', url: '/api/v1/me/avatar',
    headers: { ...headers, 'content-type': 'application/octet-stream', 'x-workloom-expected-actor': actor, 'x-workloom-avatar-revision': String(revision) }, payload });

  it('advertises availability, uploads normalized WebP under avatars/ and serves a signed URL only after authentication', async () => {
    const features = await app.inject({ url: '/api/v1/features', headers });
    expect(features.json().data.features.userAvatars).toMatchObject({ enabled: true, maxFileSizeBytes: 5_000_000 });
    const result = await upload(0); expect(result.statusCode, result.body).toBe(200);
    const avatar = result.json().data; expect(avatar).toMatchObject({ userId: U.owner, revision: 1, hasCustomAvatar: true });
    expect(avatar.avatarUrl).toMatch(new RegExp(`^/api/v1/users/${U.owner}/avatars/`));
    const file = [...files.entries()][0]; expect(file?.[0]).toContain(`/avatars/${U.owner}/`);
    expect(await sharp(required(file?.[1])).metadata()).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect((await app.inject({ url: '/api/v1/me', headers })).json().data.actor.avatarUrl).toBe(avatar.avatarUrl);
    const opened = await app.inject({ url: avatar.avatarUrl, headers }); expect(opened.statusCode).toBe(302);
    expect(opened.headers['cache-control']).toBe('private, no-store');
    const signed = new URL(required(opened.headers.location as string));
    expect(signed.searchParams.get('versionId')).toBe('avatar-version-1'); expect(signed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(Buffer.from(await (await fetch(signed)).arrayBuffer())).toEqual(file?.[1]);
    currentActor = null;
    try { expect((await app.inject({ url: avatar.avatarUrl, headers })).statusCode).toBe(401); }
    finally { currentActor = U.owner; }
  });

  it('keeps the old image on failure, retains orphan cleanup, and schedules the replaced object after success', async () => {
    const before = await store.application.get(context()), oldId = required(before.avatarUrl).split('/').at(-1);
    failPut = true;
    try { expect((await upload(before.revision)).statusCode).toBe(503); } finally { failPut = false; }
    expect(await store.application.get(context())).toEqual(before);
    const orphans = await db.sql`select * from avatar_storage_objects where user_id = ${U.owner} and state = 'pending'`;
    expect(orphans).toHaveLength(1); expect(orphans[0]?.['cleanup_at']).toBeTruthy();
    const replaced = await upload(before.revision); expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().data.avatarUrl).not.toBe(before.avatarUrl);
    const [retired] = await db.sql`select state, cleanup_at <= clock_timestamp() as due from avatar_storage_objects where id = ${required(oldId)}`;
    expect(retired).toMatchObject({ state: 'retired', due: true });
    expect((await app.inject({ url: required(before.avatarUrl), headers })).statusCode).toBe(404);
  });

  it('allows current teammates and rejects other users or revoked memberships before signing', async () => {
    const avatar = await store.application.get(context()), url = required(avatar.avatarUrl), outsider = randomUUID();
    await db.sql`insert into users (id, display_name, kind) values (${outsider}, 'Other account', 'fixture')`;
    currentActor = outsider;
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    currentActor = U.memberA;
    expect((await app.inject({ url, headers })).statusCode).toBe(302);
    const saved = await membershipRow(db.sql, W.team, M.teamMemberA);
    try {
      await revokeMembership(db.sql, W.team, M.teamMemberA);
      expect((await app.inject({ url, headers })).statusCode).toBe(404);
    } finally { await restoreMembership(db.sql, W.team, M.teamMemberA, saved); currentActor = U.owner; }
  });

  it('rejects wrong actors, invalid images, oversized bodies and stale revisions without publishing a change', async () => {
    const before = await store.application.get(context()), count = puts;
    expect((await upload(before.revision, png, U.memberA)).statusCode).toBe(401);
    expect((await upload(before.revision, Buffer.from('<svg/>'))).statusCode).toBe(415);
    expect((await upload(before.revision, Buffer.alloc(5_000_001))).statusCode).toBe(413);
    expect((await upload(before.revision - 1)).statusCode).toBe(409);
    expect(puts).toBe(count); expect(await store.application.get(context())).toEqual(before);
    expect((await upload(before.revision)).statusCode).toBe(200); // Failed parsing released the upload slot.
  });

  it('preserves optional operation without S3 and allows removing a custom photo with durable cleanup', async () => {
    const disabled = await createApp(config(false), { database: db, logger: false, webDistDir: null, identityAdapter: identity });
    const before = await store.application.get(context());
    try {
      expect((await disabled.inject({ url: '/api/v1/features', headers })).json().data.features.userAvatars.enabled).toBe(false);
      expect((await disabled.inject({ url: '/api/v1/me/avatar', headers })).json().data).toEqual(before);
      const denied = await disabled.inject({ method: 'PUT', url: '/api/v1/me/avatar', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-workloom-expected-actor': U.owner, 'x-workloom-avatar-revision': String(before.revision) }, payload: png });
      expect(denied.statusCode).toBe(503);
      const removed = await disabled.inject({ method: 'DELETE', url: '/api/v1/me/avatar', headers, payload: input(before.revision) });
      expect(removed.statusCode).toBe(200); expect(removed.json().data).toMatchObject({ hasCustomAvatar: false, avatarUrl: null, revision: before.revision + 1 });
      const id = required(before.avatarUrl).split('/').at(-1);
      expect((await db.sql`select cleanup_at <= clock_timestamp() as due from avatar_storage_objects where id = ${required(id)}`)[0]?.['due']).toBe(true);
    } finally { await disabled.close(); }
  });

  it('protects simultaneous writes and refuses an expired attempt', async () => {
    const before = await store.application.get(context()), storageId = 'a'.repeat(64);
    const [a, b] = await Promise.all([store.application.prepare(context(), input(before.revision), storageId), store.application.prepare(context(), input(before.revision), storageId)]);
    const outcomes = await Promise.allSettled([store.application.finish(context(), a, 'a'), store.application.finish(context(), b, 'b')]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
    const after = await store.application.get(context()), expired = await store.application.prepare(context(), input(after.revision), storageId);
    await db.sql`update avatar_storage_objects set write_deadline = clock_timestamp() - interval '1 second', cleanup_at = clock_timestamp() where id = ${expired.id}`;
    await expect(store.application.finish(context(), expired, null)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const [jobs1, jobs2] = await Promise.all([store.claimCleanup(storageId), store.claimCleanup(storageId)]);
    const expiredJobs = [...jobs1, ...jobs2].filter(job => job.id === expired.id); expect(expiredJobs).toHaveLength(1);
    await store.completeCleanup(required(expiredJobs[0]), false);
    expect((await db.sql`select cleanup_at > clock_timestamp() as delayed from avatar_storage_objects where id = ${expired.id}`)[0]?.['delayed']).toBe(true);
    expect(await store.application.get(context())).toEqual(after);
  });

  it('keeps uploaded photos through provider refresh and restores the newest provider photo on removal', async () => {
    const auth = createSharedAuthStore(db), identityInput = { issuer: 'https://auth.example.test', subject: randomUUID(), displayName: 'Photo owner', workspaceName: 'Private', timezone: 'UTC', avatarUrl: 'https://lh3.googleusercontent.com/a/first=s96-c' };
    const principal = await auth.provisionIdentity(identityInput), ctx = context(principal.user.id);
    const row = await store.application.prepare(ctx, input(0, ctx.actor.userId), 'a'.repeat(64));
    const saved = await store.application.finish(ctx, row, null);
    const latest = 'https://lh3.googleusercontent.com/a/second=s96-c';
    await auth.provisionIdentity({ ...identityInput, avatarUrl: latest });
    expect((await createAccessRepository(db).findUser(ctx.actor.userId))?.avatarUrl).toBe(saved.avatarUrl);
    expect((await store.application.remove(ctx, input(saved.revision, ctx.actor.userId))).avatarUrl).toBe(latest);
  });

  it('projects the uploaded image consistently into memberships, comments and the activity timeline', async () => {
    const picture = await store.application.get(context()), access = createAccessRepository(db);
    expect((await access.findUser(U.owner))?.avatarUrl).toBe(picture.avatarUrl);
    expect((await access.listActiveMemberships(W.team)).find(member => member.userId === U.owner)?.avatarUrl).toBe(picture.avatarUrl);
    const tasks = createTaskApplication(db), project = await tasks.createProject(command(), { name: 'Avatar projections' });
    const status = required((await tasks.listStatuses(command(), project.id)).find(row => row.group === 'todo'));
    const task = await tasks.createTask(command(), { projectId: project.id, title: 'With photo', statusId: status.id });
    const comments = createTaskCommentsApplication(db, { secret: 'synthetic-avatar-test-cursor-secret-long-enough' });
    await comments.createComment(command(), task.id, { body: 'Photo test' });
    const list = await comments.listComments(command(), task.id, { limit: 20 });
    expect(list.items[0]?.authorAvatarUrl).toBe(picture.avatarUrl);
    const timeline = await comments.listTimeline(command(), task.id, { limit: 20 });
    expect(timeline.items.some(item => item.type === 'comment' && item.comment.authorAvatarUrl === picture.avatarUrl)).toBe(true);
    expect(timeline.items.some(item => item.type === 'activity' && item.actorAvatarUrl === picture.avatarUrl)).toBe(true);
    const id = required(picture.avatarUrl).split('/').at(-1);
    expect(picture.avatarUrl).toBe(uploadedAvatarUrl(U.owner, required(id)));
  });
});
