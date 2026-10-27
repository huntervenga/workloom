import {
  ATTACHMENT_UPLOAD_TTL_MS, MAX_TASK_ATTACHMENTS, deleteAttachmentInputSchema, idSchema,
  reserveAttachmentInputSchema, taskAttachmentSchema, type TaskAttachmentDto,
} from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import { roleHasCapability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError, unauthenticatedError } from '../errors.js';
import { canonicalJson } from '../tasks/service.js';
import type { AttachmentApplication, AttachmentRecord, AttachmentRepository, AttachmentTools, AttachmentUnitOfWork, AttachmentWriteScope } from './ports.js';

const active = (row: AttachmentRecord) => ['pending', 'uploading', 'ready'].includes(row.state);
export function attachmentDto(row: AttachmentRecord): TaskAttachmentDto {
  const { id, workspaceId, taskId, uploadedByUserId, fileName, sizeBytes, state, revision, createdAt, uploadExpiresAt } = row;
  return { id, workspaceId, taskId, uploadedByUserId, fileName, sizeBytes, state, revision, createdAt, uploadExpiresAt };
}
function id(value: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw notFoundError();
  return parsed.data;
}
function context(value: CommandContext): CommandContext {
  const actor = idSchema.safeParse(value.actor.userId);
  if (!actor.success) throw unauthenticatedError();
  return { ...value, workspaceId: id(value.workspaceId), actor: { ...value.actor, userId: actor.data } };
}
async function target(repo: AttachmentRepository, ctx: CommandContext, taskId: string, write = false) {
  const task = await repo.findTarget(ctx.workspaceId, taskId);
  if (!task || task.visibility !== 'workspace') throw notFoundError();
  if (write && (task.archivedAt || task.projectArchivedAt)) {
    throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Restore the task and project before changing attachments.');
  }
  return task;
}
async function find(repo: AttachmentRepository, ctx: CommandContext, taskId: string, attachmentId: string) {
  const row = await repo.find(ctx.workspaceId, taskId, attachmentId);
  if (!row) throw notFoundError();
  return row;
}
async function guard(scope: AttachmentWriteScope, command: 'attachment.reserve' | 'attachment.start' | 'attachment.finish' | 'attachment.delete', taskId: string, input: unknown) {
  if (await scope.planningGuard.check({ family: 'attachment', command, target: { taskId }, input })) {
    throw new Error('An attachment unexpectedly entered planning mutation.');
  }
}
function expectedActor(ctx: CommandContext, expected: string) {
  if (ctx.actor.userId !== expected) throw unauthenticatedError('The account has changed. Refresh and retry.');
}
function liveAttempt(row: AttachmentRecord, ctx: CommandContext, now: Date, state: 'pending' | 'uploading') {
  if (row.uploadedByUserId !== ctx.actor.userId) throw notFoundError();
  if (row.state !== state || Date.parse(row.uploadExpiresAt) <= now.getTime()) {
    throw new DomainError('REVISION_CONFLICT', 'This upload attempt is no longer available.');
  }
}
async function change(scope: AttachmentWriteScope, row: AttachmentRecord, action: string) {
  await scope.recordChange({ entityType: 'task_attachment', entityId: row.id, entityRevision: row.revision, action,
    diff: { taskId: row.taskId }, outbox: { type: `attachment.${action}`, payload: { taskId: row.taskId, attachmentId: row.id } } });
}

