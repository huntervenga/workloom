import type { QueryClient } from '@tanstack/react-query';
import type { GraphLayoutDto, SetGraphLayoutInput, TaskScheduleApplyDto, TaskScheduleApplyInput, TaskSchedulePreviewDto } from '@workloom/contracts';
import { ApiError, sendMutation } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { setLayoutRequest } from '../dependencies/api';
import { reconcileLayoutAck } from '../dependencies/layoutReceiptCache';
import { applyScheduleRequest, previewSchedule } from '../schedule/api';
import { projectUndoFor, undoScope } from './projectUndo';
import type { UndoHeads } from './UndoStore';

const taskHead = (id: string) => `task:${id}`;
const layoutHead = (project: string, member: string) => `layout:${project}:${member}`;
function requiredHead(heads: Readonly<UndoHeads>, source: string): number {
  const value = heads[source];
  if (value === undefined) throw new ApiError({ kind: 'invalid_input', status: null });
  return value;
}
function refresh(client: QueryClient, actor: string, workspace: string) {
  void client.invalidateQueries({ queryKey: queryKeys.workspace(actor, workspace) });
}
function boundary(client: QueryClient, actor: string, workspace: string, project: string, receipt: string) {
  projectUndoFor(client).record({ id: `spatial:${receipt}`, receipt, scope: undoScope(actor, workspace, project), kind: 'unsupported', heads: {}, beforeHeads: {} });
}
/** The forward server preview is the immutable original, never a later context/cache read. */
export function recordScheduleUndo(client: QueryClient, actor: string, workspace: string, project: string, before: TaskSchedulePreviewDto | undefined, after: TaskScheduleApplyDto, input: TaskScheduleApplyInput, receipt: string) {
  if (after.projectId !== project) return;
  const exact = before?.projectId === project && before.previewHash === input.previewHash && before.rows.length === input.rows.length
    && after.tasks.length === input.rows.length && new Set(after.tasks.map(task => task.id)).size === input.rows.length
    && input.rows.every(row => {
      const source = before.rows.find(item => item.taskId === row.taskId);
      const ack = after.tasks.find(task => task.id === row.taskId);
      return !!source && !!ack && ack.workspaceId === workspace && ack.projectId === project && ack.revision >= row.expectedRevision
        && source.expectedRevision === row.expectedRevision && source.after.startDate === row.startDate && source.after.dueDate === row.dueDate
        && ack.startDate === row.startDate && ack.dueDate === row.dueDate;
    });
  if (!exact || !before) { boundary(client, actor, workspace, project, receipt); return; }
  const originals = structuredClone(before.rows);
  const confirmed = Object.fromEntries(after.tasks.map(task => [taskHead(task.id), task.revision]));
  projectUndoFor(client).record({ id: `schedule:${receipt}`, receipt, scope: undoScope(actor, workspace, project), kind: 'edit', heads: confirmed,
    beforeHeads: Object.fromEntries(originals.map(row => [taskHead(row.taskId), row.expectedRevision])),
    prepare: (heads, key) => {
      const rows = originals.map(row => ({ taskId: row.taskId, expectedRevision: requiredHead(heads, taskHead(row.taskId)), startDate: row.before.startDate, dueDate: row.before.dueDate }));
      // Freeze only after the keyless preview succeeds. Once sent, every retry uses this exact request/key.
      let request: ReturnType<typeof applyScheduleRequest> | undefined;
      return async () => {
        if (!request) {
          const preview = await previewSchedule(workspace, project, { rows });
          if (preview.protectedTargets.length || preview.recoveryPeriodIds.length) throw new ApiError({ kind: 'invalid_input', status: null });
          request = applyScheduleRequest(workspace, project, { rows, previewHash: preview.previewHash });
        }
        const result = (await sendMutation(request, { idempotencyKey: key })).data;
        if (result.tasks.length !== rows.length || new Set(result.tasks.map(task => task.id)).size !== rows.length || result.tasks.some(task => task.workspaceId !== workspace || task.projectId !== project || !rows.some(row => row.taskId === task.id && row.startDate === task.startDate && row.dueDate === task.dueDate && task.revision >= row.expectedRevision))) throw new ApiError({ kind: 'invalid_response', status: null });
        refresh(client, actor, workspace);
        return Object.fromEntries(result.tasks.map(task => [taskHead(task.id), task.revision]));
      };
    },
  });
}
/** Personal coordinates have an independent revision; the complete prior set retains hidden positions. */
export function recordLayoutUndo(client: QueryClient, actor: string, workspace: string, project: string, before: GraphLayoutDto | undefined, after: GraphLayoutDto, input: SetGraphLayoutInput, receipt: string) {
  if (after.workspaceId !== workspace || after.projectId !== project) return;
  const canonical = (positions: GraphLayoutDto['positions']) => JSON.stringify([...positions].sort((a, b) => a.taskId.localeCompare(b.taskId)));
  if (!before || before.workspaceId !== workspace || before.projectId !== project || before.membershipId !== after.membershipId || before.revision !== input.expectedRevision || after.revision < input.expectedRevision || canonical(after.positions) !== canonical(input.positions)) { boundary(client, actor, workspace, project, receipt); return; }
  const source = layoutHead(project, after.membershipId), positions = structuredClone(before.positions);
  projectUndoFor(client).record({ id: `layout:${receipt}`, receipt, scope: undoScope(actor, workspace, project), kind: 'edit', heads: { [source]: after.revision }, beforeHeads: { [source]: before.revision },
    prepare: (heads, key) => {
      const expectedRevision = requiredHead(heads, source);
      const request = setLayoutRequest(workspace, project, { expectedRevision, positions });
      return async () => {
        const result = (await sendMutation(request, { idempotencyKey: key })).data;
        if (result.workspaceId !== workspace || result.projectId !== project || result.membershipId !== after.membershipId || result.revision < expectedRevision || canonical(result.positions) !== canonical(positions)) throw new ApiError({ kind: 'invalid_response', status: null });
        await reconcileLayoutAck(client, actor, workspace, project, result);
        refresh(client, actor, workspace); return { [source]: result.revision };
      };
    },
  });
}
