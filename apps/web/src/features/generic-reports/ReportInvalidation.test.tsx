import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { useUpdateTaskFieldMutation } from '../fields/queries';
import { useUpdateTaskMutation } from '../tasks/queries';
import { reportKeys } from './queries';
import { plan, REPORT_ID, result, rootPath, task } from './test/fixtures';

describe('own-actor report source changes', () => {
  it.each(['rename', 'status'] as const)('invalidates full report results after confirmed %s without replacing authoritative data or another actor cache', async kind => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/fields/${plan.id}`]: () => ok({ ...plan, name: 'Revised source name', revision: 2 }), [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok({ ...task, statusId: 'f6000000-0000-4000-8000-000000000002', revision: 2 }) });
    function Writer() {
      const field = useUpdateTaskFieldMutation(anna.id, alpha.id), status = useUpdateTaskMutation(anna.id, alpha.id);
      return <button onClick={() => kind === 'rename' ? field.mutate({ fieldId: plan.id, input: { expectedRevision: plan.revision, name: 'Revised source name' } }) : status.mutate({ taskId: task.id, input: { expectedRevision: task.revision, statusId: 'f6000000-0000-4000-8000-000000000002' } })}>Change source</button>;
    }
    const ui = renderFieldUi(<Writer/>), value = result();
    const key = [...reportKeys.definition(anna.id, alpha.id, REPORT_ID), 'result', { snapshotId: null, offset: 0 }], other = [...reportKeys.definition('22222222-2222-4222-8222-222222222222', alpha.id, REPORT_ID), 'result'];
    ui.client.setQueryData(key, value); ui.client.setQueryData(other, value);
    await ui.user.click(screen.getByRole('button', { name: 'Change source' }));
    await waitFor(() => expect(ui.client.getQueryState(key)?.isInvalidated).toBe(true));
    expect(ui.client.getQueryData(key)).toBe(value); expect(ui.client.getQueryState(other)?.isInvalidated).toBe(false);
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    expect(calls[0]?.body).toEqual(kind === 'rename' ? { expectedRevision: 1, name: 'Revised source name' } : { expectedRevision: 1, statusId: 'f6000000-0000-4000-8000-000000000002' });
  });
});
