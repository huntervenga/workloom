import { screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { alpha, anna, created, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { homeStatus, task as fixture } from '../project-placements/testFixtures';
import { TaskStructureActions } from './TaskStructureActions';
import { useTaskCommands } from './useTaskCommands';

const task = { ...fixture, workspaceId: alpha.id };
const root = `/api/v1/workspaces/${alpha.id}`;
const otherId = 'a0000000-0000-4000-8000-000000000001';

function renderActions(open = vi.fn()) {
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    return <TaskStructureActions task={task} actorId={anna.id} commands={commands} statuses={[homeStatus]} disabled={false} onOpenTask={open} />;
  }
  return { ...renderFieldUi(<Example />), open };
}

it('uses the checked task revision when making it a subtask', async () => {
  const parent = { ...task, id: otherId, title: 'New parent' };
  const { calls } = installFakeApi({
    [`GET ${root}/tasks`]: () => ok([parent]),
    [`PATCH ${root}/tasks/${task.id}`]: () => ok({ ...task, parentTaskId: parent.id, revision: task.revision + 1 }),
  });
  const { user } = renderActions();
  await user.click(screen.getByRole('button', { name: 'Change task hierarchy' }));
  await user.type(screen.getByLabelText('Find parent task'), 'parent');
  await user.click(await screen.findByRole('button', { name: 'New parent' }));
  await user.click(screen.getByRole('button', { name: 'Make subtask' }));
  expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: task.revision, parentTaskId: parent.id });
});

it('creates a standalone follow-up with a link back to the source task', async () => {
  const { calls } = installFakeApi({ [`POST ${root}/tasks`]: () => created({ ...task, id: otherId, title: 'Investigate' }) });
  const { user, open } = renderActions();
  await user.click(screen.getByRole('button', { name: 'Create follow-up' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Create follow-up' }));
  await user.type(dialog.getByLabelText('Task name'), 'Investigate');
  await user.click(dialog.getByRole('button', { name: 'Create follow-up' }));
  expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({
    title: 'Investigate', projectId: task.projectId, sectionId: task.sectionId,
    description: expect.stringContaining(`?task=${task.id}`),
  });
  expect(open).toHaveBeenCalledWith(otherId);
});
