import { act, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { alpha, anna, deferred, installFakeApi, ok } from '../../test/fakeApi';
import { field, FIELD_ID, renderFieldUi, STAMP } from '../fields/test/fixtures';
import { useSetTaskFieldValueMutation } from '../fields/queries';
import { task, rootPath } from '../planning/test/fixtures';
import { useTaskCommands } from './useTaskCommands';

it('drains a committed task field after a foreign protected writer acknowledges without another edit or close', async () => {
  const gate = deferred<Response>();
  const definition = field('Foreign number', 'number');
  const { calls } = installFakeApi({
    [`PUT ${rootPath}/tasks/${task.id}/field-values/${FIELD_ID}`]: () => gate.promise,
    [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok({ ...task, title: 'Queued title', revision: task.revision + 1 }),
  });
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    const foreign = useSetTaskFieldValueMutation(anna.id, alpha.id);
    return <>
      <button onClick={() => foreign.mutate({ taskId: task.id, fieldId: FIELD_ID, input: { expectedRevision: 0, expectedDefinitionRevision: definition.revision, value: { type: 'number', value: 7 } } })}>Start foreign field write</button>
      <button onClick={() => { commands.autosave.authorize(task.id, true); commands.autosave.choose(task, { title: 'Queued title' }); }}>Commit task title</button>
    </>;
  }
  const ui = renderFieldUi(<Example />);
  await ui.user.click(screen.getByRole('button', { name: 'Start foreign field write' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  await ui.user.click(screen.getByRole('button', { name: 'Commit task title' }));
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  await act(async () => gate.resolve(ok({ workspaceId: alpha.id, projectId: task.projectId, taskId: task.id, fieldId: FIELD_ID, definitionVersionId: definition.definitionVersionId, value: { type: 'number', value: 7 }, revision: 1, updatedAt: STAMP })));
  await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
  expect(calls.filter(call => call.method === 'PATCH')[0]?.body).toEqual({ expectedRevision: task.revision, title: 'Queued title' });
  expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
});