export function createAttachmentApplication(unit: AttachmentUnitOfWork, tools: AttachmentTools): AttachmentApplication {
  async function read(value: CommandContext, task: string, attachmentId?: string) {
    const ctx = context(value), taskId = id(task);
    return unit.read(async repo => {
      const access = await authorizeWorkspace(repo.access, ctx, 'task.read');
      const found = await target(repo, ctx, taskId);
      if (attachmentId !== undefined) return find(repo, ctx, taskId, id(attachmentId));
      // An expired reservation no longer occupies a visible slot while durable cleanup waits
      // for the late-write grace period. Reserve performs the corresponding CAS under the barrier.
      const now = Date.now();
      const items = (await repo.list(ctx.workspaceId, taskId))
        .filter(row => active(row) && (row.state === 'ready' || Date.parse(row.uploadExpiresAt) > now)).map(attachmentDto);
      const writable = roleHasCapability(access.membership.role, 'task.edit') && !found.archivedAt && !found.projectArchivedAt;
      return { items, remainingSlots: MAX_TASK_ATTACHMENTS - items.length, canUpload: Boolean(writable && items.length < MAX_TASK_ATTACHMENTS), canDelete: Boolean(writable) };
    });
  }
  async function receipt(scope: AttachmentWriteScope, ctx: CommandContext, command: string, taskId: string, input: unknown) {
    const key = ctx.idempotencyKey;
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new DomainError('VALIDATION_FAILED', 'An Idempotency-Key is required.');
    const hash = tools.digest(canonicalJson({ command, taskId, input }));
    const old = await scope.repository.findIdempotency(ctx.workspaceId, ctx.actor.userId, command, key);
    if (old && old.payloadHash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key belongs to another request.');
    return { old: old ? taskAttachmentSchema.parse(old.result) : null,
      save: (row: AttachmentRecord) => scope.repository.insertIdempotency({ workspaceId: ctx.workspaceId, actorUserId: ctx.actor.userId, command, idempotencyKey: key, payloadHash: hash, result: attachmentDto(row), createdAt: scope.barrierAt.toISOString() }) };
  }
  return {
    async list(ctx, taskId) { const result = await read(ctx, taskId); if (!('items' in result)) throw new Error('Invalid attachment list.'); return result; },
    async get(ctx, taskId, attachmentId) { const result = await read(ctx, taskId, attachmentId); if ('items' in result) throw new Error('Invalid attachment.'); return attachmentDto(result); },
    async download(ctx, taskId, attachmentId) {
      const row = await read(ctx, taskId, attachmentId);
      if ('items' in row || row.state !== 'ready') throw notFoundError();
      return row;
    },
    async reserve(value, task, input, storageId) {
      const ctx = context(value), taskId = id(task), parsed = reserveAttachmentInputSchema.safeParse(input);
      if (!parsed.success || !/^[a-f0-9]{64}$/.test(storageId)) throw new DomainError('VALIDATION_FAILED', 'Invalid attachment.');
      expectedActor(ctx, parsed.data.expectedActorId);
      return unit.run(ctx, 'task.edit', async scope => {
        await target(scope.repository, ctx, taskId);
        const saved = await receipt(scope, ctx, 'attachment.reserve', taskId, parsed.data);
        if (saved.old) {
          const current = await find(scope.repository, ctx, taskId, saved.old.id);
          if (['pending', 'uploading'].includes(current.state) && Date.parse(current.uploadExpiresAt) <= scope.barrierAt.getTime()) {
            await guard(scope, 'attachment.reserve', taskId, parsed.data);
            const expired: AttachmentRecord = { ...current, state: 'expired', revision: current.revision + 1 };
            await scope.repository.save(expired, current.revision);
            return attachmentDto(expired);
          }
          return attachmentDto(current);
        }
        await target(scope.repository, ctx, taskId, true);
        await guard(scope, 'attachment.reserve', taskId, parsed.data);
        const rows = await scope.repository.list(ctx.workspaceId, taskId);
        for (const row of rows) {
          if (['pending', 'uploading'].includes(row.state) && Date.parse(row.uploadExpiresAt) <= scope.barrierAt.getTime()) {
            await scope.repository.save({ ...row, state: 'expired', revision: row.revision + 1 }, row.revision);
            row.state = 'expired';
          }
        }
        const used = new Set(rows.filter(active).map(row => row.slot));
        const slot = Array.from({ length: MAX_TASK_ATTACHMENTS }, (_, i) => i + 1).find(slot => !used.has(slot));
        if (!slot) throw new DomainError('ATTACHMENT_LIMIT_REACHED', 'A task can have at most five attachments.');
        const attachmentId = tools.newId();
        const row: AttachmentRecord = { id: attachmentId, workspaceId: ctx.workspaceId, taskId, uploadedByUserId: ctx.actor.userId,
          fileName: parsed.data.fileName, sizeBytes: parsed.data.sizeBytes, state: 'pending', revision: 1, slot, storageId,
          objectKey: `attachments/${ctx.workspaceId}/${attachmentId}/${tools.newId()}`, versionId: null, checksum: null,
          createdAt: scope.barrierAt.toISOString(), uploadExpiresAt: new Date(scope.barrierAt.getTime() + ATTACHMENT_UPLOAD_TTL_MS).toISOString() };
        await scope.repository.insert(row);
        await change(scope, row, 'reserved');
        await saved.save(row);
        return attachmentDto(row);
      });
    },
    async startUpload(value, task, attachmentId) {
      const ctx = context(value), taskId = id(task);
      return unit.run(ctx, 'task.edit', async scope => {
        await target(scope.repository, ctx, taskId, true);
        const row = await find(scope.repository, ctx, taskId, id(attachmentId));
        liveAttempt(row, ctx, scope.barrierAt, 'pending');
        await guard(scope, 'attachment.start', taskId, { id: row.id });
        const next: AttachmentRecord = { ...row, state: 'uploading', revision: row.revision + 1 };
        await scope.repository.save(next, row.revision);
        return next;
      });
    },
    async finishUpload(value, previous, result) {
      const ctx = context(value);
      return unit.run(ctx, 'task.edit', async scope => {
        await target(scope.repository, ctx, previous.taskId, true);
        const row = await find(scope.repository, ctx, previous.taskId, previous.id);
        liveAttempt(row, ctx, scope.barrierAt, 'uploading');
        if (row.revision !== previous.revision || row.objectKey !== previous.objectKey) throw new DomainError('REVISION_CONFLICT', 'The upload changed.');
        await guard(scope, 'attachment.finish', row.taskId, { id: row.id });
        const next: AttachmentRecord = { ...row, state: 'ready', revision: row.revision + 1, ...result };
        await scope.repository.save(next, row.revision);
        await change(scope, next, 'created');
        return attachmentDto(next);
      });
    },
    async remove(value, task, attachmentId, input) {
      const ctx = context(value), taskId = id(task), parsed = deleteAttachmentInputSchema.safeParse(input);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid attachment deletion.');
      expectedActor(ctx, parsed.data.expectedActorId);
      return unit.run(ctx, 'task.edit', async scope => {
        await target(scope.repository, ctx, taskId);
        const row = await find(scope.repository, ctx, taskId, id(attachmentId));
        const saved = await receipt(scope, ctx, 'attachment.delete', taskId, { id: row.id, ...parsed.data });
        if (saved.old) return saved.old;
        await target(scope.repository, ctx, taskId, true);
        if (row.revision !== parsed.data.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Refresh the attachment and retry.');
        await guard(scope, 'attachment.delete', taskId, parsed.data);
        const next: AttachmentRecord = { ...row, state: 'deleted', revision: row.revision + 1 };
        await scope.repository.save(next, row.revision);
        await change(scope, next, 'deleted');
        await saved.save(next);
        return attachmentDto(next);
      });
    },
  };
}
