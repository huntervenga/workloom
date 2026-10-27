import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DuplicationCopyOptions } from '@workloom/contracts';
import type { AttachmentRecord, CommandContext } from '@workloom/domain';
import { createAttachmentStore, createDatabase, createDuplicationApplication, createTaskApplication,
  runMigrations, seedDemoData, FIXTURE_WORKSPACE_IDS as W, FIXTURE_USER_IDS as U, FIXTURE_MEMBERSHIP_IDS as M,
  type AttachmentCopyStorage, type AttachmentStore, type Database } from '@workloom/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';

requireTestDatabaseUrl();
const storageId = 'a'.repeat(64);
const ctx = (userId: string = U.owner): CommandContext => ({ workspaceId: W.team, actor: { userId, kind: 'fixture', displayName: 'Copy tester' },
  source: 'web', requestId: randomUUID(), idempotencyKey: randomUUID() });
const copy: DuplicationCopyOptions = { description: true, assignee: true, dates: true, tags: true, priority: true, participants: true, subtasks: true, customFieldIds: [] };
const checksum = createHash('sha256').update('abc').digest('hex');
function required<T>(value: T | undefined | null): T { if (value === null || value === undefined) throw new Error('Missing fixture'); return value; }

describe('independent attachment copies with real PostgreSQL and synthetic storage', () => {
  let target: ThrowawayDatabase, db: Database, store: AttachmentStore;
  const objects = new Map<string, string>();
  beforeAll(async () => {
    target = await createThrowawayDatabase('duplication_attachments');
    await runMigrations(target.url, { requireLoopback: true });
    db = createDatabase(target.url, { requireLoopback: true });
    await seedDemoData(db); store = createAttachmentStore(db);
  }, 90_000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30_000);
  async function fixture() {
    const tasks = createTaskApplication(db), project = await tasks.createProject(ctx(), { name: `Copy files ${randomUUID()}` });
    const statuses = await tasks.listStatuses(ctx(), project.id), done = required(statuses.find(s => s.group === 'done')), todo = required(statuses.find(s => s.group === 'todo'));
    const section = await tasks.createSection(ctx(), project.id, { name: 'Files' });
    const task = await tasks.createTask(ctx(), { projectId: project.id, sectionId: section.id, title: 'Original', statusId: done.id });
    const performCopy = vi.fn(async (source: AttachmentRecord, destination: AttachmentRecord, _signal: AbortSignal) => {
      const registry = await db.sql`select id from attachment_storage_objects where id = ${destination.id}`;
      expect(registry).toHaveLength(1); // Durable cleanup is committed before any storage write.
      objects.set(destination.objectKey, required(objects.get(source.objectKey)));
      return { versionId: `copy-${destination.id}` };
    });
    const storage: AttachmentCopyStorage = { storageId, copy: performCopy };
    const duplicates = createDuplicationApplication(db, { attachmentStorage: storage });
    const input = { projectId: project.id, title: 'Independent copy', copy };
    return { tasks, project, task, section, todo, done, performCopy, storage, duplicates, input };
  }
  async function ready(taskId: string, name = 'picture.png') {
    const context = ctx();
    const reserved = await store.application.reserve(context, taskId, { fileName: name, sizeBytes: 3, expectedActorId: context.actor.userId }, storageId);
    const uploading = await store.application.startUpload(context, taskId, reserved.id);
    objects.set(uploading.objectKey, 'abc');
    await store.recordStored(uploading, `source-${reserved.id}`);
    await store.application.finishUpload(context, uploading, { checksum, versionId: `source-${reserved.id}` });
    return store.application.download(context, taskId, reserved.id);
  }
  const remove = (row: AttachmentRecord) => store.application.remove(ctx(), row.taskId, row.id, { expectedActorId: U.owner, expectedRevision: row.revision });
  const taskIds = async (projectId: string) => (await db.sql`select id from tasks where project_id = ${projectId} order by id`).map(row => row['id']);
  const staged = (projectId: string) => db.sql`select o.* from attachment_storage_objects o join tasks t on o.task_id = t.id
    where t.project_id = ${projectId} and not exists (select 1 from task_attachments a where a.id = o.id)`;

  it('copies all five ready files and child files, resets status, and preserves copies when original files are removed', async () => {
    const f = await fixture(), originals: AttachmentRecord[] = [];
    for (let i = 0; i < 5; i++) originals.push(await ready(f.task.id, `picture-${i}.png`));
    const child = await f.tasks.createTask(ctx(), { projectId: f.project.id, sectionId: f.section.id, parentTaskId: f.task.id, title: 'Child', statusId: f.done.id });
    const childFile = await ready(child.id, 'video.mp4');
    await store.application.reserve(ctx(), child.id, { fileName: 'unfinished.txt', sizeBytes: 3, expectedActorId: U.owner }, storageId);
    const preview = await f.duplicates.previewTask(ctx(), f.task.id, f.input);
    expect(preview.attachmentCount).toBe(6);
    const command = ctx(), input = { ...f.input, expectedSourceVersion: preview.sourceVersion };
    const result = await f.duplicates.duplicateTask(command, f.task.id, input);
    const rootId = required(result.rootTaskId), copied = (await store.application.list(ctx(), rootId)).items;
    expect(copied).toHaveLength(5); expect(f.performCopy).toHaveBeenCalledTimes(6);
    for (const item of copied) {
      const record = await store.application.download(ctx(), rootId, item.id);
      const source = required(originals.find(row => row.fileName === record.fileName));
      expect(record).toMatchObject({ state: 'ready', sizeBytes: source.sizeBytes, checksum, slot: source.slot, revision: 1 });
      expect(record.id).not.toBe(source.id); expect(record.objectKey).not.toBe(source.objectKey);
      expect(record.versionId).not.toBe(source.versionId); expect(objects.get(record.objectKey)).toBe('abc');
      await remove(source);
    }
    const newChild = await f.tasks.getTask(ctx(), required(result.taskIds.find(id => id !== rootId)));
    expect(newChild).toMatchObject({ parentTaskId: rootId, statusId: f.todo.id, attachmentCount: 1 });
    expect((await store.application.list(ctx(), newChild.id)).items[0]?.fileName).toBe(childFile.fileName);
    const jobs = await store.claimCleanup(storageId);
    for (const job of jobs) { objects.delete(job.objectKey); await store.completeCleanup(job, true); }
    expect(jobs.filter(job => originals.some(row => row.id === job.id))).toHaveLength(5);
    for (const item of copied) expect(objects.get((await store.application.download(ctx(), rootId, item.id)).objectKey)).toBe('abc');
    const stored = await db.sql`select * from attachment_storage_objects where task_id = ${rootId}`;
    expect(stored).toHaveLength(5); expect(stored.every(row => row['cleanup_at'] === null)).toBe(true);
    // Replay does not require storage or unchanged originals, and never adds another copy.
    expect(await createDuplicationApplication(db).duplicateTask(command, f.task.id, input)).toEqual(result);
    expect(f.performCopy).toHaveBeenCalledTimes(6);
  });

  it('copies section task attachments and excludes descendants when Subtasks is off', async () => {
    const f = await fixture(); await ready(f.task.id);
    const child = await f.tasks.createTask(ctx(), { projectId: f.project.id, sectionId: f.section.id, parentTaskId: f.task.id, title: 'Child', statusId: f.todo.id });
    await ready(child.id);
    const input = { name: 'Copied section', includeTasks: true, includeSettings: false, copy: { ...copy, subtasks: false } };
    const preview = await f.duplicates.previewSection(ctx(), f.section.id, input);
    expect(preview.attachmentCount).toBe(1);
    const result = await f.duplicates.duplicateSection(ctx(), f.section.id, { ...input, expectedSourceVersion: preview.sourceVersion });
    expect(result.taskIds).toHaveLength(1);
    expect((await store.application.list(ctx(), required(result.taskIds[0]))).items).toHaveLength(1);
    const copied = await store.application.download(ctx(), required(result.taskIds[0]), required((await store.application.list(ctx(), required(result.taskIds[0]))).items[0]).id);
    await remove(copied);
    expect((await store.application.list(ctx(), f.task.id)).items).toHaveLength(1);
  });

  it('works without S3 for empty tasks and rejects unavailable or mismatched storage before creating a partial copy', async () => {
    const f = await fixture(), offline = createDuplicationApplication(db);
    const plain = await offline.previewTask(ctx(), f.task.id, f.input);
    await offline.duplicateTask(ctx(), f.task.id, { ...f.input, expectedSourceVersion: plain.sourceVersion });
    await ready(f.task.id);
    const before = await taskIds(f.project.id), preview = await f.duplicates.previewTask(ctx(), f.task.id, f.input);
    const error = { code: 'DOMAIN_VALIDATION_FAILED', details: { duplicationReason: 'attachment_storage_unavailable' } };
    await expect(offline.previewTask(ctx(), f.task.id, f.input)).rejects.toMatchObject(error);
    await expect(offline.duplicateTask(ctx(), f.task.id, { ...f.input, expectedSourceVersion: preview.sourceVersion })).rejects.toMatchObject(error);
    const wrong = createDuplicationApplication(db, { attachmentStorage: { ...f.storage, storageId: 'b'.repeat(64) } });
    await expect(wrong.previewTask(ctx(), f.task.id, f.input)).rejects.toMatchObject(error);
    expect(await taskIds(f.project.id)).toEqual(before); expect(await staged(f.project.id)).toHaveLength(0);
    expect(f.performCopy).not.toHaveBeenCalled();
  });

  it('keeps cleanup after an ambiguous storage failure and retries without partial tasks or duplicate receipts', async () => {
    const f = await fixture(); await ready(f.task.id);
    f.performCopy.mockImplementationOnce(async (_source, destination) => { objects.set(destination.objectKey, 'abc'); throw new Error('Provider connection lost'); });
    const preview = await f.duplicates.previewTask(ctx(), f.task.id, f.input), command = ctx(), input = { ...f.input, expectedSourceVersion: preview.sourceVersion };
    const before = await taskIds(f.project.id);
    await expect(f.duplicates.duplicateTask(command, f.task.id, input)).rejects.toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
    expect(await taskIds(f.project.id)).toEqual(before);
    const orphans = await staged(f.project.id);
    expect(orphans).toHaveLength(1); expect(orphans[0]?.['cleanup_at']).toBeTruthy(); expect(objects.has(String(orphans[0]?.['object_key']))).toBe(true);
    const result = await f.duplicates.duplicateTask(command, f.task.id, input);
    expect(await f.duplicates.duplicateTask(command, f.task.id, input)).toEqual(result);
    expect(f.performCopy).toHaveBeenCalledTimes(2); expect(await taskIds(f.project.id)).toHaveLength(before.length + 1);
    expect((await store.application.list(ctx(), required(result.rootTaskId))).items).toHaveLength(1);
  });

  it('binds the preview to file identities even when a replacement has the same count and filename', async () => {
    const f = await fixture(), original = await ready(f.task.id);
    const preview = await f.duplicates.previewTask(ctx(), f.task.id, f.input);
    await remove(original); await ready(f.task.id);
    await expect(f.duplicates.duplicateTask(ctx(), f.task.id, { ...f.input, expectedSourceVersion: preview.sourceVersion })).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(f.performCopy).not.toHaveBeenCalled(); expect(await staged(f.project.id)).toHaveLength(0);
  });

  it('rechecks sources after storage I/O without holding a workspace lock', async () => {
    const f = await fixture(), original = await ready(f.task.id), before = await taskIds(f.project.id);
    f.performCopy.mockImplementationOnce(async (_source, destination) => {
      await remove(original); // A separate workspace writer completes while copying.
      objects.set(destination.objectKey, 'abc'); return { versionId: 'late-copy' };
    });
    const preview = await f.duplicates.previewTask(ctx(), f.task.id, f.input);
    await expect(f.duplicates.duplicateTask(ctx(), f.task.id, { ...f.input, expectedSourceVersion: preview.sourceVersion })).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(await taskIds(f.project.id)).toEqual(before);
    expect((await staged(f.project.id))[0]?.['cleanup_at']).toBeTruthy();
  });

  it('rechecks permissions after copying and retains orphan cleanup on revocation', async () => {
    const f = await fixture(); await ready(f.task.id);
    const actor = ctx(U.memberA), before = await taskIds(f.project.id), saved = await membershipRow(db.sql, W.team, M.teamMemberA);
    const preview = await f.duplicates.previewTask(actor, f.task.id, f.input);
    f.performCopy.mockImplementationOnce(async (_source, destination) => {
      await revokeMembership(db.sql, W.team, M.teamMemberA);
      objects.set(destination.objectKey, 'abc'); return { versionId: 'revoked-copy' };
    });
    try {
      await expect(f.duplicates.duplicateTask(actor, f.task.id, { ...f.input, expectedSourceVersion: preview.sourceVersion })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await taskIds(f.project.id)).toEqual(before);
      expect((await staged(f.project.id))[0]?.['cleanup_at']).toBeTruthy();
    } finally { await restoreMembership(db.sql, W.team, M.teamMemberA, saved); }
  });

  it('rolls back newly created tasks when a staged object has expired before adoption', async () => {
    const f = await fixture(); await ready(f.task.id);
    const before = await taskIds(f.project.id), preview = await f.duplicates.previewTask(ctx(), f.task.id, f.input);
    f.performCopy.mockImplementationOnce(async (_source, destination) => {
      await db.sql`update attachment_storage_objects set write_deadline = clock_timestamp() - interval '1 second' where id = ${destination.id}`;
      return { versionId: 'expired-copy' };
    });
    await expect(f.duplicates.duplicateTask(ctx(), f.task.id, { ...f.input, expectedSourceVersion: preview.sourceVersion })).rejects.toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
    expect(await taskIds(f.project.id)).toEqual(before);
    expect((await staged(f.project.id))[0]?.['cleanup_at']).toBeTruthy();
  });

  it('concurrent retries commit one task and leave unused staged objects scheduled for cleanup', async () => {
    const f = await fixture(); await ready(f.task.id);
    const preview = await f.duplicates.previewTask(ctx(), f.task.id, f.input), actor = ctx(), input = { ...f.input, expectedSourceVersion: preview.sourceVersion };
    let count = 0; let release = () => {};
    const both = new Promise<void>(resolve => { release = resolve; });
    f.performCopy.mockImplementation(async (_source, destination) => {
      if (++count === 2) release();
      await both; objects.set(destination.objectKey, 'abc'); return { versionId: `concurrent-${destination.id}` };
    });
    const [a, b] = await Promise.all([f.duplicates.duplicateTask(actor, f.task.id, input), f.duplicates.duplicateTask(actor, f.task.id, input)]);
    expect(a).toEqual(b); expect(await taskIds(f.project.id)).toHaveLength(2);
    expect((await store.application.list(ctx(), required(a.rootTaskId))).items).toHaveLength(1);
    const orphans = await staged(f.project.id); expect(orphans).toHaveLength(1); expect(orphans[0]?.['cleanup_at']).toBeTruthy();
  });
});
