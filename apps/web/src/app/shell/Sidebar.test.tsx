import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectDto } from '@workloom/contracts';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../../features/work-categories/test/fixtures';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, deferred, failure, installFakeApi, ok, project, type RouteTable } from '../../test/fakeApi';
import { AppRoutes } from '../AppRoutes';
import { ProtectedNavigationGuard } from '../ProtectedNavigationGuard';
import { SessionProvider } from '../session';

beforeAll(async () => { await import('../../routes/ProjectPage'); });

const OTHER_ID = 'e0000000-0000-4000-8000-000000000002';
const ARCHIVED_ID = 'e0000000-0000-4000-8000-000000000003';
const current = project(alpha.id, PROJECT_ID, 'Недельный пилот');
const other = project(alpha.id, OTHER_ID, 'Second synthetic project');
const archived: ProjectDto = { ...project(alpha.id, ARCHIVED_ID, 'Archived synthetic project'), archivedAt: '2026-10-02T09:00:00.000Z' };
const projectsPath = `${rootPath}/projects`;
const projectHref = (id: string) => `/w/${alpha.id}/projects/${id}`;

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function app(url: string, extra: RouteTable = {}) {
  const api = installFakeApi({ ...tableRoutes(), [`GET ${projectsPath}`]: () => ok([current, archived, other]), [`GET ${projectsPath}/${OTHER_ID}`]: () => ok(other), ...extra });
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { ...view, ...api, client, router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
const sidebar = () => within(screen.getByRole('complementary', { name: 'Sidebar' }));
const projectNav = async () => within(await within(await screen.findByRole('complementary', { name: 'Sidebar' })).findByRole('navigation', { name: 'Active projects' }));
const projectListCalls = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method === 'GET' && call.path === projectsPath);
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET');

describe('sidebar project list', () => {
  it('lists only active projects in server order and marks exactly the current project route', async () => {
    const ui = app(`${tablePath}?status=${current.id}&other=kept`);
    const nav = await projectNav();
    const links = await nav.findAllByRole('link');
    expect(links.map(link => link.textContent)).toEqual([current.name, other.name]);
    // The current project's own task page keeps its URL context; other projects open clean.
    expect(links.map(link => link.getAttribute('href'))).toEqual([`${projectHref(current.id)}?status=${current.id}&other=kept`, projectHref(other.id)]);
    expect(nav.queryByText(archived.name)).not.toBeInTheDocument();
    expect(nav.getByRole('link', { name: current.name })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: other.name })).not.toHaveAttribute('aria-current');
    // The workspace Projects index is not also current on a project page.
    const workspaceNav = within(sidebar().getByRole('navigation', { name: 'Workspace' }));
    expect(workspaceNav.getByRole('link', { name: 'Projects' })).not.toHaveAttribute('aria-current');

    // The project's own weekly page still belongs to that project; its link opens the task table.
    await act(async () => ui.router.navigate(`${tablePath}/week?period=x`));
    await waitFor(() => expect(nav.getByRole('link', { name: current.name })).toHaveAttribute('aria-current', 'page'));
    expect(nav.getByRole('link', { name: current.name })).toHaveAttribute('href', projectHref(current.id));
    expect(nav.getByRole('link', { name: other.name })).not.toHaveAttribute('aria-current');

    // The index page shares the same project list query: one request feeds both.
    await act(async () => ui.router.navigate(`/w/${alpha.id}/projects`));
    await screen.findByRole('heading', { level: 1, name: 'Projects' });
    expect(workspaceNav.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getAllByRole('link').filter(link => link.hasAttribute('aria-current'))).toHaveLength(0);
    expect(within(screen.getByRole('main')).getByRole('link', { name: other.name })).toBeInTheDocument();
    expect(projectListCalls(ui.calls)).toHaveLength(1);
    expect(projectListCalls(ui.calls)[0]?.searchParams.toString()).toBe('');
    expect(writes(ui.calls)).toHaveLength(0);
  });

  it('keeps the current project page context exactly when its own link is clicked again', async () => {
    const start = `?status=${task.statusId}&week=${PERIOD_A}&worker=${MEMBER_ID}&view=board`;
    const ui = app(`${tablePath}${start}#anchor`, { [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task) });
    // Found before the modal drawer hides the shell from the accessibility tree.
    const link = await (await projectNav()).findByRole('link', { name: current.name });
    await ui.user.click(await screen.findByRole('button', { name: task.title }));
    await screen.findByRole('dialog', { name: task.title });
    const before = ui.router.state.location;
    expect(before.search).toBe(`${start}&task=${task.id}`);
    const callsBefore = ui.calls.length;
    expect(link).toHaveAttribute('href', `${tablePath}${start}&task=${task.id}#anchor`);
    // A plain click is handled here: its default is prevented and nothing navigates.
    expect(fireEvent.click(link)).toBe(false);
    expect(ui.router.state.location).toBe(before);
    expect(ui.router.state.location.key).toBe(before.key);
    expect(screen.getByRole('dialog', { name: task.title })).toBeInTheDocument();
    expect(ui.calls.slice(callsBefore)).toHaveLength(0); expect(writes(ui.calls)).toHaveLength(0);
    // A modified click is left to the browser (for example, opening a new tab) and never navigates here.
    // (jsdom then reports that it cannot open the browser's new tab.)
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(ui.router.state.location.key).toBe(before.key);
  });

  it('keeps the current context from the mobile menu, closing the menu without navigating', async () => {
    const context = `?tag=${current.id}&sort=due_asc#anchor`;
    const ui = app(`${tablePath}${context}`);
    await projectNav(); const before = ui.router.state.location;
    await ui.user.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = within(await screen.findByRole('dialog', { name: 'Navigation' }));
    const link = await within(await menu.findByRole('navigation', { name: 'Active projects' })).findByRole('link', { name: current.name });
    expect(link).toHaveAttribute('href', `${tablePath}${context}`);
    await ui.user.click(link);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument());
    expect(ui.router.state.location.key).toBe(before.key); expect(writes(ui.calls)).toHaveLength(0);
  });

  it('keeps every active project reachable in one bounded scroll area with full names available', async () => {
    const many = Array.from({ length: 60 }, (_, index) => project(alpha.id, `e1000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `Synthetic project ${index + 1} with a deliberately long readable name`));
    app(`/w/${alpha.id}/my-tasks`, { [`GET ${projectsPath}`]: () => ok(many), [`GET ${rootPath}/my-tasks`]: () => ok([]) });
    const nav = await projectNav();
    const links = await nav.findAllByRole('link');
    expect(links).toHaveLength(60);
    const list = nav.getByRole('list');
    expect(list).toHaveAttribute('data-sidebar-projects');
    expect(list.className).toMatch(/max-h-/); expect(list.className).toContain('overflow-y-auto');
    const last = nav.getByRole('link', { name: many[59]?.name });
    expect(last.querySelector('[title]')).toHaveAttribute('title', many[59]?.name);
    expect(last.querySelector('[title]')?.className).toContain('truncate');
  });

  it('announces loading without hiding the workspace links, then shows the loaded list', async () => {
    const answer = deferred<Response>();
    app(`/w/${alpha.id}/my-tasks`, { [`GET ${projectsPath}`]: () => answer.promise, [`GET ${rootPath}/my-tasks`]: () => ok([]) });
    const nav = await projectNav();
    expect(nav.getByRole('status')).toHaveTextContent('Loading projects');
    expect(within(sidebar().getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: 'My tasks' })).toHaveAttribute('aria-current', 'page');
    await act(async () => answer.resolve(ok([other])));
    expect(await nav.findByRole('link', { name: other.name })).toBeInTheDocument();
    expect(nav.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a neutral error with an explicit retry and keeps the rest of navigation usable', async () => {
    let attempts = 0;
    const ui = app(`/w/${alpha.id}/my-tasks`, {
      [`GET ${projectsPath}`]: () => ++attempts === 1 ? failure(503, 'SERVICE_UNAVAILABLE', 'internal project diagnostic') : ok([other]),
      [`GET ${rootPath}/my-tasks`]: () => ok([]),
    });
    const nav = await projectNav();
    expect(await nav.findByText('Projects could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('internal project diagnostic')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(sidebar().getByRole('navigation', { name: 'Workspace' })).getAllByRole('link').map(link => link.textContent)).toEqual(['Overview', 'My tasks', 'Projects', 'Time off', 'Members']);
    expect(attempts).toBe(1);
    await ui.user.click(nav.getByRole('button', { name: 'Try again' }));
    expect(await nav.findByRole('link', { name: other.name })).toBeInTheDocument();
    expect(attempts).toBe(2); expect(writes(ui.calls)).toHaveLength(0);
  });

  it('says when the workspace has no active projects', async () => {
    app(`/w/${alpha.id}/my-tasks`, { [`GET ${projectsPath}`]: () => ok([archived]), [`GET ${rootPath}/my-tasks`]: () => ok([]) });
    const nav = await projectNav();
    expect(await nav.findByText('No active projects yet.')).toBeInTheDocument();
    expect(nav.queryByRole('link')).not.toBeInTheDocument();
  });

  it('reads no project list for a workspace the actor cannot open', async () => {
    const hidden = 'bbbbbbbb-0000-4000-8000-000000000009';
    const ui = app(`/w/${hidden}/my-tasks`, { [`GET /api/v1/workspaces/${hidden}`]: () => failure(404, 'NOT_FOUND', 'hidden workspace') });
    await waitFor(() => expect(ui.calls.some(call => call.path === `/api/v1/workspaces/${hidden}`)).toBe(true));
    const shell = within(await screen.findByRole('complementary', { name: 'Sidebar' }));
    expect(await shell.findByRole('link', { name: 'My tasks' })).toBeInTheDocument();
    expect(shell.queryByRole('navigation', { name: 'Active projects' })).not.toBeInTheDocument();
    expect(ui.calls.some(call => call.path === `/api/v1/workspaces/${hidden}/projects`)).toBe(false);
  });

  it('opens a project from the mobile menu and closes the menu', async () => {
    const ui = app(`/w/${alpha.id}/my-tasks`, { [`GET ${rootPath}/my-tasks`]: () => ok([]) });
    await projectNav();
    await ui.user.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = within(await screen.findByRole('dialog', { name: 'Navigation' }));
    const mobileProjects = within(await menu.findByRole('navigation', { name: 'Active projects' }));
    await ui.user.click(await mobileProjects.findByRole('link', { name: other.name }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument());
    expect(ui.router.state.location.pathname).toBe(projectHref(other.id));
    expect((await projectNav()).getByRole('link', { name: other.name })).toHaveAttribute('aria-current', 'page');
    expect(projectListCalls(ui.calls)).toHaveLength(1); expect(writes(ui.calls)).toHaveLength(0);
  });

  it('asks before a sidebar project link discards an unsent quick task draft and keeps it on Stay', async () => {
    const ui = app(tablePath);
    await ui.user.click(await screen.findByRole('button', { name: 'Add task without a section' }));
    await ui.user.type(screen.getByLabelText('Task name'), 'Unsent sidebar draft');
    await ui.user.click((await projectNav()).getByRole('link', { name: other.name }));
    const guard = await screen.findByRole('dialog', { name: 'Leave this page?' });
    expect(guard).toHaveTextContent('unsaved draft');
    expect(ui.router.state.location.pathname).toBe(tablePath);
    await ui.user.click(within(guard).getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Leave this page?' })).not.toBeInTheDocument());
    expect(screen.getByLabelText('Task name')).toHaveValue('Unsent sidebar draft');
    expect(ui.router.state.location.pathname).toBe(tablePath); expect(writes(ui.calls)).toHaveLength(0);
    // Leaving is explicit and still sends nothing.
    await ui.user.click((await projectNav()).getByRole('link', { name: other.name }));
    await ui.user.click(within(await screen.findByRole('dialog', { name: 'Leave this page?' })).getByRole('button', { name: 'Leave without saving' }));
    await waitFor(() => expect(ui.router.state.location.pathname).toBe(projectHref(other.id)));
    expect(writes(ui.calls)).toHaveLength(0);
  });
});
