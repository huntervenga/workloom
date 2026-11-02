import type { BulkUpdateTasksInput, TagDto, TaskDto, UpdateTaskInput } from '@workloom/contracts';

/** The one task update that has been sent and not answered yet. */
export interface PendingEdit {
  taskId: string;
  input: UpdateTaskInput;
}

/**
 * Shows a sent edit in its row before the server answers, so a cell never flashes its old value while the
 * save runs in the background. Display only: nothing here is a base, a guard or a draft, and the row returns
 * to the stored values if the save fails. Only fields that never move a row are shown early: a status, section
 * or assignee change regroups rows and keeps its own focus hand-over, a date keeps its recoverable draft, and
 * estimate and description need more than the input; those wait for the confirmed answer. Tags are named from
 * the row's own tags or the workspace catalog; an id known to neither is left out of the display.
 */
export function withPendingEdit<T extends TaskDto>(tasks: readonly T[], pending: PendingEdit | readonly PendingEdit[] | null | undefined, tagCatalog: readonly TagDto[] = []): readonly T[] {
  const edits = pending === null || pending === undefined ? [] : Array.isArray(pending) ? pending as readonly PendingEdit[] : [pending as PendingEdit];
  if (edits.length === 0) return tasks;
  const byTask = new Map(edits.map(edit => [edit.taskId, edit.input] as const));
  let changed = false;
  const shown = tasks.map(task => {
    const input = byTask.get(task.id);
    if (input === undefined) return task;
    changed = true;
    const next: T = {
      ...task,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.tagIds !== undefined ? { tags: input.tagIds.flatMap(id => task.tags.find(tag => tag.id === id) ?? tagCatalog.find(tag => tag.id === id) ?? []) } : {}),
    };
    return next;
  });
  return changed ? shown : tasks;
}

/** The display fields a sent selection-wide (bulk) update gives each of its tasks; an undo batch shows nothing early. */
export function pendingEditsOfBulk(input: BulkUpdateTasksInput | null | undefined): readonly PendingEdit[] {
  if (!input || input.changes.restore !== undefined) return [];
  const { priority, tagIds } = input.changes;
  if (priority === undefined && tagIds === undefined) return [];
  return input.tasks.map(row => ({ taskId: row.taskId, input: { expectedRevision: row.expectedRevision, ...(priority !== undefined ? { priority } : {}), ...(tagIds !== undefined ? { tagIds } : {}) } }));
}
