import type { TaskDto, UpdateTaskInput } from '@workloom/contracts';

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
 * tags, estimate and description need more than the input; those wait for the confirmed answer.
 */
export function withPendingEdit<T extends TaskDto>(tasks: readonly T[], pending: PendingEdit | null | undefined): readonly T[] {
  if (!pending) return tasks;
  const { input } = pending;
  const index = tasks.findIndex(task => task.id === pending.taskId);
  const task = tasks[index];
  if (task === undefined) return tasks;
  const shown: T = {
    ...task,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
  };
  return tasks.map((item, at) => at === index ? shown : item);
}
