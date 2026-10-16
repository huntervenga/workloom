import type { MyTaskDto, MyTasksQuery } from '@workloom/contracts';
import type { AccessRepository } from '../access/ports.js';

export interface MyTasksAnchor { readonly dueDate: string | null; readonly id: string }
export interface MyTasksCursor extends MyTasksAnchor {
  readonly kind: 'my-tasks';
  readonly version: 1;
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly membershipId: string;
  readonly permissionEpoch: string;
  readonly queryHash: string;
}
export type MyTasksFilters = Omit<MyTasksQuery, 'cursor'>;
export interface MyTasksReadRepository {
  readonly access: AccessRepository;
  permissionEpoch(workspaceId: string): Promise<string>;
  list(workspaceId: string, membershipId: string, filters: MyTasksFilters, after: MyTasksAnchor | null, take: number): Promise<MyTaskDto[]>;
}
/** Authorization, cursor binding and every page/decorating query share this read-only snapshot. */
export interface MyTasksReadUnitOfWork {
  run<R>(read: (repository: MyTasksReadRepository) => Promise<R>): Promise<R>;
}
export interface MyTasksTools {
  digest(value: string): string;
  encodeCursor(value: MyTasksCursor): string;
  decodeCursor(value: string): MyTasksCursor;
}
