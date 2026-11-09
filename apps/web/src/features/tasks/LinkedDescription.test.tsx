import { screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { expect, it } from 'vitest';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { home, task } from '../project-placements/testFixtures';
import { LinkedDescription } from './LinkedDescription';

it('resolves a readable task URL to its current title and leaves a denied URL as a URL', async () => {
  const deniedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const root = `/api/v1/workspaces/${alpha.id}/tasks`;
  const project = `/w/${alpha.id}/projects/${home.id}`;
  const href = (id: string) => `${window.location.origin}${project}?task=${id}`;
  installFakeApi({
    [`GET ${root}/${task.id}`]: () => ok({ ...task, workspaceId: alpha.id, title: 'Current title' }),
    [`GET ${root}/${deniedId}`]: () => new Response(null, { status: 403 }),
  });
  renderFieldUi(<MemoryRouter><Routes>
    <Route element={<Outlet context={{ actorId: anna.id, workspace: alpha }} />}>
      <Route path="/" element={<><LinkedDescription text={`See ${href(task.id)} or ${href(deniedId)}`} /><LinkedDescription text={href(task.id)} preview /></>} />
    </Route>
  </Routes></MemoryRouter>);
  const links = await screen.findAllByRole('link', { name: 'Current title' });
  expect(links).toHaveLength(2);
  expect(links[0]).toHaveAttribute('href', `${project}?task=${task.id}`);
  expect(screen.getByRole('link', { name: href(deniedId) })).toHaveAttribute('href', href(deniedId));
});
