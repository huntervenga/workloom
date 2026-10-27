import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createAttachmentApplication as createDomainAttachmentApplication, createPlanningMutationGuard, type AttachmentApplication, type AttachmentRecord, type AttachmentUnitOfWork } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { attachmentStorageObjects, taskAttachments } from '../schema.js';
import { createWorkspaceWriteRunner } from '../transactions/workspace-write.js';
import { createAttachmentRepository } from './repository.js';

export interface AttachmentCleanupJob {
  id: string; storageId: string; objectKey: string; versionId: string | null; leaseToken: string;
}
export interface AttachmentStore {
  application: AttachmentApplication;
  recordStored(row: AttachmentRecord, versionId: string | null): Promise<void>;
  failUpload(row: AttachmentRecord): Promise<void>;
  claimCleanup(storageId: string): Promise<AttachmentCleanupJob[]>;
  completeCleanup(job: AttachmentCleanupJob, success: boolean): Promise<void>;
}
/** All storage I/O is outside these bounded database transactions. */
export function createAttachmentStore(source: Database | WorkloomExecutor): AttachmentStore {
  const db = isDatabase(source) ? source.db : source, writer = createWorkspaceWriteRunner(source), recurrence = createRecurrenceRuntime();
  const tools = { newId: randomUUID, digest: (text: string) => createHash('sha256').update(text).digest('hex') };
  const unit: AttachmentUnitOfWork = {
    read: work => db.transaction(tx => work(createAttachmentRepository(tx)), { isolationLevel: 'repeatable read', accessMode: 'read only' }),
    run: (ctx, capability, work) => writer.run(ctx, capability, scope => work({ ...scope, repository: createAttachmentRepository(scope.tx),
      planningGuard: createPlanningMutationGuard(composeRecurrenceCensusScope(scope, recurrence), tools) })),
  };
  return {
    application: createDomainAttachmentApplication(unit, tools),
    async recordStored(row, versionId) {
      // This is an internal storage acknowledgement, not a grant or task mutation. It survives purge.
      await db.update(attachmentStorageObjects).set({ versionId }).where(and(eq(attachmentStorageObjects.id, row.id), eq(attachmentStorageObjects.objectKey, row.objectKey), eq(attachmentStorageObjects.storageId, row.storageId)));
    },
    async failUpload(row) {
      await db.transaction(async tx => {
        await tx.update(taskAttachments).set({ state: 'failed', revision: sql`${taskAttachments.revision} + 1` })
          .where(and(eq(taskAttachments.id, row.id), eq(taskAttachments.revision, row.revision), eq(taskAttachments.state, 'uploading')));
        // Keep the pre-recorded cleanup deadline even if auth vanished or the task was purged.
      });
    },
    async claimCleanup(storageId) {
      const leaseToken = randomUUID();
      const jobs = await db.transaction(async tx => {
        const rows = await tx.execute<{ id: string; object_key: string; storage_id: string; version_id: string | null }>(sql`
          with due as (
            select id from attachment_storage_objects
            where storage_id = ${storageId} and cleanup_at <= clock_timestamp()
              and (lease_until is null or lease_until < clock_timestamp())
            order by cleanup_at limit 10 for update skip locked
          ) update attachment_storage_objects o set lease_until = clock_timestamp() + interval '2 minutes',
              lease_token = ${leaseToken}, cleanup_attempts = cleanup_attempts + 1
            from due where o.id = due.id returning o.id, o.object_key, o.storage_id, o.version_id`);
        return rows.map(row => ({ id: row.id, storageId: row.storage_id, objectKey: row.object_key, versionId: row.version_id, leaseToken }));
      });
      // Release registry locks before touching task rows: writers acquire these in the opposite order.
      const ids = jobs.map(job => job.id);
      if (ids.length) await db.update(taskAttachments).set({ state: 'expired', revision: sql`${taskAttachments.revision} + 1` })
        .where(and(inArray(taskAttachments.id, ids), inArray(taskAttachments.state, ['pending', 'uploading']), sql`${taskAttachments.uploadExpiresAt} <= clock_timestamp()`));
      return jobs;
    },
    async completeCleanup(job, success) {
      await db.update(attachmentStorageObjects).set({ leaseUntil: null, leaseToken: null, lastError: success ? null : 'storage_unavailable',
        // Recheck through 24 h after the bounded write deadline; retain the tombstone afterwards.
        cleanupAt: success
          ? sql`case when clock_timestamp() > ${attachmentStorageObjects.writeDeadline} + interval '24 hours' then null else clock_timestamp() + interval '1 hour' end`
          : sql`clock_timestamp() + interval '5 minutes'`,
      }).where(and(eq(attachmentStorageObjects.id, job.id), eq(attachmentStorageObjects.leaseToken, job.leaseToken)));
    },
  };
}
