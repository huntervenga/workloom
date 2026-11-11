import type { TaskDto, TaskStatusGroup } from '@workloom/contracts';
import { compareDueTasks, type TaskSortMode } from './taskOrdering';
import type { TaskTreeNode } from './taskTree';

/**
 * A task whose home is another project, shown in this project through a placement. It sits in the
 * placement's section and order among the project's own tasks; its hours and fields count in its home.
 */
export interface TaskTableLinkedRow {
  /** Placement ID: the row identity. */
  id: string;
  /** Placement revision: guards a move of the row. */
  revision: number;
  /** The canonical task; `projectId` is its home project. */
  task: TaskDto;
  /** Section and order in the viewed project. */
  sectionId: string | null;
  position: number;
  /** The shared status, from the home project's workflow. */
  status: { name: string; group: TaskStatusGroup };
  homeProject: { id: string; name: string };
}

/** A linked root row followed by its linked descendants, in display order. */
export interface LinkedRowBlock {
  root: TaskTableLinkedRow;
  rows: readonly { row: TaskTableLinkedRow; depth: number }[];
}

/** As the server merges the project's shared order: by number, then by placement ID. */
const byPlacementOrder = (left: TaskTableLinkedRow, right: TaskTableLinkedRow) =>
  left.position - right.position || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** Orders a linked row against a task of the project, as the table orders its own rows. */
function compareWithTask(row: TaskTableLinkedRow, task: TaskDto, sort: TaskSortMode): number {
  if (sort === 'due_asc') return compareDueTasks(row.task, task) || row.position - task.position;
  return row.position - task.position;
}

/**
 * Linked rows by their section in this project (or by assignee). A linked subtask whose parent is also
 * linked here stays under that parent, as in the project's own tree; the others are roots of their section.
 */
export function linkedRowBlocks(rows: readonly TaskTableLinkedRow[], sort: TaskSortMode, by: 'section' | 'assignee' = 'section'): Map<string | null, LinkedRowBlock[]> {
  // By assignee the table is a flat sequence per person, so linked rows are flat there too.
  if (by === 'assignee') {
    const byPerson = new Map<string | null, LinkedRowBlock[]>();
    const seen = new Set<string>();
    const ordered = [...rows].sort(byPlacementOrder).filter(row => !seen.has(row.task.id) && seen.add(row.task.id));
    if (sort === 'due_asc') ordered.sort((a, b) => compareDueTasks(a.task, b.task) || byPlacementOrder(a, b));
    for (const row of ordered) byPerson.set(row.task.responsibleMembershipId, [...(byPerson.get(row.task.responsibleMembershipId) ?? []), { root: row, rows: [{ row, depth: 0 }] }]);
    return byPerson;
  }
  const byTaskId = new Map<string, TaskTableLinkedRow>();
  for (const row of [...rows].sort(byPlacementOrder)) if (!byTaskId.has(row.task.id)) byTaskId.set(row.task.id, row);
  const unique = [...byTaskId.values()];
  const childrenOf = new Map<string, TaskTableLinkedRow[]>();
  const roots: TaskTableLinkedRow[] = [];
  for (const row of unique) {
    const parentId = row.task.parentTaskId;
    if (parentId !== null && byTaskId.has(parentId) && parentId !== row.task.id) childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), row]);
    else roots.push(row);
  }
  const visited = new Set<string>();
  const walk = (row: TaskTableLinkedRow, depth: number, into: { row: TaskTableLinkedRow; depth: number }[]) => {
    if (visited.has(row.task.id)) return;
    visited.add(row.task.id);
    into.push({ row, depth });
    for (const child of childrenOf.get(row.task.id) ?? []) walk(child, depth + 1, into);
  };
  const blocks: LinkedRowBlock[] = [];
  const orderedRoots = sort === 'due_asc' ? [...roots].sort((a, b) => compareDueTasks(a.task, b.task) || byPlacementOrder(a, b)) : roots;
  for (const root of orderedRoots) { const items: { row: TaskTableLinkedRow; depth: number }[] = []; walk(root, 0, items); blocks.push({ root, rows: items }); }
  // A parent cycle leaves rows unvisited: show each as a root so nothing disappears.
  for (const row of unique) if (!visited.has(row.task.id)) { const items: { row: TaskTableLinkedRow; depth: number }[] = []; walk(row, 0, items); blocks.push({ root: row, rows: items }); }
  const bySection = new Map<string | null, LinkedRowBlock[]>();
  for (const block of blocks) bySection.set(block.root.sectionId, [...(bySection.get(block.root.sectionId) ?? []), block]);
  return bySection;
}

/**
 * Where linked blocks go among a section's visible rows: before the first own root task that comes
 * after them, never inside a task's subtree. On a tie the project's own task stays first.
 * Returns insertion indexes into `rows`, each with its blocks in order.
 */
export function placeLinkedBlocks(rows: readonly TaskTreeNode[], blocks: readonly LinkedRowBlock[], sort: TaskSortMode): Map<number, LinkedRowBlock[]> {
  const rootStarts = rows.flatMap((node, index) => node.depth === 0 ? [index] : []);
  const placed = new Map<number, LinkedRowBlock[]>();
  for (const block of blocks) {
    const before = rootStarts.find(index => { const node = rows[index]; return node !== undefined && compareWithTask(block.root, node.task, sort) < 0; });
    const at = before ?? rows.length;
    placed.set(at, [...(placed.get(at) ?? []), block]);
  }
  return placed;
}
