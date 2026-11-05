import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { alpha, anna, installFakeApi, ok, project } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { FavoriteWorkButton, SidebarFavorites } from './WorkShortcuts';

it('pins an accessible project and persists the pin across remounts', async () => {
  const target = project(alpha.id, 'a0000000-0000-4000-8000-000000000004', 'Launch');
  installFakeApi({ [`GET /api/v1/workspaces/${alpha.id}/projects`]: () => ok([target]) });
  const args = { actorId: anna.id, workspaceId: alpha.id };
  const render = () => renderFieldUi(<MemoryRouter>
    <FavoriteWorkButton {...args} target={{ kind: 'project', id: target.id }} />
    <SidebarFavorites {...args} />
  </MemoryRouter>);
  const first = render();
  await first.user.click(screen.getByRole('button', { name: 'Add to favorites' }));
  expect(await screen.findByRole('link', { name: 'Launch' })).toHaveAttribute('href', `/w/${alpha.id}/projects/${target.id}`);
  first.unmount();
  const second = render();
  expect(await screen.findByRole('link', { name: 'Launch' })).toBeVisible();
  await second.user.click(screen.getByRole('button', { name: 'Remove from favorites' }));
  expect(screen.queryByRole('link', { name: 'Launch' })).not.toBeInTheDocument();
});
