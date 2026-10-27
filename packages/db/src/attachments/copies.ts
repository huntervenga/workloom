import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { temporarilyUnavailableError, type AttachmentRecord, type CommandContext, type DuplicationAttachments, type PreparedAttachmentCopy } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { attachmentStorageObjects, taskAttachments } from '../schema.js';

/** Storage I/O is performed before the atomic duplication transaction. */
export interface AttachmentCopyStorage {
  readonly storageId: string;
  copy(source: AttachmentRecord, destination: AttachmentRecord, signal: AbortSignal): Promise<{ versionId: string | null }>;
}

/** Bound to the authorized duplication snapshot / workspace write transaction. */
export function createDuplicationAttachments(db: WorkloomExecutor): DuplicationAttachments {
  return {
    async listReady(workspaceId, taskIds) {
      if (!taskIds.length) return [];
      const rows = await db.select().from(taskAttachments).where(and(eq(taskAttachments.workspaceId, workspaceId),
        inArray(taskAttachments.taskId, [...taskIds]), eq(taskAttachments.state, 'ready')))
        .orderBy(taskAttachments.taskId, taskAttachments.createdAt, taskAttachments.id);
      return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString(), uploadExpiresAt: row.uploadExpiresAt.toISOString() }));
    },
    async adopt(row) {
      // A cleanup lease or elapsed write deadline can never be turned back into a live attachment.
      const adopted = await db.update(attachmentStorageObjects).set({ taskId: row.taskId, cleanupAt: null })
        .where(and(eq(attachmentStorageObjects.id, row.id), eq(attachmentStorageObjects.workspaceId, row.workspaceId),
          eq(attachmentStorageObjects.objectKey, row.objectKey), eq(attachmentStorageObjects.storageId, row.storageId),
          sql`${attachmentStorageObjects.versionId} is not distinct from ${row.versionId}`,
          isNotNull(attachmentStorageObjects.cleanupAt), isNull(attachmentStorageObjects.leaseToken),
          sql`${attachmentStorageObjects.writeDeadline} > clock_timestamp()`)).returning({ id: attachmentStorageObjects.id });
      if (adopted.length !== 1) throw temporarilyUnavailableError();
      await db.insert(taskAttachments).values({ ...row, createdAt: new Date(row.createdAt), uploadExpiresAt: new Date(row.uploadExpiresAt) });
    },
  };
}

/** No task writes or workspace locks here. Each new key is durably scheduled for cleanup BEFORE S3 I/O. */
export function createAttachmentCopyPreparation(db: WorkloomExecutor, storage: AttachmentCopyStorage) {
  return {
    storageId: storage.storageId,
    async prepare(context: CommandContext, sources: readonly AttachmentRecord[]): Promise<PreparedAttachmentCopy[]> {
      const createdAt = new Date(), deadline = new Date(createdAt.getTime() + 15 * 60_000);
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);
      const copies: PreparedAttachmentCopy[] = [];
      let cursor = 0;
      async function worker() {
        while (cursor < sources.length) {
          if (signal.aborted) throw temporarilyUnavailableError();
          const source = sources[cursor++];
          if (!source || source.storageId !== storage.storageId || source.state !== 'ready' || !source.checksum) throw temporarilyUnavailableError();
          const id = randomUUID();
          const row: AttachmentRecord = { ...source, id, objectKey: `attachments/${context.workspaceId}/${id}/${randomUUID()}`,
            uploadedByUserId: context.actor.userId, revision: 1, versionId: null, createdAt: createdAt.toISOString(), uploadExpiresAt: deadline.toISOString() };
          await db.insert(attachmentStorageObjects).values({ id, workspaceId: row.workspaceId, taskId: source.taskId,
            storageId: row.storageId, objectKey: row.objectKey, writeDeadline: deadline,
            cleanupAt: new Date(deadline.getTime() + 5 * 60_000) });
          const result = await storage.copy(source, row, signal);
          // Unknown results also retain cleanup: the worker can HEAD this unique key to resolve its version.
          await db.update(attachmentStorageObjects).set({ versionId: result.versionId }).where(eq(attachmentStorageObjects.id, id));
          copies.push({ sourceId: source.id, row: { ...row, versionId: result.versionId } });
        }
      }
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, sources.length) }, () => worker().catch(error => {
        controller.abort(); throw error;
      })));
      if (outcomes.some(result => result.status === 'rejected') || signal.aborted) throw temporarilyUnavailableError();
      return copies;
    },
  };
}
