import { describe, expect, it } from 'vitest';
import type { GraphLayoutDto, TaskScheduleApplyInput, TaskSchedulePreviewDto } from '@workloom/contracts';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi, ok, failure } from '../../test/fakeApi';
import { task, PROJECT_ID, STAMP } from '../planning/test/fixtures';
import { projectUndoFor, undoScope } from './projectUndo';
import { recordLayoutUndo, recordScheduleUndo } from './recordSpatialUndo';
const path = `/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}`;
const hash = 'a'.repeat(64), inverseHash = 'b'.repeat(64);
const source = { ...task, startDate: null, dueDate: '2026-10-20' };
const moved = { ...source, dueDate: '2026-10-22', revision: source.revision + 1 };
const input: TaskScheduleApplyInput = { rows: [{ taskId: source.id, expectedRevision: source.revision, startDate: null, dueDate: moved.dueDate }], previewHash: hash };
const preview: TaskSchedulePreviewDto = { projectId: PROJECT_ID, previewHash: hash, asOfChangeSeq: '1', rows: [{ taskId: source.id, expectedRevision: source.revision, before: { startDate: null, dueDate: source.dueDate }, after: { startDate: null, dueDate: moved.dueDate }, changed: true }], comparisons: [], protectedTargets: [], recoveryPeriodIds: [] };
const ack = { projectId: PROJECT_ID, tasks: [moved], asOfChangeSeq: '2' };
function setup() { const client = createQueryClient({ retry: false }); const store = projectUndoFor(client); store.activate(undoScope(anna.id, alpha.id, PROJECT_ID), true); return { client, store }; }
function inversePreview(body: unknown) {
  const rows = (body as TaskScheduleApplyInput).rows;
  return { ...preview, previewHash: inverseHash, rows: rows.map(row => ({ taskId: row.taskId, expectedRevision: row.expectedRevision, before: { startDate: moved.startDate, dueDate: moved.dueDate }, after: { startDate: row.startDate, dueDate: row.dueDate }, changed: true })) };
}
const layout: GraphLayoutDto = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: 'c0000000-0000-4000-8000-000000000001', viewKey: 'default', revision: 0, positions: [], updatedAt: null };
describe('confirmed spatial Undo', () => {
  it('restores a due-only move with captured null start through preview and one atomic apply', async () => {
    const { client, store } = setup();
    const { calls } = installFakeApi({
      [`POST ${path}/schedule-preview`]: request => { expect(request.body).toEqual({ rows: [{ taskId: source.id, expectedRevision: moved.revision, startDate: null, dueDate: source.dueDate }] }); return ok(inversePreview(request.body)); },
      [`POST ${path}/schedule-apply`]: request => { expect(request.body).toMatchObject({ previewHash: inverseHash }); return ok({ ...ack, tasks: [{ ...source, revision: moved.revision + 1 }] }); },
    });
    recordScheduleUndo(client, anna.id, alpha.id, PROJECT_ID, preview, ack, input, 'move'); await store.undo();
    expect(calls.filter(call => call.path.endsWith('schedule-apply'))).toHaveLength(1); expect(store.getSnapshot()).toMatchObject({ count: 0, notice: 'done' });
  });
  it('restores multiple distinct original date ranges in one guarded batch, including null endpoints', async () => {
    const second = { ...source, id: 'f2000000-0000-4000-8000-000000000099', startDate: '2026-10-10', dueDate: null, revision: 9 };
    const secondAfter = { ...second, startDate: '2026-10-12', revision: 10 };
    const original = { ...preview, rows: [...preview.rows, { taskId: second.id, expectedRevision: 9, before: { startDate: second.startDate, dueDate: null }, after: { startDate: secondAfter.startDate, dueDate: null }, changed: true }] };
    const forward = { ...input, rows: [...input.rows, { taskId: second.id, expectedRevision: 9, startDate: secondAfter.startDate, dueDate: null }] };
    const { client, store } = setup(); const { calls } = installFakeApi({
      [`POST ${path}/schedule-preview`]: request => ok(inversePreview(request.body)),
      [`POST ${path}/schedule-apply`]: request => { expect((request.body as TaskScheduleApplyInput).rows).toEqual([
        { taskId: source.id, expectedRevision: moved.revision, startDate: null, dueDate: source.dueDate },
        { taskId: second.id, expectedRevision: 10, startDate: '2026-10-10', dueDate: null },
      ]); return ok({ ...ack, tasks: [{ ...source, revision: moved.revision + 1 }, { ...second, revision: 11 }] }); },
    });
    recordScheduleUndo(client, anna.id, alpha.id, PROJECT_ID, original, { ...ack, tasks: [moved, secondAfter] }, forward, 'batch'); await store.undo();
    expect(calls.filter(call => call.path.endsWith('schedule-apply'))).toHaveLength(1); expect(store.getSnapshot().count).toBe(0);
  });
  it('does not build an inverse from missing, wrong or mismatched forward previews', async () => {
    for (const original of [undefined, { ...preview, previewHash: inverseHash }, { ...preview, rows: [] }]) {
      const { client, store } = setup(); const { calls } = installFakeApi({});
      recordScheduleUndo(client, anna.id, alpha.id, PROJECT_ID, original, ack, input, 'move'); await store.undo();
      expect(store.getSnapshot().notice).toBe('unsupported'); expect(calls).toHaveLength(0);
    }
  });
  it('rejects a colleague revision conflict before apply without falling through an older edit', async () => {
    const { client, store } = setup(); const { calls } = installFakeApi({ [`POST ${path}/schedule-preview`]: () => failure(409, 'REVISION_CONFLICT', 'changed') });
    recordScheduleUndo(client, anna.id, alpha.id, PROJECT_ID, preview, ack, input, 'move'); await store.undo();
    expect(calls).toHaveLength(1); expect(store.getSnapshot()).toMatchObject({ count: 1, notice: 'blocked' });
  });
  it('keeps the exact apply body/key after an unknown result without re-previewing a changed world', async () => {
    const { client, store } = setup(); let attempts = 0;
    const { calls } = installFakeApi({
      [`POST ${path}/schedule-preview`]: request => ok(inversePreview(request.body)),
      [`POST ${path}/schedule-apply`]: () => ++attempts === 1 ? failure(503, 'TEMPORARILY_UNAVAILABLE', 'unknown') : ok({ ...ack, tasks: [{ ...source, revision: moved.revision + 1 }] }),
    });
    recordScheduleUndo(client, anna.id, alpha.id, PROJECT_ID, preview, ack, input, 'move'); await store.undo(); expect(store.getSnapshot().notice).toBe('unknown');
    await store.undo(); const applies = calls.filter(call => call.path.endsWith('schedule-apply'));
    expect(calls.filter(call => call.path.endsWith('schedule-preview'))).toHaveLength(1); expect(applies).toHaveLength(2);
    expect(applies[1]?.body).toEqual(applies[0]?.body); expect(applies[1]?.headers.get('Idempotency-Key')).toBe(applies[0]?.headers.get('Idempotency-Key')); expect(store.getSnapshot().count).toBe(0);
  });
  it('blocks a newly protected or recovery-needed batch without sending any proposed inverse', async () => {
    for (const blocker of [{ protectedTargets: [{ taskId: task.id, reason: 'meeting_task' as const }] }, { recoveryPeriodIds: [PROJECT_ID] }]) {
      const { client, store } = setup(); const { calls } = installFakeApi({ [`POST ${path}/schedule-preview`]: request => ok({ ...inversePreview(request.body), ...blocker }) });
      recordScheduleUndo(client, anna.id, alpha.id, PROJECT_ID, preview, ack, input, 'move'); await store.undo(); expect(calls).toHaveLength(1); expect(store.getSnapshot().notice).toBe('blocked');
    }
  });
  it('clears a first personal graph position back to the genuinely empty previous set', async () => {
    const { client, store } = setup(); const after = { ...layout, revision: 1, updatedAt: STAMP, positions: [{ taskId: task.id, x: 240, y: 120 }] };
    const { calls } = installFakeApi({ [`PUT ${path}/graph-layout`]: request => { expect(request.body).toEqual({ expectedRevision: 1, positions: [] }); return ok({ ...layout, revision: 2, updatedAt: STAMP }); } });
    recordLayoutUndo(client, anna.id, alpha.id, PROJECT_ID, layout, after, { expectedRevision: 0, positions: after.positions }, 'layout'); await store.undo(); expect(calls).toHaveLength(1); expect(store.getSnapshot().count).toBe(0);
  });
  it('restores complete hidden coordinates and refuses to infer a missing independent layout head', async () => {
    const original = { ...layout, revision: 4, positions: [{ taskId: task.id, x: -20, y: 30 }, { taskId: 'f2000000-0000-4000-8000-000000000099', x: 12, y: 90 }] };
    const after = { ...original, revision: 5, positions: original.positions.map(row => ({ ...row, x: row.x + 50 })) };
    const { client, store } = setup(); installFakeApi({ [`PUT ${path}/graph-layout`]: request => { expect(request.body).toEqual({ expectedRevision: 5, positions: original.positions }); return ok({ ...original, revision: 6 }); } });
    recordLayoutUndo(client, anna.id, alpha.id, PROJECT_ID, original, after, { expectedRevision: 4, positions: after.positions }, 'layout'); await store.undo(); expect(store.getSnapshot().count).toBe(0);
    recordLayoutUndo(client, anna.id, alpha.id, PROJECT_ID, undefined, after, { expectedRevision: 4, positions: after.positions }, 'missing'); await store.undo(); expect(store.getSnapshot().notice).toBe('unsupported');
  });
});
