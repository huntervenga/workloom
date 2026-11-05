import { screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { home, homeStatus, task } from '../project-placements/testFixtures';
import { QuickCreateDialog } from './QuickCreateDialog';

it('creates successive tasks from My Tasks in the selected project and assigns them to the actor', async () => {
  const project = { ...home, workspaceId: alpha.id };
  const status = { ...homeStatus, workspaceId: alpha.id };
  const root = `/api/v1/workspaces/${alpha.id}`;
  const bodies: unknown[] = [];
  installFakeApi({
    [`GET ${root}/projects`]: () => ok([project]),
    [`GET ${root}/projects/${project.id}/sections`]: () => ok([]),
    [`GET ${root}/projects/${project.id}/statuses`]: () => ok([status]),
    [`GET ${root}/projects/${project.id}/task-defaults`]: () => new Response(null, { status: 404 }),
    [`GET ${root}/memberships`]: () => ok(alphaMembers),
    [`POST ${root}/tasks`]: request => {
      bodies.push(request.body);
      return ok({ ...task, workspaceId: alpha.id, title: (request.body as { title: string }).title });
    },
  });
  const ui = renderFieldUi(<MemoryRouter initialEntries={[`/w/${alpha.id}/my-tasks`]}>
    <QuickCreateDialog actorId={anna.id} workspaceId={alpha.id} onClose={() => {}} />
  </MemoryRouter>);
  const dialog = within(await screen.findByRole('dialog', { name: 'Create task' }));
  await dialog.findByRole('option', { name: project.name });
  await ui.user.selectOptions(dialog.getByLabelText('Project'), project.id);
  expect(await dialog.findByLabelText('Assign to me')).toBeChecked();
  const input = dialog.getByLabelText('Task name');
  await ui.user.type(input, 'First');
  await ui.user.click(await dialog.findByRole('button', { name: 'Create task' }));
  await dialog.findByText('Created “First”');
  expect(input).toHaveValue('');
  await ui.user.type(input, 'Second{Enter}');
  await dialog.findByText('Created “Second”');
  const responsibleMembershipId = alphaMembers.find(member => member.userId === anna.id)?.id;
  expect(bodies).toEqual(['First', 'Second'].map(title => ({ projectId: project.id, statusId: status.id, title, responsibleMembershipId })));
});
