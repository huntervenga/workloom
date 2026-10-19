import { describe, expect, it } from 'vitest';
import type { MoveTaskDto, MoveUndoAck, RestoreMoveTaskInput } from '@workloom/contracts';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi, ok, failure } from '../../test/fakeApi';
import { task, PROJECT_ID } from '../planning/test/fixtures';
import { recordMoveUndo } from './recordMoveUndo';
import { recordTaskUndo } from './recordUndo';
import { projectUndoFor, undoScope } from './projectUndo';
const sibling = 'f2000000-0000-4000-8000-000000000099';
const prefix = `/api/v1/workspaces/${alpha.id}/tasks/${task.id}`;
const heads = (revision: number) => [task.id, sibling].map(taskId => ({ taskId, revision }));
const metadata: MoveUndoAck = { originalKey: 'forward-key', orderFingerprint: 'post-move-order', beforeHeads: heads(task.revision), afterHeads: heads(task.revision + 1) };
const moved: MoveTaskDto = { ...task, revision: task.revision + 1, moveUndo: metadata };
function setup() { const client = createQueryClient({ retry: false }); const store = projectUndoFor(client); store.activate(undoScope(anna.id, alpha.id, PROJECT_ID), true); return { client, store }; }
function restored(revision: number): MoveTaskDto { return { ...task, revision, moveUndo: { ...metadata, orderFingerprint: 'original-order', beforeHeads: heads(revision - 1), afterHeads: heads(revision) } }; }
describe('guarded server-receipt move Undo', () => {
  it('restores through the original receipt and guards every shifted row, not guessed loaded anchors', async () => {
    const { client, store } = setup();
    const { calls } = installFakeApi({ [`POST ${prefix}/restore-move`]: request => { expect(request.body).toEqual({ expectedRevision: moved.revision, expectedHeads: metadata.afterHeads, originalMoveKey: metadata.originalKey, expectedOrderFingerprint: metadata.orderFingerprint }); return ok(restored(moved.revision + 1)); } });
    recordMoveUndo(client, anna.id, alpha.id, moved, task.revision, 'forward-key', 'receipt'); await store.undo(); expect(calls).toHaveLength(1); expect(store.getSnapshot().count).toBe(0);
  });
  it('advances a move core guard only through our own confirmed ordinary edit and inverse', async () => {
    const { client, store } = setup(); const edited = { ...moved, title: 'Our edit', revision: moved.revision + 1 };
    let body: RestoreMoveTaskInput | null = null;
    installFakeApi({ [`PATCH ${prefix}`]: () => ok({ ...moved, revision: edited.revision + 1 }), [`POST ${prefix}/restore-move`]: request => {
      body = request.body as RestoreMoveTaskInput;
      return ok({ ...restored(edited.revision + 2), moveUndo: { ...metadata, orderFingerprint: 'original-order', beforeHeads: [{ taskId: task.id, revision: edited.revision + 1 }, { taskId: sibling, revision: moved.revision }], afterHeads: [{ taskId: task.id, revision: edited.revision + 2 }, { taskId: sibling, revision: moved.revision + 1 }] } });
    } });
    recordMoveUndo(client, anna.id, alpha.id, moved, task.revision, 'forward-key', 'move');
    recordTaskUndo(client, anna.id, alpha.id, 'update', moved, edited, { expectedRevision: moved.revision, title: 'Our edit' }, 'edit'); await store.undo(); await store.undo();
    expect(body).toMatchObject({ expectedRevision: edited.revision + 1, expectedHeads: [{ taskId: task.id, revision: edited.revision + 1 }, { taskId: sibling, revision: moved.revision }] }); expect(store.getSnapshot().count).toBe(0);
  });
  it('keeps a colleague conflict blocked without retiring the move or rebasing older heads', async () => {
    const { client, store } = setup(); installFakeApi({ [`POST ${prefix}/restore-move`]: () => failure(409, 'REVISION_CONFLICT', 'colleague changed sibling') });
    recordMoveUndo(client, anna.id, alpha.id, moved, task.revision, 'forward-key', 'move'); await store.undo(); expect(store.getSnapshot()).toMatchObject({ count: 1, notice: 'blocked' });
  });
  it('rejects incomplete, duplicated and wrong-source forward heads as a history boundary', async () => {
    for (const ack of [undefined, { ...metadata, originalKey: 'different-command' }, { ...metadata, afterHeads: metadata.afterHeads.slice(1) }, { ...metadata, afterHeads: [...metadata.afterHeads, ...metadata.afterHeads.slice(0, 1)] }]) {
      const { client, store } = setup(); const { calls } = installFakeApi({}); recordMoveUndo(client, anna.id, alpha.id, { ...moved, moveUndo: ack }, task.revision, 'forward-key', 'move'); await store.undo(); expect(calls).toHaveLength(0); expect(store.getSnapshot().notice).toBe('unsupported');
    }
  });
  it('retries a lost inverse acknowledgement with the exact original guarded body/key', async () => {
    const { client, store } = setup(); let attempts = 0;
    const { calls } = installFakeApi({ [`POST ${prefix}/restore-move`]: () => ++attempts === 1 ? failure(503, 'TEMPORARILY_UNAVAILABLE', 'unknown') : ok(restored(moved.revision + 1)) });
    recordMoveUndo(client, anna.id, alpha.id, moved, task.revision, 'forward-key', 'move'); await store.undo(); expect(store.getSnapshot().notice).toBe('unknown'); await store.undo();
    expect(calls).toHaveLength(2); expect(calls[1]?.body).toEqual(calls[0]?.body); expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key')); expect(store.getSnapshot().count).toBe(0);
  });
});
