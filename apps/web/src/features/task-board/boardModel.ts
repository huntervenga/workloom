import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { dedupeTasks } from '../task-table';

export type BoardParent =
  | { kind: 'none' }
  | { kind: 'loaded'; task: TaskDto }
  | { kind: 'not_loaded'; id: string };
export interface BoardCard {
  task: TaskDto;
  parent: BoardParent;
}
export interface BoardLane {
  statusId: string;
  status: TaskStatusDto | null;
  cards: BoardCard[];
}
export interface BoardModel {
  lanes: BoardLane[];
  loadedCount: number;
}

/** Only the supplied loaded set is projected; hierarchy never duplicates or hides a task. */
export function buildBoardModel(tasks: readonly TaskDto[], statuses: readonly TaskStatusDto[]): BoardModel {
  const uniqueTasks = dedupeTasks(tasks);
  const byTaskId = new Map(uniqueTasks.map(task => [task.id, task]));
  const byStatusId = new Map<string, TaskStatusDto>();
  for (const status of statuses) {
    const current = byStatusId.get(status.id);
    if (!current || status.revision > current.revision) byStatusId.set(status.id, status);
  }
  const lanes: BoardLane[] = [...byStatusId.values()]
    .sort((left, right) => left.position - right.position || compareIds(left.id, right.id))
    .map(status => ({ statusId: status.id, status, cards: [] }));
  const byLaneId = new Map(lanes.map(lane => [lane.statusId, lane]));
  const missing = new Map<string, BoardLane>();
  for (const task of uniqueTasks) {
    let lane = byLaneId.get(task.statusId) ?? missing.get(task.statusId);
    if (!lane) {
      lane = { statusId: task.statusId, status: null, cards: [] };
      missing.set(task.statusId, lane);
    }
    const parent = task.parentTaskId === null ? undefined : byTaskId.get(task.parentTaskId);
    lane.cards.push({ task, parent: task.parentTaskId === null ? { kind: 'none' } : parent ? { kind: 'loaded', task: parent } : { kind: 'not_loaded', id: task.parentTaskId } });
  }
  lanes.push(...[...missing.values()].sort((left, right) => compareIds(left.statusId, right.statusId)));
  return { lanes, loadedCount: uniqueTasks.length };
}

function compareIds(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
