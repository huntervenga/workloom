import { workspaceChangeHeadResponseSchema, type WorkspaceChangeHeadDto } from '@workloom/contracts';
import { ApiError, apiGet } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { workspacePath } from './queries';

export const workspaceChangeHeadKey = (actorId: string, workspaceId: string) =>
  queryKeys.workspaceChangeHead(actorId, workspaceId);

export class WorkspaceHeadBindingError extends ApiError {
  readonly binding: 'actor' | 'workspace' | 'membership';

  constructor(init: { binding: 'actor' | 'workspace' | 'membership' }) {
    super({ kind: 'invalid_response', status: 200 });
    this.binding = init.binding;
  }
}

/** Validate binding before TanStack can put a response under the captured actor's key. */
export async function fetchWorkspaceChangeHead(
  actorId: string,
  workspaceId: string,
  membershipId: string | null,
  signal: AbortSignal,
): Promise<WorkspaceChangeHeadDto> {
  const head = (await apiGet(`${workspacePath(workspaceId)}/change-head`, workspaceChangeHeadResponseSchema, signal)).data;
  if (head.actorUserId !== actorId.toLowerCase()) throw new WorkspaceHeadBindingError({ binding: 'actor' });
  if (head.workspaceId !== workspaceId.toLowerCase()) throw new WorkspaceHeadBindingError({ binding: 'workspace' });
  if (membershipId !== null && head.membershipId !== membershipId.toLowerCase()) throw new WorkspaceHeadBindingError({ binding: 'membership' });
  return head;
}

export function sameWorkspaceHead(a: WorkspaceChangeHeadDto | null, b: WorkspaceChangeHeadDto): boolean {
  return a !== null && a.workspaceId === b.workspaceId && a.actorUserId === b.actorUserId &&
    a.membershipId === b.membershipId && a.membershipRevision === b.membershipRevision &&
    a.role === b.role && a.changeSeq === b.changeSeq && a.permissionEpoch === b.permissionEpoch;
}

export function workspaceAccessChanged(a: WorkspaceChangeHeadDto | null, b: WorkspaceChangeHeadDto): boolean {
  return a !== null && (a.membershipId !== b.membershipId || a.membershipRevision !== b.membershipRevision ||
    a.role !== b.role || a.permissionEpoch !== b.permissionEpoch);
}
