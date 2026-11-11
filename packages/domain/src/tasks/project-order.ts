import type { TaskDto, TaskProjectPlacementDto } from '@workloom/contracts';

/**
 * One row of a project's shared order: an own task (its home is the project) or a linked placement
 * (a task of another project shown here). Both live in one numeric sequence: the table shows a
 * linked row before the first own task with a larger number, and after an own task with the same one.
 */
export type ProjectOrderItem =
  | { readonly kind: 'task'; readonly task: TaskDto }
  | { readonly kind: 'placement'; readonly row: TaskProjectPlacementDto }
  /** The place of the task being moved or created; its number is the slot's rank. */
  | { readonly kind: 'slot' };

/** Linked placements of the project in display order; the home placements mirror the tasks themselves. */
export function linkedPlacementsInOrder(rows: readonly TaskProjectPlacementDto[], projectId: string): TaskProjectPlacementDto[] {
  return rows
    .filter(row => row.projectId === projectId && row.homeProjectId !== projectId && row.archivedAt === null)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Merges linked placements into the project's own task order by their current numbers: each goes right
 * before the first own task with a larger number, so it keeps its neighbours. A `null` in `own` is the
 * new place of the task being moved or created: it is not compared, the linked rows stay where they were.
 */
export function mergeProjectOrder(own: readonly (TaskDto | null)[], linked: readonly TaskProjectPlacementDto[]): ProjectOrderItem[] {
  const items: ProjectOrderItem[] = [];
  let next = 0;
  for (const task of own) {
    if (task === null) { items.push({ kind: 'slot' }); continue; }
    while (next < linked.length && (linked[next] as TaskProjectPlacementDto).position < task.position) items.push({ kind: 'placement', row: linked[next++] as TaskProjectPlacementDto });
    items.push({ kind: 'task', task });
  }
  while (next < linked.length) items.push({ kind: 'placement', row: linked[next++] as TaskProjectPlacementDto });
  return items;
}

/** The anchor of a placement move: an own task or another linked placement of the project. */
export type ProjectOrderAnchor = { readonly taskId: string } | { readonly placementId: string };

/**
 * Puts a linked placement next to an anchor of the shared order. Without an anchor it goes after the last
 * root row of `sectionId` (own root task or linked placement), or at the very end when the section is empty.
 * Returns null when the anchor is not in the order.
 */
export function placeInProjectOrder(
  items: readonly ProjectOrderItem[], moving: TaskProjectPlacementDto, anchor: ProjectOrderAnchor | null, placement: 'before' | 'after', sectionId: string | null,
): ProjectOrderItem[] | null {
  const rest = items.filter(item => item.kind !== 'slot' && (item.kind !== 'placement' || item.row.id !== moving.id));
  const self: ProjectOrderItem = { kind: 'placement', row: moving };
  let index: number;
  if (anchor === null) {
    const last = rest.findLastIndex(item => item.kind === 'task' ? item.task.parentTaskId === null && item.task.archivedAt === null && item.task.sectionId === sectionId : item.kind === 'placement' && item.row.sectionId === sectionId);
    index = last < 0 ? rest.length : last + 1;
  } else {
    const at = rest.findIndex(item => 'taskId' in anchor ? item.kind === 'task' && item.task.id === anchor.taskId : item.kind === 'placement' && item.row.id === anchor.placementId);
    if (at < 0) return null;
    index = placement === 'before' ? at : at + 1;
  }
  return [...rest.slice(0, index), self, ...rest.slice(index)];
}
