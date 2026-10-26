import type { ProjectDto } from '@workloom/contracts';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ProjectListTable } from './ProjectListTable';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const path = `/app/w/${workspaceId}/projects`;
const first: ProjectDto = {
  id: 'e0000000-0000-4000-8000-000000000001', workspaceId, name: 'Alpha', revision: 1, archivedAt: null,
  createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-03-01T09:00:00.000Z',
  dateRange: { from: '2026-04-01', to: '2026-04-30' },
};
const projects: ProjectDto[] = [
  first,
  { ...first, id: 'e0000000-0000-4000-8000-000000000002', name: 'Beta',
    createdAt: '2026-03-01T09:00:00.000Z', updatedAt: '2026-04-01T09:00:00.000Z',
    dateRange: { from: '2026-02-01', to: '2026-03-30' }, archivedAt: '2026-04-02T09:00:00.000Z' },
  { ...first, id: 'e0000000-0000-4000-8000-000000000003', name: 'Gamma',
    createdAt: '2026-02-01T09:00:00.000Z', updatedAt: '2026-05-01T09:00:00.000Z', dateRange: null },
];

function show(initialEntry: string) {
  const router = createMemoryRouter([{ path: '*', element: <ProjectListTable projects={projects}
    actorId="11111111-1111-4111-8111-111111111111" workspaceId={workspaceId} timeZone="UTC"
    canEdit={false} onRenamed={() => undefined} /> }], { basename: '/app', initialEntries: [initialEntry] });
  const view = render(<RouterProvider router={router} />);
  const table = screen.getByRole('table', { name: 'Projects' });
  return {
    ...view, router, table, user: userEvent.setup(),
    names: () => within(table).getAllByRole('link').map(link => link.textContent),
  };
}

describe('shareable project sorting', () => {
  it('writes sorting to the URL and restores it through history and a freshly opened shared link', async () => {
    const ui = show(`${path}?other=kept#projects`);
    const created = within(ui.table).getByRole('button', { name: 'Created' });
    await ui.user.click(created);
    expect(ui.names()).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(ui.router.state.location.search).toBe('?other=kept&sort=createdAt&direction=desc');
    expect(ui.router.state.location.pathname).toBe(path);
    expect(ui.router.state.location.hash).toBe('#projects');
    await ui.user.click(created);
    expect(ui.names()).toEqual(['Alpha', 'Gamma', 'Beta']);
    expect(ui.router.state.location.search).toBe('?other=kept&sort=createdAt&direction=asc');

    await act(async () => { await ui.router.navigate(-1); });
    expect(ui.names()).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(within(ui.table).getByRole('columnheader', { name: 'Created' })).toHaveAttribute('aria-sort', 'descending');
    await act(async () => { await ui.router.navigate(-1); });
    expect(ui.names()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(ui.router.state.location.search).toBe('?other=kept');
    await act(async () => { await ui.router.navigate(1); });
    expect(ui.names()).toEqual(['Beta', 'Gamma', 'Alpha']);

    const location = ui.router.state.location;
    const sharedLink = `${location.pathname}${location.search}${location.hash}`;
    ui.unmount();
    ui.router.dispose();
    const recipient = show(sharedLink);
    expect(recipient.names()).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(within(recipient.table).getByRole('columnheader', { name: 'Created' })).toHaveAttribute('aria-sort', 'descending');
    expect(recipient.router.state.location.hash).toBe('#projects');
  });

  it.each([
    ['name', 'Name', ['Gamma', 'Beta', 'Alpha']],
    ['createdAt', 'Created', ['Beta', 'Gamma', 'Alpha']],
    ['updatedAt', 'Updated', ['Gamma', 'Beta', 'Alpha']],
    ['startDate', 'Start date', ['Alpha', 'Beta', 'Gamma']],
    ['endDate', 'End date', ['Alpha', 'Beta', 'Gamma']],
    ['status', 'Status', ['Beta', 'Alpha', 'Gamma']],
  ] as const)('opens a shared %s sort immediately', (field, label, names) => {
    const ui = show(`${path}?sort=${field}&direction=desc`);
    expect(ui.names()).toEqual(names);
    expect(within(ui.table).getByRole('columnheader', { name: label })).toHaveAttribute('aria-sort', 'descending');
  });

  it.each(['', '?sort=unknown&direction=desc', '?sort=name&direction=invalid'])('uses the default for an old or unsupported link without rewriting it (%s)', search => {
    const ui = show(`${path}${search}`);
    expect(ui.names()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(within(ui.table).getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
    expect(ui.router.state.location.search).toBe(search);
  });
});
