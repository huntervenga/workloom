import { TASK_MOVE_UNDO_LIMITS, type TaskDto, type TaskRevisionHead } from '@workloom/contracts';

/**
 * Server-only inverse sources of captured moves (`captureUndo: true`). Each source is an internal
 * receipt in the existing idempotency table, scoped by workspace and actor like every receipt, under
 * its own command and the ORIGINAL move's Idempotency-Key. It is never part of a public response.
 */
export const MOVE_UNDO_SOURCE_COMMAND = 'task.move.undo-source';
/** Receipt command of `restoreMoveTask`; the planning guard deliberately sees it as `task.move`. */
export const MOVE_RESTORE_COMMAND = 'task.move.restore';

/** The grouping identity a move may change on its source task; parent is captured to assert it never changed. */
export interface MoveUndoGroup {
  readonly sectionId: string | null;
  readonly parentTaskId: string | null;
  readonly responsibleMembershipId: string | null;
  readonly statusId: string;
}

/**
 * Complete pre-move numeric positions of every project row (archived and unloaded included) and the
 * source's grouping. No title, description or other payload: restore keeps every other current field.
 */
export interface MoveUndoSource {
  readonly v: 1;
  readonly taskId: string;
  readonly projectId: string;
  readonly originalKey: string;
  readonly before: MoveUndoGroup;
  readonly after: MoveUndoGroup;
  readonly affectedTaskIds: readonly string[];
  readonly positions: readonly { readonly taskId: string; readonly position: number }[];
  readonly beforeFingerprint: string;
  readonly afterFingerprint: string;
}

export function moveGroupOf(task: TaskDto): MoveUndoGroup {
  return {
    sectionId: task.sectionId,
    parentTaskId: task.parentTaskId,
    responsibleMembershipId: task.responsibleMembershipId,
    statusId: task.statusId,
  };
}

/**
 * Semantic order of the complete project: IDs, exact numeric positions, section, parent, responsible
 * person, status and archive state. Revisions, titles, descriptions, dates and every other field are
 * excluded from this fingerprint. Independent affected-row core guards still conservatively block
 * foreign edits; our own confirmed edit/undo chain may advance those expected heads.
 */
export function orderFingerprint(hash: (value: unknown) => string, projectId: string, rows: readonly TaskDto[]): string {
  const sorted = [...rows].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hash({
    v: 1,
    projectId,
    rows: sorted.map((row) => [row.id, row.position, row.sectionId, row.parentTaskId, row.responsibleMembershipId, row.statusId, row.archivedAt]),
  });
}

/** Rows whose revision the command changed, before and after, sorted by task ID. */
export function revisionHeads(
  before: readonly TaskDto[],
  after: readonly TaskDto[],
): { beforeHeads: TaskRevisionHead[]; afterHeads: TaskRevisionHead[] } {
  const previous = new Map(before.map((row) => [row.id, row.revision]));
  const written = after
    .filter((row) => previous.get(row.id) !== row.revision)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    beforeHeads: written.flatMap((row) => {
      const revision = previous.get(row.id);
      return revision === undefined ? [] : [{ taskId: row.id, revision }];
    }),
    afterHeads: written.map((row) => ({ taskId: row.id, revision: row.revision })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isNullableText = (value: unknown): value is string | null => value === null || isText(value);

function parseGroup(value: unknown): MoveUndoGroup | null {
  if (!isRecord(value)) return null;
  const { sectionId, parentTaskId, responsibleMembershipId, statusId } = value;
  if (!isNullableText(sectionId) || !isNullableText(parentTaskId) || !isNullableText(responsibleMembershipId) || !isText(statusId)) return null;
  return { sectionId, parentTaskId, responsibleMembershipId, statusId };
}

/** Strict reader of a stored source; null means it does not match this contract. */
export function parseMoveUndoSource(value: unknown): MoveUndoSource | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { taskId, projectId, originalKey, beforeFingerprint, afterFingerprint, positions, affectedTaskIds } = value;
  if (!isText(taskId) || !isText(projectId) || !isText(originalKey) || !isText(beforeFingerprint) || !isText(afterFingerprint)) return null;
  const before = parseGroup(value.before), after = parseGroup(value.after);
  if (before === null || after === null || !Array.isArray(positions) || positions.length > TASK_MOVE_UNDO_LIMITS.maxProjectTasks || !Array.isArray(affectedTaskIds) || affectedTaskIds.length > TASK_MOVE_UNDO_LIMITS.maxProjectTasks || !affectedTaskIds.length || !affectedTaskIds.every(isText) || new Set(affectedTaskIds).size !== affectedTaskIds.length || !affectedTaskIds.includes(taskId)) return null;
  const rows: { taskId: string; position: number }[] = [];
  for (const row of positions as unknown[]) {
    if (!isRecord(row) || !isText(row.taskId) || typeof row.position !== 'number' || !Number.isInteger(row.position) || row.position < 0) return null;
    rows.push({ taskId: row.taskId, position: row.position });
  }
  if (new Set(rows.map((row) => row.taskId)).size !== rows.length || !rows.some((row) => row.taskId === taskId)) return null;
  if (affectedTaskIds.some(id => !rows.some(row => row.taskId === id))) return null;
  return { v: 1, taskId, projectId, originalKey, before, after, positions: rows, affectedTaskIds, beforeFingerprint, afterFingerprint };
}
