import type { AccessRepository } from '../access/ports.js';

export interface WorkspaceChangeHeadRecord {
  readonly workspaceId: string;
  readonly changeSeq: bigint;
  readonly permissionEpoch: bigint;
}
/** Deliberately exposes only reads: no barrier, cutoff, receipt, audit or job interfaces. */
export interface WorkspaceChangeHeadReadRepository {
  readonly access: AccessRepository;
  findHead(workspaceId: string): Promise<WorkspaceChangeHeadRecord | null>;
}
/** Authorization and the scalar head must use one repeatable-read, read-only snapshot. */
export interface WorkspaceChangeHeadReadUnitOfWork {
  run<R>(read: (repository: WorkspaceChangeHeadReadRepository) => Promise<R>): Promise<R>;
}
