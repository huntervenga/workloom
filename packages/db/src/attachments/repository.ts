import { and, eq, inArray, sql } from 'drizzle-orm';
import { DomainError, type AttachmentRecord, type AttachmentRepository } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { attachmentStorageObjects, taskAttachments } from '../schema.js';
import { createTaskCommentsRepository } from '../task-comments/repository.js';

const fromRow = (row: typeof taskAttachments.$inferSelect): AttachmentRecord => ({
  ...row, createdAt: row.createdAt.toISOString(), uploadExpiresAt: row.uploadExpiresAt.toISOString(),
});
export function createAttachmentRepository(db: WorkloomExecutor): AttachmentRepository {
  const shared = createTaskCommentsRepository(db);
  return {
    access: shared.access, findTarget: shared.findTarget,
    findIdempotency: shared.findIdempotency, insertIdempotency: shared.insertIdempotency,
    async list(workspaceId, taskId) {
      return (await db.select().from(taskAttachments).where(and(eq(taskAttachments.workspaceId, workspaceId), eq(taskAttachments.taskId, taskId), inArray(taskAttachments.state, ['pending', 'uploading', 'ready']))).orderBy(taskAttachments.createdAt)).map(fromRow);
    },
    async find(workspaceId, taskId, id) {
      const [row] = await db.select().from(taskAttachments).where(and(eq(taskAttachments.workspaceId, workspaceId), eq(taskAttachments.taskId, taskId), eq(taskAttachments.id, id))).limit(1);
      return row ? fromRow(row) : null;
    },
    async insert(row) {
      await db.insert(attachmentStorageObjects).values({ id: row.id, workspaceId: row.workspaceId, taskId: row.taskId,
        storageId: row.storageId, objectKey: row.objectKey, writeDeadline: new Date(row.uploadExpiresAt),
        cleanupAt: new Date(Date.parse(row.uploadExpiresAt) + 5 * 60_000) });
      await db.insert(taskAttachments).values({ ...row, createdAt: new Date(row.createdAt), uploadExpiresAt: new Date(row.uploadExpiresAt) });
    },
    async save(row, previousRevision) {
      const updated = await db.update(taskAttachments).set({ state: row.state, revision: row.revision, checksum: row.checksum, versionId: row.versionId })
        .where(and(eq(taskAttachments.workspaceId, row.workspaceId), eq(taskAttachments.id, row.id), eq(taskAttachments.revision, previousRevision))).returning({ id: taskAttachments.id });
      if (updated.length !== 1) throw new DomainError('REVISION_CONFLICT', 'The attachment changed. Refresh and retry.');
      if (row.state === 'ready') {
        await db.update(attachmentStorageObjects).set({ cleanupAt: null, versionId: row.versionId, leaseUntil: null, leaseToken: null }).where(eq(attachmentStorageObjects.id, row.id));
      } else if (['deleted', 'expired', 'failed'].includes(row.state)) {
        await db.update(attachmentStorageObjects).set({
          cleanupAt: sql`case when ${attachmentStorageObjects.cleanupAt} is null then clock_timestamp() else greatest(clock_timestamp(), ${attachmentStorageObjects.writeDeadline} + interval '5 minutes') end`,
        }).where(eq(attachmentStorageObjects.id, row.id));
      }
    },
  };
}
