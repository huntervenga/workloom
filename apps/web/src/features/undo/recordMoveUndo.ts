import type { QueryClient } from '@tanstack/react-query';
import type { MoveTaskDto, MoveUndoAck, TaskRevisionHead } from '@workloom/contracts';
import { ApiError, sendMutation } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { restoreMoveTaskRequest } from '../tasks/api';
import { projectUndoFor, undoScope } from './projectUndo';
import type { UndoHeads } from './UndoStore';
const source = (id: string) => `task:${id}`;
/** Confirmed heads are complete unique pairs; no read after the write may supply a missing one. */
export function validMoveHeads(ack: MoveUndoAck, task: MoveTaskDto): boolean {
  const before = new Map(ack.beforeHeads.map(row => [row.taskId, row.revision]));
  const after = new Map(ack.afterHeads.map(row => [row.taskId, row.revision]));
  return before.size > 0 && before.size === ack.beforeHeads.length && after.size === ack.afterHeads.length && before.size === after.size
    && after.get(task.id) === task.revision && ack.afterHeads.every(row => before.has(row.taskId) && row.revision > (before.get(row.taskId) ?? Infinity));
}
export function recordMoveUndo(client: QueryClient, actor: string, workspace: string, after: MoveTaskDto, expectedRevision: number, originalKey: string, receipt: string) {
  if (after.workspaceId !== workspace) return;
  const ack = after.moveUndo, scope = undoScope(actor, workspace, after.projectId);
  if (!ack || ack.originalKey !== originalKey || !validMoveHeads(ack, after) || ack.beforeHeads.find(row => row.taskId === after.id)?.revision !== expectedRevision) {
    projectUndoFor(client).record({ id: `move:${receipt}`, receipt, scope, kind: 'unsupported', heads: {}, beforeHeads: {} }); return;
  }
  const confirmed = structuredClone(ack);
  projectUndoFor(client).record({ id: `move:${receipt}`, receipt, scope, kind: 'edit',
    heads: Object.fromEntries(confirmed.afterHeads.map(row => [source(row.taskId), row.revision])),
    beforeHeads: Object.fromEntries(confirmed.beforeHeads.map(row => [source(row.taskId), row.revision])),
    prepare: (guards, key) => {
      const expectedHeads: TaskRevisionHead[] = confirmed.afterHeads.map(row => {
        const revision = guards[source(row.taskId)];
        if (revision === undefined) throw new ApiError({ kind: 'invalid_input', status: null });
        return { taskId: row.taskId, revision };
      });
      const expectedRevision = expectedHeads.find(row => row.taskId === after.id)?.revision;
      if (expectedRevision === undefined) throw new ApiError({ kind: 'invalid_input', status: null });
      const request = restoreMoveTaskRequest(workspace, after.id, { expectedRevision, expectedHeads, originalMoveKey: confirmed.originalKey, expectedOrderFingerprint: confirmed.orderFingerprint });
      return async () => {
        const result = (await sendMutation(request, { idempotencyKey: key })).data;
        const restored = result.moveUndo;
        if (result.id !== after.id || result.workspaceId !== workspace || result.projectId !== after.projectId || !restored || restored.originalKey !== confirmed.originalKey || !validMoveHeads(restored, result)
          || restored.beforeHeads.length !== expectedHeads.length || restored.beforeHeads.some(row => !expectedHeads.some(expected => expected.taskId === row.taskId && expected.revision === row.revision))) throw new ApiError({ kind: 'invalid_response', status: null });
        // Only heads that the server verified and restored may advance an older undo entry.
        const heads: UndoHeads = Object.fromEntries(restored.afterHeads.map(row => [source(row.taskId), row.revision]));
        void client.invalidateQueries({ queryKey: queryKeys.workspace(actor, workspace) }); return heads;
      };
    },
  });
}
