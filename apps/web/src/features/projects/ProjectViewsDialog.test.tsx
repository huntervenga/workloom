import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { home } from '../project-placements/testFixtures';
import { ProjectViewsDialog } from './ProjectViewsDialog';
import type { ProjectViewSettings, SetProjectViewsInput } from '@workloom/contracts';

it('keeps personal views in the browser and shares team views with their expected revision', async () => {
  const settings: ProjectViewSettings = { view: 'board', grouping: 'assignee', sort: 'due_asc', search: 'launch',
    completion: 'open', statusId: null, participantMembershipId: null, tagId: null, includeArchived: false };
  const path = `/api/v1/workspaces/${alpha.id}/projects/${home.id}/saved-views`;
  const base = { workspaceId: alpha.id, projectId: home.id };
  const { calls } = installFakeApi({
    [`GET ${path}`]: () => ok({ ...base, revision: 3, views: [] }),
    [`PUT ${path}`]: request => ok({ ...base, revision: 4, views: (request.body as SetProjectViewsInput).views }),
  });
  const onApply = vi.fn(), onClose = vi.fn();
  const render = () => renderFieldUi(<ProjectViewsDialog actorId={anna.id} workspaceId={alpha.id} projectId={home.id}
    canManage settings={settings} onApply={onApply} onClose={onClose} />);
  const first = render();
  const name = await screen.findByLabelText('View name');
  await first.user.type(name, 'Private launch');
  await first.user.click(screen.getByRole('button', { name: 'Save current view' }));
  expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  first.unmount();
  const second = render();
  await second.user.click(await screen.findByRole('button', { name: 'Private launch' }));
  expect(onApply).toHaveBeenCalledWith(settings);
  await second.user.click(await screen.findByLabelText('Share with the team'));
  await second.user.type(screen.getByLabelText('View name'), 'Team launch');
  await second.user.click(screen.getByRole('button', { name: 'Save current view' }));
  expect(await screen.findByRole('button', { name: 'Team launch' })).toBeVisible();
  expect(calls.find(call => call.method === 'PUT')?.body).toMatchObject({ expectedRevision: 3, views: [{ name: 'Team launch', settings }] });
});
