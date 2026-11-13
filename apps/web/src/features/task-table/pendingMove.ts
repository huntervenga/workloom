import type { TaskDto } from '@workloom/contracts';
import { compareTaskRows } from './taskOrdering';
import { dedupeTasks } from './workPackages';

/** A table move that was dropped and is not in the list yet: sent, or confirmed before the list is read again. */
export interface PendingMove {
  taskId: string;
  anchorTaskId: string | null;
  placement: 'before' | 'after';
  /** Given when rows are grouped by assignee: the person of the lane the row was dropped in. */
  responsibleMembershipId?: string | null | undefined;
}

/**
 * Shows a dropped row at its drop place until the list confirms it, so the row neither waits for the
 * server nor for the list read after it (the server renumbers the whole project order, and only the
 * moved task comes back with the answer). Display only, like a pending edit: the server still places
 * the task (a root task takes its anchor's section, an assignee lane its person), the row returns if
 * the move fails, and a move without an anchor (an empty lane) waits for the answer.
 */
export function withPendingMove<T extends TaskDto>(tasks: readonly T[], move: PendingMove | null | undefined): readonly T[] {
  if (!move || move.anchorTaskId === null || move.anchorTaskId === move.taskId) return tasks;
  const moved = tasks.find(task => task.id === move.taskId);
  const anchor = tasks.find(task => task.id === move.anchorTaskId);
  if (!moved || !anchor || moved.parentTaskId !== anchor.parentTaskId) return tasks;
  const byAssignee = move.responsibleMembershipId !== undefined;
  const lane = dedupeTasks(tasks.filter(task => task.id !== moved.id && task.parentTaskId === anchor.parentTaskId
    && (byAssignee ? task.responsibleMembershipId === anchor.responsibleMembershipId : task.sectionId === anchor.sectionId)))
    .sort((left, right) => compareTaskRows(left, right, 'manual'));
  const at = lane.findIndex(task => task.id === anchor.id);
  const neighbour = lane[move.placement === 'before' ? at - 1 : at + 1];
  const position = neighbour ? (anchor.position + neighbour.position) / 2 : anchor.position + (move.placement === 'before' ? -1 : 1);
  const sectionId = !byAssignee && moved.parentTaskId === null ? anchor.sectionId : moved.sectionId;
  const responsibleMembershipId = byAssignee ? move.responsibleMembershipId ?? null : moved.responsibleMembershipId;
  return tasks.map(task => task.id === moved.id ? { ...task, position, sectionId, responsibleMembershipId } : task);
}

/** Several moves of one drop, in the order they are sent: each next row is placed after the one before. */
export function withPendingMoves<T extends TaskDto>(tasks: readonly T[], moves: readonly PendingMove[] | null | undefined): readonly T[] {
  return (moves ?? []).reduce<readonly T[]>((shown, move) => withPendingMove(shown, move), tasks);
}

/**
 * The moves that drop several rows together: the first lands at the drop place, every next one right
 * after the one before, so the rows keep the order they were shown in (and the anchor's section).
 */
export function blockMoves(taskIds: readonly string[], anchorTaskId: string | null, placement: 'before' | 'after', responsibleMembershipId?: string | null): PendingMove[] {
  return taskIds.map((taskId, index) => ({
    taskId,
    anchorTaskId: index === 0 ? anchorTaskId : taskIds[index - 1] ?? null,
    placement: index === 0 ? placement : 'after',
    ...(responsibleMembershipId !== undefined ? { responsibleMembershipId } : {}),
  }));
}
