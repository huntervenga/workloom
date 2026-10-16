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
  myTasks: (actorId: string, workspaceId: string, filters: object) =>
    ['actor', actorId, 'workspace', workspaceId, 'tasks', 'my', filters] as const,
  projectTaskLists: (actorId: string, workspaceId: string, projectId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'tasks', 'list', projectId] as const,
  /** `params` are the normalized filters and page size, without a cursor. */
  taskList: (actorId: string, workspaceId: string, projectId: string, params: object) =>
    ['actor', actorId, 'workspace', workspaceId, 'tasks', 'list', projectId, params] as const,
  task: (actorId: string, workspaceId: string, taskId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'tasks', 'detail', taskId] as const,
  workCategoryBinding: (actorId: string, workspaceId: string, projectId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'workCategoryBinding', canonicalId(projectId)] as const,
  timeSummaries: (actorId: string, workspaceId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'timeSummaries'] as const,
  /**
   * Prefix of custom field definitions, column settings, values and value history. Field keys
   * lowercase their project, task and field IDs, so a read keyed by a mixed-case ID is
   * invalidated by a write whose confirmed answer carries the canonical lowercase ID.
   */
  fields: (actorId: string, workspaceId: string) => ['actor', actorId, 'workspace', workspaceId, 'fields'] as const,
  fieldDefinitions: (actorId: string, workspaceId: string, projectId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'fields', 'definitions', canonicalId(projectId)] as const,
  projectColumns: (actorId: string, workspaceId: string, projectId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'fields', 'columns', canonicalId(projectId)] as const,
  /** Prefix of every value query, per task and per project batch. */
  fieldValues: (actorId: string, workspaceId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'fields', 'values'] as const,
  taskFieldValues: (actorId: string, workspaceId: string, taskId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'fields', 'values', 'task', canonicalId(taskId)] as const,
  /** Prefix of a project's value batches. */
  projectFieldValues: (actorId: string, workspaceId: string, projectId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'fields', 'values', 'project', canonicalId(projectId)] as const,
  /** `taskIds` is one chunk: unique, sorted, at most 200. */
  projectFieldValueChunk: (actorId: string, workspaceId: string, projectId: string, taskIds: readonly string[]) =>
    [
      'actor',
      actorId,
      'workspace',
      workspaceId,
      'fields',
      'values',
      'project',
      canonicalId(projectId),
      taskIds.map(canonicalId),
    ] as const,
  taskFieldHistory: (actorId: string, workspaceId: string, taskId: string, fieldId: string) =>
    ['actor', actorId, 'workspace', workspaceId, 'fields', 'history', canonicalId(taskId), canonicalId(fieldId)] as const,
};

/** UUIDs compare case-insensitively; field keys store them lowercase. */
function canonicalId(id: string): string {
  return id.toLowerCase();
}

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
