import type { QueryKey } from '@tanstack/react-query';

/**
 * Everything the server returns for an actor lives under ['actor', actorId],
 * and workspace data additionally under the workspace ID, so switching either
 * one can never reuse another context's cache entries.
 */
export const queryKeys = {
  me: ['me'] as const,
  devActors: ['dev', 'actors'] as const,
  actor: (actorId: string) => ['actor', actorId] as const,
  workspaces: (actorId: string) => ['actor', actorId, 'workspaces'] as const,
  workspace: (actorId: string, workspaceId: string) => ['actor', actorId, 'workspace', workspaceId] as const,
  memberships: (actorId: string, workspaceId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'memberships'] as const,
  projectList: (actorId: string, workspaceId: string) => ['actor', actorId, 'workspace', workspaceId, 'projects'] as const,
  /** Prefix of the project itself and its sections and statuses. */
  project: (actorId: string, workspaceId: string, projectId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'project', projectId] as const,
  sections: (actorId: string, workspaceId: string, projectId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'project', projectId, 'sections'] as const,
  statuses: (actorId: string, workspaceId: string, projectId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'project', projectId, 'statuses'] as const,
  tags: (actorId: string, workspaceId: string) => ['actor', actorId, 'workspace', workspaceId, 'tags'] as const,
  /** Prefix of every task list and task detail in the workspace. */
  tasks: (actorId: string, workspaceId: string) => ['actor', actorId, 'workspace', workspaceId, 'tasks'] as const,
  projectTaskLists: (actorId: string, workspaceId: string, projectId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'tasks', 'list', projectId] as const,
  /** `params` are the normalized filters and page size, without a cursor. */
  taskList: (actorId: string, workspaceId: string, projectId: string, params: object) =>
    ['actor', actorId, 'workspace', workspaceId, 'tasks', 'list', projectId, params] as const,
  task: (actorId: string, workspaceId: string, taskId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'tasks', 'detail', taskId] as const,
};

/** The workspace key that scopes `key`, or null for keys outside any workspace. */
export function workspaceScopeOf(key: QueryKey): ReturnType<typeof queryKeys.workspace> | null {
  const [root, actorId, kind, workspaceId] = key;
  if (root === 'actor' && typeof actorId === 'string' && kind === 'workspace' && typeof workspaceId === 'string') {
    return queryKeys.workspace(actorId, workspaceId);
  }
  return null;
}

export function isActorKey(key: QueryKey, actorId: string): boolean {
  return key[0] === 'actor' && key[1] === actorId;
}
