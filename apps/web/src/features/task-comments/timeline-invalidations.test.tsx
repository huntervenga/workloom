import { act, screen, waitFor } from '@testing-library/react';
import type { TaskFieldValueDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { alpha, anna, created, deferred, installFakeApi, json, ok } from '../../test/fakeApi';
import { useSetTaskFieldValueMutation } from '../fields/queries';
import { field, renderFieldUi } from '../fields/test/fixtures';
import { usePlanningCommands } from '../planning/queries';
import { log, MEMBER_ID, PERIOD_A, PROJECT_ID, rootPath, STAMP, task } from '../planning/test/fixtures';
import { useDependencyCommands } from '../dependencies/queries';
import { useUpdateTaskMutation } from '../tasks/queries';
import { discussionKeys, useTimelineQuery } from './queries';

const foreignActor = 'b0000000-0000-4000-8000-000000000099';
const sibling = 'f2000000-0000-4000-8000-000000000099';
function seed(client: ReturnType<typeof renderFieldUi>['client']) {
  const own = discussionKeys.timeline(anna.id, alpha.id, task.id);
  const other = discussionKeys.timeline(foreignActor, alpha.id, task.id);
  const unrelated = discussionKeys.timeline(anna.id, alpha.id, sibling);
  for (const key of [own, other, unrelated]) client.setQueryData(key, { pages: [], pageParams: [] });
  return { own, other, unrelated };
}

describe('confirmed non-task-row writes refresh the task timeline immediately', () => {
  it('invalidates the changed custom-value task only, without a task revision or another actor cache change', async () => {
    const definition = field();
    const value: TaskFieldValueDto = { workspaceId: alpha.id, projectId: PROJECT_ID, taskId: task.id, fieldId: definition.id, definitionVersionId: definition.definitionVersionId, revision: 1, value: { type: 'text', value: 'new value' }, updatedAt: STAMP };
    const path = `${rootPath}/tasks/${task.id}/field-values/${definition.id}`;
    const { calls } = installFakeApi({ [`PUT ${path}`]: () => ok(value) });
    function Example() {
      const command = useSetTaskFieldValueMutation(anna.id, alpha.id);
      return <button onClick={() => command.mutate({ taskId: task.id, fieldId: definition.id, input: { expectedRevision: 0, expectedDefinitionRevision: definition.revision, value: value.value } })}>Save fixture field</button>;
    }
    const ui = renderFieldUi(<Example />), keys = seed(ui.client);
    await ui.user.click(screen.getByRole('button', { name: 'Save fixture field' }));
    await waitFor(() => expect(ui.client.getQueryState(keys.own)?.isInvalidated).toBe(true));
    expect(ui.client.getQueryState(keys.other)?.isInvalidated).toBe(false);
    expect(ui.client.getQueryState(keys.unrelated)?.isInvalidated).toBe(false);
    expect(calls).toHaveLength(1); expect(calls[0]?.method).toBe('PUT'); expect(calls[0]?.path).toBe(path);
  });

  it('invalidates the manual-work owner task timeline after its command ACK without invalidating another task or actor', async () => {
    const path = `${rootPath}/tasks/${task.id}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`;
    const { calls } = installFakeApi({ [`PUT ${path}`]: () => ok(log(0)) });
    function Example() {
      const commands = usePlanningCommands(anna.id, alpha.id, PROJECT_ID);
      return <button onClick={() => commands.setFact.mutate({ taskId: task.id, periodId: PERIOD_A, membershipId: MEMBER_ID, input: { expectedRevision: null, minutes: 0, state: 'active', reason: null } })}>Save fixture time</button>;
    }
    const ui = renderFieldUi(<Example />), keys = seed(ui.client);
    await ui.user.click(screen.getByRole('button', { name: 'Save fixture time' }));
    await waitFor(() => expect(ui.client.getQueryState(keys.own)?.isInvalidated).toBe(true));
    expect(ui.client.getQueryState(keys.other)?.isInvalidated).toBe(false);
    expect(ui.client.getQueryState(keys.unrelated)?.isInvalidated).toBe(false);
    expect(calls).toHaveLength(1); expect(calls[0]?.method).toBe('PUT'); expect(calls[0]?.body).toEqual({ expectedRevision: null, minutes: 0, state: 'active', reason: null });
  });

  it.each(['estimate', 'dependency'] as const)('restarts a held initial feed after the actual %s command ACK without relying on a task revision bump', async kind => {
    const held = deferred<Response>(); let gets = 0;
    const freshId = 'f9900000-0000-4000-8000-000000000012';
    const path = `${rootPath}/tasks/${task.id}/timeline`;
    const row = { type: 'activity', id: freshId, workspaceId: alpha.id, taskId: task.id, changeSeq: '2', eventOrdinal: 1, occurredAt: STAMP, kind: 'updated', actorUserId: anna.id, actorMembershipId: MEMBER_ID, actorDisplayName: anna.displayName, actorAvatarUrl: null, detail: 'uncaptured', changes: [] };
    const edge = { id: 'f9900000-0000-4000-8000-000000000013', workspaceId: alpha.id, predecessorTaskId: task.id, successorTaskId: sibling, type: 'finish_to_start', state: 'active', revision: 1, createdAt: STAMP, updatedAt: STAMP };
    const { calls } = installFakeApi({
      [`GET ${path}`]: () => ++gets === 1 ? held.promise : json(200, { data: [row], meta: { requestId: 'fresh', nextCursor: null } }),
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok({ ...task, estimateMinutes: 1230, workPackageRevision: task.workPackageRevision + 1 }),
      [`POST ${rootPath}/dependencies`]: () => created(edge),
    });
    function Example() {
      const history = useTimelineQuery(anna.id, alpha.id, task.id);
      const estimate = useUpdateTaskMutation(anna.id, alpha.id);
      const dependency = useDependencyCommands(anna.id, alpha.id, PROJECT_ID);
      return <><button onClick={() => kind === 'estimate'
        ? estimate.mutate({ taskId: task.id, input: { expectedRevision: task.revision, expectedWorkPackageRevision: task.workPackageRevision, estimateMinutes: 1230 } })
        : dependency.create.mutate({ draftId: 'fixture-edge', anchorTaskId: task.id, input: { predecessorTaskId: task.id, successorTaskId: sibling, type: 'finish_to_start', expectedAbsent: true } })}>Confirm fixture change</button>
        <span>{(kind === 'estimate' ? estimate.isSuccess : dependency.create.isSuccess) ? 'Acknowledged' : ''}</span>
        <output>{history.data?.pages.flatMap(page => page.rows).map(item => item.id).join(',')}</output></>;
    }
    const ui = renderFieldUi(<Example />);
    const otherKey = discussionKeys.timeline(foreignActor, alpha.id, task.id);
    ui.client.setQueryData(otherKey, { pages: [], pageParams: [] });
    await waitFor(() => expect(gets).toBe(1));
    await ui.user.click(screen.getByRole('button', { name: 'Confirm fixture change' }));
    await screen.findByText('Acknowledged');
    await act(async () => held.resolve(json(200, { data: [], meta: { requestId: 'stale', nextCursor: null } })));
    await screen.findByText(freshId);
    expect(gets).toBe(2); expect(ui.client.getQueryState(otherKey)?.isInvalidated).toBe(false);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });
});
