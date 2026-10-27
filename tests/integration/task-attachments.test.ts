import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAttachmentStore, createDatabase, createPurgeApplication, createTaskApplication, createMyTasksApplication, createTaskRepository, type AttachmentStore, type Database } from '@workloom/db';
import { FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS } from '@workloom/db/fixtures';
import type { CommandContext, AttachmentRecord } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { migrateAndSeed } from './support/db-cli.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';

requireTestDatabaseUrl();
const storageId = 'a'.repeat(64), workspaceId = FIXTURE_WORKSPACE_IDS.team;
const ctx = (userId: string = FIXTURE_USER_IDS.owner): CommandContext => ({ actor: { userId, displayName: 'Test', kind: 'fixture' }, workspaceId, source: 'web', requestId: randomUUID(), idempotencyKey: randomUUID() });
describe('durable task attachments', () => {
  let child: ThrowawayDatabase, db: Database, store: AttachmentStore;
  let taskId: string;
  const reserve = (context = ctx(), name = 'file.txt') => store.application.reserve(context, taskId, { expectedActorId: context.actor.userId, fileName: name, sizeBytes: 3 }, storageId);
  const ready = async (): Promise<AttachmentRecord> => {
    const context = ctx(), pending = await reserve(context), uploading = await store.application.startUpload(context, taskId, pending.id);
    await store.recordStored(uploading, 'version-1');
    await store.application.finishUpload(context, uploading, { checksum: 'b'.repeat(64), versionId: 'version-1' });
    return store.application.download(context, taskId, pending.id);
  };
  beforeAll(async () => {
    child = await createThrowawayDatabase('attachments');
    await migrateAndSeed(child.url);
    db = createDatabase(child.url); store = createAttachmentStore(db);
    const tasks = createTaskApplication(db);
    const project = await tasks.createProject(ctx(), { name: 'Attachments test' });
    const status = (await tasks.listStatuses(ctx(), project.id)).find(row => row.group === 'todo');
    if (!status) throw new Error('Missing task status.');
    taskId = (await tasks.createTask(ctx(), { projectId: project.id, statusId: status.id, title: 'Attachment target' })).id;
  }, 90_000);
  afterAll(async () => { if (db) await db.close(); if (child) await child.drop(); }, 30_000);
  const clear = async () => {
    const list = await store.application.list(ctx(), taskId);
    for (const row of list.items) await store.application.remove(ctx(), taskId, row.id, { expectedActorId: FIXTURE_USER_IDS.owner, expectedRevision: row.revision });
  };

  it('reserves at most five slots under concurrent requests and replays one exact reservation', async () => {
    const requests = Array.from({ length: 8 }, () => ctx());
    const results = await Promise.allSettled(requests.map(context => reserve(context)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter(result => result.status === 'rejected').map(result => result.reason.code)).toEqual(Array(3).fill('ATTACHMENT_LIMIT_REACHED'));
    const index = results.findIndex(result => result.status === 'fulfilled'), result = results[index];
    if (!result || result.status !== 'fulfilled') throw new Error('No reservation.');
    expect(await reserve(requests[index])).toEqual(result.value);
    expect((await store.application.list(ctx(), taskId)).remainingSlots).toBe(0);
    expect(JSON.stringify(result.value)).not.toMatch(/objectKey|storageId|versionId/);
    await clear();
  });

  it('denies viewers, foreign tasks and stale actor submissions, including receipt replay after revocation', async () => {
    await expect(reserve(ctx(FIXTURE_USER_IDS.viewer))).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    await expect(reserve(ctx(FIXTURE_USER_IDS.outsider))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.application.reserve(ctx(), taskId, { expectedActorId: FIXTURE_USER_IDS.viewer, fileName: 'file.txt', sizeBytes: 3 }, storageId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const context = ctx(FIXTURE_USER_IDS.memberA), row = await reserve(context);
    await child.sql`update memberships set state = 'revoked', revoked_at = clock_timestamp() where workspace_id = ${workspaceId} and user_id = ${context.actor.userId}`;
    try { await expect(reserve(context)).rejects.toMatchObject({ code: 'NOT_FOUND' }); }
    finally { await child.sql`update memberships set state = 'active', revoked_at = null where workspace_id = ${workspaceId} and user_id = ${context.actor.userId}`; }
    await store.application.remove(ctx(), taskId, row.id, { expectedActorId: FIXTURE_USER_IDS.owner, expectedRevision: row.revision });
  });

  it('publishes only completed uploads, rejects late completion and preserves cleanup after cancellation', async () => {
    const context = ctx(), pending = await reserve(context);
    await expect(store.application.download(context, taskId, pending.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const uploading = await store.application.startUpload(context, taskId, pending.id);
    await store.recordStored(uploading, 'orphan-version');
    await store.application.remove(ctx(), taskId, uploading.id, { expectedActorId: FIXTURE_USER_IDS.owner, expectedRevision: uploading.revision });
    await expect(store.application.finishUpload(context, uploading, { checksum: 'b'.repeat(64), versionId: 'orphan-version' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const [job] = await child.sql`select version_id, cleanup_at from attachment_storage_objects where id = ${uploading.id}`;
    expect(job?.version_id).toBe('orphan-version'); expect(job?.cleanup_at).not.toBeNull();
  });

  it('reauthorizes completion and returns ready metadata on replay after a lost success response', async () => {
    const context = ctx(FIXTURE_USER_IDS.memberA), pending = await reserve(context);
    const uploading = await store.application.startUpload(context, taskId, pending.id);
    await child.sql`update memberships set state = 'revoked', revoked_at = clock_timestamp() where workspace_id = ${workspaceId} and user_id = ${context.actor.userId}`;
    try { await expect(store.application.finishUpload(context, uploading, { checksum: 'b'.repeat(64), versionId: null })).rejects.toMatchObject({ code: 'NOT_FOUND' }); }
    finally { await child.sql`update memberships set state = 'active', revoked_at = null where workspace_id = ${workspaceId} and user_id = ${context.actor.userId}`; }
    await store.application.finishUpload(context, uploading, { checksum: 'b'.repeat(64), versionId: null });
    expect(await reserve(context)).toMatchObject({ id: pending.id, state: 'ready', revision: 3 });
    expect((await store.application.list(ctx(FIXTURE_USER_IDS.viewer), taskId)).canUpload).toBe(false);
    await clear();
  });

  it('expires abandoned attempts and claims cleanup exclusively across API replicas', async () => {
    const context = ctx(), pending = await reserve(context);
    await child.sql`update task_attachments set created_at = clock_timestamp() - interval '1 hour', upload_expires_at = clock_timestamp() - interval '30 minutes' where id = ${pending.id}`;
    expect((await store.application.list(ctx(), taskId)).remainingSlots).toBe(5);
    expect(await reserve(context)).toMatchObject({ id: pending.id, state: 'expired' });
    await child.sql`update attachment_storage_objects set cleanup_at = clock_timestamp() - interval '1 minute' where id = ${pending.id}`;
    const [left, right] = await Promise.all([store.claimCleanup(storageId), createAttachmentStore(db).claimCleanup(storageId)]);
    const jobs = [...left, ...right].filter(job => job.id === pending.id);
    expect(jobs).toHaveLength(1);
    expect((await store.application.get(ctx(), taskId, pending.id)).state).toBe('expired');
    const job = jobs[0]; if (!job) throw new Error('Missing cleanup job.');
    await store.completeCleanup(job, false);
    const [retry] = await child.sql`select cleanup_at > clock_timestamp() as delayed, last_error from attachment_storage_objects where id = ${pending.id}`;
    expect(retry).toMatchObject({ delayed: true, last_error: 'storage_unavailable' });
    expect((await store.application.list(ctx(), taskId)).items).toHaveLength(0);
  });

  it('streams a binary file larger than the ordinary JSON limit through real SDK HTTP into private storage', async () => {
    const writes: { body: Buffer; type: string | undefined; disposition: string | undefined }[] = [];
    const objects = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.method === 'PUT') {
        writes.push({ body: Buffer.concat(chunks), type: request.headers['content-type'], disposition: request.headers['content-disposition'] });
        response.writeHead(200, { 'x-amz-version-id': 'sdk-version' }); response.end();
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise<void>(resolve => objects.listen(0, '127.0.0.1', resolve));
    const port = (objects.address() as AddressInfo).port;
    const config = loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DATABASE_URL: child.url,
      ATTACHMENTS_S3_BUCKET: 'test-bucket', ATTACHMENTS_S3_REGION: 'us-east-1', ATTACHMENTS_S3_ENDPOINT: `http://127.0.0.1:${port}`,
      ATTACHMENTS_S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: 'test-access', AWS_SECRET_ACCESS_KEY: 'test-secret' });
    const app = await createApp(config, { database: db, logger: false, webDistDir: null, identityAdapter: { mode: 'dev', resolveActor: async () => ctx().actor } });
    const headers = { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' };
    try {
      const base = `/api/v1/workspaces/${workspaceId}/tasks/${taskId}/attachments`;
      const file = Buffer.alloc(65_536, 97);
      const reserved = await app.inject({ method: 'POST', url: base, headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { expectedActorId: FIXTURE_USER_IDS.owner, fileName: 'stream.html', sizeBytes: file.length } });
      expect(reserved.statusCode).toBe(201);
      const id: string = reserved.json().data.id;
      const uploaded = await app.inject({ method: 'PUT', url: `${base}/${id}/content`, headers: { ...headers, 'content-type': 'application/octet-stream', 'x-workloom-expected-actor': FIXTURE_USER_IDS.owner }, payload: file });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json().data.state).toBe('ready');
      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toEqual(file);
      expect(writes[0]?.type).toBe('application/octet-stream');
      expect(writes[0]?.disposition).toMatch(/^attachment;/);
      const link = await app.inject({ method: 'POST', url: `${base}/${id}/download-url`, headers });
      expect(link.statusCode).toBe(200);
      const signed = new URL(link.json().data.url);
      expect(signed.searchParams.get('versionId')).toBe('sdk-version');
      expect(signed.searchParams.get('X-Amz-Expires')).toBe('3600');
      // Removal still works when storage is temporarily unavailable; cleanup is durable.
      await clear();
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => objects.close(error => error ? reject(error) : resolve()));
    }
  });

  it('returns only ready counts in task pages, shared task lookups and personal lists, including zero after removal', async () => {
    await clear();
    const tasks = createTaskApplication(db);
    const initial = await tasks.getTask(ctx(), taskId);
    expect(initial.attachmentCount).toBe(0);
    const sibling = await tasks.createTask(ctx(), { projectId: initial.projectId, statusId: initial.statusId, title: 'No attachments' });
    const pending = await reserve();
    expect((await tasks.getTask(ctx(), taskId)).attachmentCount).toBe(0);
    const uploading = await store.application.startUpload(ctx(), taskId, pending.id);
    expect((await tasks.getTask(ctx(), taskId)).attachmentCount).toBe(0);
    await store.application.finishUpload(ctx(), uploading, { checksum: 'b'.repeat(64), versionId: null });
    const second = await ready();
    const failed = await reserve(), inProgress = await store.application.startUpload(ctx(), taskId, failed.id);
    await store.failUpload(inProgress);
    const expired = await reserve();
    await child.sql`update task_attachments set created_at = clock_timestamp() - interval '1 hour', upload_expires_at = clock_timestamp() - interval '30 minutes' where id = ${expired.id}`;
    await store.application.list(ctx(), taskId);

    const page = await tasks.listTasks(ctx(FIXTURE_USER_IDS.viewer), { projectId: initial.projectId, limit: 100 });
    expect(page.items.find(task => task.id === taskId)?.attachmentCount).toBe(2);
    expect(page.items.find(task => task.id === sibling.id)?.attachmentCount).toBe(0);
    // The same batch projection backs linked project placements and My Tasks.
    const repository = createTaskRepository(db);
    const batch = await repository.findTasksByIds(workspaceId, [taskId, sibling.id]);
    expect(batch.find(task => task.id === taskId)?.attachmentCount).toBe(2);
    expect(await repository.findTasksByIds(FIXTURE_WORKSPACE_IDS.outside, [taskId])).toEqual([]);
    const [membership] = await child.sql`select id from memberships where workspace_id = ${workspaceId} and user_id = ${FIXTURE_USER_IDS.owner}`;
    if (!membership) throw new Error('Owner membership missing.');
    await tasks.updateTask(ctx(), taskId, { expectedRevision: initial.revision, responsibleMembershipId: membership.id as string });
    const personal = await createMyTasksApplication(db).list(ctx(), { relation: 'all', completion: 'all', includeArchived: false, limit: 100 });
    expect(personal.items.find(row => row.task.id === taskId)?.task.attachmentCount).toBe(2);
    await store.application.remove(ctx(), taskId, second.id, { expectedActorId: FIXTURE_USER_IDS.owner, expectedRevision: second.revision });
    expect((await tasks.getTask(ctx(), taskId)).attachmentCount).toBe(1);
    await clear();
    expect((await tasks.getTask(ctx(), taskId)).attachmentCount).toBe(0);
  });

  it('keeps a durable exact-key deletion job when the task itself is purged', async () => {
    const row = await ready();
    const [task] = await child.sql<{ title: string }[]>`select title from tasks where id = ${taskId}`;
    if (!task) throw new Error('Missing task.');
    await createPurgeApplication(db).purgeTask(ctx(), taskId, { confirmTitle: task.title });
    expect(await child.sql`select id from task_attachments where id = ${row.id}`).toHaveLength(0);
    const [job] = await child.sql`select object_key, version_id, cleanup_at <= clock_timestamp() as due from attachment_storage_objects where id = ${row.id}`;
    expect(job).toMatchObject({ object_key: row.objectKey, version_id: 'version-1', due: true });
  });
});
