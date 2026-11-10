export interface AttributableTask { id: string; parentTaskId: string | null; responsibleMembershipId: string | null }

/**
 * The person whose time a task's values count for: its own assignee, or, for a subtask without one,
 * the nearest ancestor in the same list that has an assignee. Subtasks are usually created without an
 * assignee, so counting them for nobody would drop their hours from every per-person total.
 * An explicit subtask assignee always wins. Keys are lowercase task IDs.
 */
export function attributedAssignees(tasks: readonly AttributableTask[]): Map<string, string | null> {
  const byId = new Map(tasks.map(task => [task.id.toLowerCase(), task]));
  const result = new Map<string, string | null>();
  for (const task of tasks) {
    const seen = new Set<string>([task.id.toLowerCase()]);
    let current: AttributableTask | undefined = task;
    while (current && current.responsibleMembershipId === null && current.parentTaskId !== null) {
      const parentId = current.parentTaskId.toLowerCase();
      if (seen.has(parentId)) break;
      seen.add(parentId);
      current = byId.get(parentId);
    }
    result.set(task.id.toLowerCase(), current?.responsibleMembershipId ?? null);
  }
  return result;
}
