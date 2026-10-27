import type { DeleteAttachmentInput, ReserveAttachmentInput, TaskAttachmentDto, TaskAttachmentList } from '@workloom/contracts';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import type { AccessRepository } from '../access/ports.js';
import type { PlanningMutationGuard } from '../planning/ports.js';
import type { CommentTarget } from '../task-comments/ports.js';
import type { IdempotencyRecord } from '../tasks/ports.js';
import type { WorkspaceWriteScope } from '../transactions/ports.js';

/** Internal projection; storage locators never enter a browser DTO or receipt. */
export interface AttachmentRecord extends TaskAttachmentDto {
  readonly storageId: string;
  readonly objectKey: string;
  readonly slot: number;
  readonly versionId: string | null;
  readonly checksum: string | null;
}
export interface AttachmentRepository {
  readonly access: AccessRepository;
  findTarget(workspaceId: string, taskId: string): Promise<CommentTarget | null>;
  list(workspaceId: string, taskId: string): Promise<AttachmentRecord[]>;
  find(workspaceId: string, taskId: string, id: string): Promise<AttachmentRecord | null>;
  insert(record: AttachmentRecord): Promise<void>;
  save(record: AttachmentRecord, previousRevision: number): Promise<void>;
  findIdempotency(workspaceId: string, actorId: string, command: string, key: string): Promise<IdempotencyRecord | null>;
  insertIdempotency(record: IdempotencyRecord): Promise<void>;
}
export interface AttachmentWriteScope extends WorkspaceWriteScope {
  readonly repository: AttachmentRepository;
  readonly planningGuard: PlanningMutationGuard;
}
export interface AttachmentUnitOfWork {
  read<T>(work: (repository: AttachmentRepository) => Promise<T>): Promise<T>;
  run<T>(context: CommandContext, capability: Capability, work: (scope: AttachmentWriteScope) => Promise<T>): Promise<T>;
}
export interface AttachmentTools { newId(): string; digest(value: string): string }
export interface AttachmentApplication {
  list(context: CommandContext, taskId: string): Promise<TaskAttachmentList>;
  get(context: CommandContext, taskId: string, id: string): Promise<TaskAttachmentDto>;
  reserve(context: CommandContext, taskId: string, input: ReserveAttachmentInput, storageId: string): Promise<TaskAttachmentDto>;
  startUpload(context: CommandContext, taskId: string, id: string): Promise<AttachmentRecord>;
  finishUpload(context: CommandContext, record: AttachmentRecord, result: { versionId: string | null; checksum: string }): Promise<TaskAttachmentDto>;
  remove(context: CommandContext, taskId: string, id: string, input: DeleteAttachmentInput): Promise<TaskAttachmentDto>;
  /** Must be called on EVERY download request, before a signed URL cache lookup. */
  download(context: CommandContext, taskId: string, id: string): Promise<AttachmentRecord>;
}
