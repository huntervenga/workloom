import { isWorkspaceLiveKey } from '../workspace/workspaceLiveQueries';
import { placementKeys } from './queries';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, json, ok } from '../../test/fakeApi';
import { sendMutation } from '../../lib/api';
import { fetchProjectRows, fetchTaskPlacements, placementRequest } from './api';
import { homePlacement, placement, row, targetId, task } from './testFixtures';
const root = `/api/v1/workspaces/${task.workspaceId}`;
afterEach(() => vi.unstubAllGlobals());
describe('project placement requests', () => {
  it('refreshes secondary rows and task placement lists on every workspace task change head', () => {
    const actor = 'actor-for-test';
    expect(isWorkspaceLiveKey(placementKeys.rows(actor, task.workspaceId, targetId, false), actor, task.workspaceId)).toBe(true);
    expect(isWorkspaceLiveKey(placementKeys.task(actor, task.workspaceId, task.id), actor, task.workspaceId)).toBe(true);
  });
  it('keeps opaque keyset cursors and canonical response identity intact', async () => {
    const api = installFakeApi({ [`GET ${root}/projects/${targetId}/rows`]: request => {
      expect(request.searchParams.get('cursor')).toBe('cursor/with+symbols=');
      expect(request.searchParams.get('includeArchived')).toBe('false');
      return json(200, { data: [row], meta: { requestId: 'row-page', nextCursor: 'next-page' } });
    } });
    const result = await fetchProjectRows(task.workspaceId, targetId, 'cursor/with+symbols=', false);
    expect(result.rows[0]?.canonicalTask.projectId).toBe(task.projectId);
    expect(result.nextCursor).toBe('next-page');
    expect(api.calls).toHaveLength(1);
  });
  it('sends separate canonical attach and placement update/detach revision guards', async () => {
    const api = installFakeApi({
      [`POST ${root}/tasks/${task.id}/placements`]: () => ok(placement),
      [`PATCH ${root}/task-project-placements/${placement.id}`]: () => ok(placement),
      [`POST ${root}/task-project-placements/${placement.id}/detach`]: () => ok({ ...placement, archivedAt: task.createdAt }),
    });
    await sendMutation(placementRequest(task.workspaceId, { kind: 'attach', taskId: task.id, input: { projectId: targetId, expectedTaskRevision: task.revision } }), { idempotencyKey: crypto.randomUUID() });
    await sendMutation(placementRequest(task.workspaceId, { kind: 'update', placementId: placement.id, input: { expectedRevision: 7, sectionId: null, position: 60 } }), { idempotencyKey: crypto.randomUUID() });
    await sendMutation(placementRequest(task.workspaceId, { kind: 'detach', placementId: placement.id, input: { expectedRevision: 7 } }), { idempotencyKey: crypto.randomUUID() });
    expect(api.calls.map(call => call.body)).toEqual([{ projectId: targetId, expectedTaskRevision: task.revision }, { expectedRevision: 7, sectionId: null, position: 60 }, { expectedRevision: 7 }]);
  });
  it('rejects a malformed placements answer belonging to another task', async () => {
    installFakeApi({ [`GET ${root}/tasks/${task.id}/placements`]: () => ok([{ ...homePlacement, taskId: targetId }]) });
    await expect(fetchTaskPlacements(task.workspaceId, task.id)).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
