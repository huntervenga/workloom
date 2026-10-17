import type { CreateTaskInput } from '@workloom/contracts';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, created, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, rootPath, task } from '../planning/test/fixtures';
import { useCreateTaskMutation, type CreateTaskVariables } from './queries';

const POINTS_ID = '90000000-0000-4000-8000-0000000000f2';
const PERIOD_A = 'a1000000-0000-4000-8000-000000000001';
const MEMBER_A = 'b1000000-0000-4000-8000-000000000001';
const NEW_ID = 'f2000000-0000-4000-8000-0000000000e1';
const input: CreateTaskInput = { projectId: PROJECT_ID, title: 'Row', statusId: task.statusId };
const tasksPath = `POST ${rootPath}/tasks`;
const rowsPath = `POST ${rootPath}/tasks/rows`;

function Harness({ variables }: { variables: CreateTaskVariables }) {
  const create = useCreateTaskMutation(anna.id, alpha.id);
  return <>
    <button type="button" onClick={() => create.mutate(variables)}>Send</button>
    <output aria-label="created">{create.data?.id ?? ''}</output>
    <output aria-label="failed">{create.isError ? 'yes' : ''}</output>
  </>;
}

describe('useCreateTaskMutation with an atomic row', () => {
  it('keeps the legacy create body and path when no extras are staged', async () => {
    const { calls } = installFakeApi({ [tasksPath]: () => created({ ...task, id: NEW_ID }) });
    for (const variables of [{ input }, { input, initial: {} }, { input, initial: { fields: [] } }]) {
      const ui = renderFieldUi(<Harness variables={variables} />);
      await ui.user.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(screen.getByRole('status', { name: 'created' })).toHaveTextContent(NEW_ID));
      ui.unmount();
    }
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([tasksPath, tasksPath, tasksPath]);
    for (const call of calls) expect(call.body).toEqual(input);
  });

  it('sends one row create and hands on the confirmed task, refetching every touched projection', async () => {
    const { calls } = installFakeApi({ [rowsPath]: () => created({ task: { ...task, id: NEW_ID }, fields: [] }) });
    const initial = {
      fields: [{ fieldId: POINTS_ID, expectedDefinitionRevision: 1, value: { type: 'number' as const, value: 7 } }],
      plan: { periodId: PERIOD_A, membershipId: MEMBER_A, expectedRevision: null, plannedMinutes: 120 },
    };
    const ui = renderFieldUi(<Harness variables={{ input, initial } as CreateTaskVariables} />);
    const invalidate = vi.spyOn(ui.client, 'invalidateQueries');
    await ui.user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'created' })).toHaveTextContent(NEW_ID));
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([rowsPath]);
    expect(calls[0]?.body).toEqual({ task: input, ...initial });
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    const workspace = queryKeys.workspace(anna.id, alpha.id);
    for (const key of [queryKeys.fields(anna.id, alpha.id), [...workspace, 'planning'], queryKeys.timeSummaries(anna.id, alpha.id), queryKeys.tasks(anna.id, alpha.id)]) {
      expect(keys).toContain(JSON.stringify(key));
    }
  });

  it('rejects a row answer that is not a whole row envelope, sending nothing more', async () => {
    const { calls } = installFakeApi({ [rowsPath]: () => created({ task: { ...task, id: NEW_ID } }) });
    const initial = { plan: { periodId: PERIOD_A, membershipId: MEMBER_A, expectedRevision: null, plannedMinutes: 60 } };
    const ui = renderFieldUi(<Harness variables={{ input, initial }} />);
    await ui.user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'failed' })).toHaveTextContent('yes'));
    expect(screen.getByRole('status', { name: 'created' })).toHaveTextContent('');
    expect(calls).toHaveLength(1);
  });
});
