import type { TaskDto } from '@workloom/contracts';
import { dedupeTasks } from './workPackages';

export type TaskSortMode = 'manual' | 'due_asc';

/** Own due dates, undated last, canonical ID ties: the same order as server due pages. */
export function compareDueTasks(left: TaskDto, right: TaskDto): number {
  if (left.dueDate !== right.dueDate) {
    if (left.dueDate === null) return 1;
    if (right.dueDate === null) return -1;
    return left.dueDate < right.dueDate ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Manual preserves the existing tree/flat-group display positions and tie breakers. */
export function compareTaskRows(left: TaskDto, right: TaskDto, sort: TaskSortMode): number {
  return sort === 'due_asc' ? compareDueTasks(left, right)
    : left.position - right.position || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/** New duplicate heads may change a due date without changing their first array position. */
export function orderBoardTaskHeads(tasks: readonly TaskDto[], sort: TaskSortMode): TaskDto[] {
  const heads = dedupeTasks(tasks);
  return sort === 'due_asc' ? heads.sort(compareDueTasks) : heads;
}
