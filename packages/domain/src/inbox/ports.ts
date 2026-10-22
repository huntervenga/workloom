import type { InboxItemDto } from '@workloom/contracts';
import type { AccessRepository } from '../access/ports.js';

export interface InboxReadRepository {
  readonly access: AccessRepository;
  /** Newest first. Only tasks of this workspace, never archived tasks or the person's own actions. */
  list(workspaceId: string, membershipId: string, options: { windowDays: number; take: number; includePendingLeave: boolean }): Promise<InboxItemDto[]>;
}
export interface InboxReadUnitOfWork {
  run<R>(read: (repository: InboxReadRepository) => Promise<R>): Promise<R>;
}
