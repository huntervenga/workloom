import { QueryClientProvider } from '@tanstack/react-query';
import type { ProjectDto, TagDto, TaskDto, WorkspaceDto } from '@workloom/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { task, STAMP } from '../features/planning/test/fixtures';
import { createQueryClient } from '../lib/queryClient';
import { queryKeys } from '../lib/queryKeys';
import { alpha, alphaMembers, anna, deferred, failure, installFakeApi, json, ok, project, renderApp, singleActorRoutes, type RouteTable } from '../test/fakeApi';
import { TagPage } from './TagPage';
import { TagsPage } from './TagsPage';

const root = `/api/v1/workspaces/${alpha.id}`;
const path = `/app/w/${alpha.id}/tags`;
const active: TagDto = { id: 'f7000000-0000-4000-8000-000000000001', workspaceId: alpha.id, name: 'Design', color: '#ef4444', revision: 7, archivedAt: null };
const archived: TagDto = { ...active, id: 'f7000000-0000-4000-8000-000000000002', name: 'Archive', archivedAt: STAMP };
const first = project(alpha.id, task.projectId, 'First project');
const second: ProjectDto = { ...project(alpha.id, 'e0000000-0000-4000-8000-000000000002', 'Second project'), archivedAt: STAMP };

function routes(tags = [active, archived], projects = [first, second]): RouteTable {
  const result: RouteTable = {
    ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
    [`GET ${root}/tags`]: () => ok(tags),
    [`GET ${root}/projects`]: () => ok(projects),
    [`GET ${root}/tasks`]: () => ok([]),
  };
  for (const project of projects) {
    result[`GET ${root}/projects/${project.id}/sections`] = () => ok([]);
    result[`GET ${root}/projects/${project.id}/statuses`] = () => ok([{ id: task.statusId, workspaceId: alpha.id, projectId: project.id, name: 'To do', group: 'todo', position: 0, revision: 1 }]);
  }
  return result;
}

function show(entry = path, workspace: WorkspaceDto = alpha) {
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{
    path: '/w/:workspaceId', element: <Outlet context={{ actorId: anna.id, workspace }} />, children: [
      { path: 'tags', element: <TagsPage /> }, { path: 'tags/:tagId', element: <TagPage /> },
      { path: 'projects/:projectId', element: <div>Task destination</div> },
    ],
  }], { basename: '/app', initialEntries: [entry] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { ...view, client, router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}

describe('tag catalog and settings', () => {
  it('is reachable from the workspace navigation and links active and archived tags', async () => {
    installFakeApi(routes());
    renderApp(`/w/${alpha.id}/tags`);
    const table = await screen.findByRole('table', { name: 'Tags' });
    expect(screen.getByRole('link', { name: 'Tags' })).toHaveAttribute('aria-current', 'page');
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Name', 'Color', 'Status']);
    expect(within(table).getAllByRole('link').map(link => link.getAttribute('aria-label'))).toEqual(['Open tag Design', 'Open tag Archive']);
    expect(within(table).getByRole('link', { name: 'Open tag Design' })).toHaveAttribute('href', `/w/${alpha.id}/tags/${active.id}`);
    expect(within(table).getByText('Active')).toBeInTheDocument();
    expect(within(table).getByText('Archived')).toBeInTheDocument();
  });

  it.each(['member', 'viewer'] as const)('shares filters in the URL and hides management from %s', async role => {
    const { calls } = installFakeApi(routes());
    const ui = show(`${path}?other=kept#list`, { ...alpha, role });
    const table = await screen.findByRole('table', { name: 'Tags' });
    expect(screen.queryByRole('button', { name: /Edit|New tag/ })).not.toBeInTheDocument();
    await ui.user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'archived');
    expect(within(table).queryByRole('link', { name: 'Design' })).not.toBeInTheDocument();
    expect(ui.router.state.location.search).toBe('?other=kept&status=archived');
    expect(ui.router.state.location.hash).toBe('#list');
    await act(async () => { await ui.router.navigate(-1); });
    expect(within(table).getByRole('link', { name: 'Design' })).toBeInTheDocument();
    await ui.user.type(screen.getByRole('searchbox', { name: 'Search tags' }), 'des');
    expect(ui.router.state.location.search).toBe('?other=kept&search=des');
    expect(within(table).queryByRole('link', { name: /Archive/ })).not.toBeInTheDocument();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('archives and restores directly in the status cell with revision guards', async () => {
    let current = active;
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tags`]: () => ok([current]), [`PATCH ${root}/tags/${active.id}`]: request => {
      const input = request.body as { archived: boolean };
      current = { ...current, archivedAt: input.archived ? STAMP : null, revision: current.revision + 1 };
      return ok(current);
    } });
    const ui = show();
    for (const status of ['archived', 'active']) {
      await ui.user.click(await screen.findByRole('button', { name: 'Edit status for Design' }));
      const cell = screen.getByRole('form', { name: 'Edit status for Design' });
      expect(cell.closest('td')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
      await ui.user.selectOptions(within(cell).getByRole('combobox', { name: 'Status' }), status);
      await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
      expect(await within(screen.getByRole('table')).findByText(status === 'active' ? 'Active' : 'Archived')).toBeInTheDocument();
    }
    const writes = calls.filter(call => call.method !== 'GET');
    expect(writes.map(call => call.body)).toEqual([{ expectedRevision: 7, archived: true }, { expectedRevision: 8, archived: false }]);
    expect(writes.every(call => call.path === `${root}/tags/${active.id}` && call.method === 'PATCH')).toBe(true);
  });

  it('saves names on Enter and blur, cancels Escape, and does not write unchanged values', async () => {
    let current = active;
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tags`]: () => ok([current]), [`PATCH ${root}/tags/${active.id}`]: request => {
      current = { ...current, name: (request.body as { name: string }).name, revision: current.revision + 1 }; return ok(current);
    } });
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit name for Design' }));
    const input = screen.getByRole('textbox', { name: 'Tag name' });
    expect(input).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(input.closest('td')).toBeInTheDocument();
    await ui.user.clear(input); await ui.user.type(input, 'Research{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit name for Research' })).toHaveFocus());
    await ui.user.click(screen.getByRole('button', { name: 'Edit name for Research' }));
    await ui.user.clear(screen.getByLabelText('Tag name')); await ui.user.type(screen.getByLabelText('Tag name'), 'Discard{Escape}');
    expect(screen.getByRole('button', { name: 'Edit name for Research' })).toHaveFocus();
    await ui.user.keyboard('{Enter}');
    await ui.user.keyboard('{Enter}');
    expect(screen.queryByRole('textbox', { name: 'Tag name' })).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Edit name for Research' }));
    await ui.user.clear(screen.getByLabelText('Tag name')); await ui.user.type(screen.getByLabelText('Tag name'), 'Delivery');
    await ui.user.click(screen.getByRole('searchbox', { name: 'Search tags' }));
    await screen.findByRole('button', { name: 'Edit name for Delivery' });
    expect(screen.getByRole('searchbox', { name: 'Search tags' })).toHaveFocus();
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ expectedRevision: 7, name: 'Research' }, { expectedRevision: 8, name: 'Delivery' }]);
  });

  it('saves palette, custom and automatic colors in place, using confirmed revisions before a delayed refresh', async () => {
    let current = active;
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tags`]: () => ok([active]), [`PATCH ${root}/tags/${active.id}`]: request => {
      current = { ...current, color: (request.body as { color: string | null }).color, revision: current.revision + 1 }; return ok(current);
    } });
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit color for Design' }));
    await ui.user.click(screen.getByRole('radio', { name: 'Green' }));
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Edit color for Design' })).toHaveTextContent('#22c55e');
    await ui.user.click(screen.getByRole('button', { name: 'Edit color for Design' }));
    await ui.user.clear(screen.getByLabelText('Custom color')); await ui.user.type(screen.getByLabelText('Custom color'), '#123abc{Enter}');
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    await ui.user.click(screen.getByRole('button', { name: 'Edit color for Design' }));
    await ui.user.click(screen.getByRole('button', { name: 'Automatic color' }));
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Edit color for Design' })).toHaveTextContent('Automatic color');
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([
      { expectedRevision: 7, color: '#22c55e' }, { expectedRevision: 8, color: '#123abc' }, { expectedRevision: 9, color: null },
    ]);
  });

  it('sends a pending edit only once and leaves focus where the user moved it', async () => {
    const answer = deferred<Response>();
    let current = active;
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tags`]: () => ok([current]), [`PATCH ${root}/tags/${active.id}`]: () => answer.promise });
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit name for Design' }));
    await ui.user.clear(screen.getByLabelText('Tag name'));
    await ui.user.type(screen.getByLabelText('Tag name'), 'Research');
    fireEvent.submit(screen.getByRole('form'));
    fireEvent.submit(screen.getByRole('form'));
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search tags' });
    await ui.user.click(search);
    current = { ...active, name: 'Research', revision: 8 };
    await act(async () => { answer.resolve(ok(current)); });
    await screen.findByRole('button', { name: 'Edit name for Research' });
    expect(search).toHaveFocus();
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('previews arbitrary picker colors without saving mid-drag and saves the finished selection once', async () => {
    const answer = deferred<Response>();
    let current = active;
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tags`]: () => ok([current]), [`PATCH ${root}/tags/${active.id}`]: () => answer.promise });
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit color for Design' }));
    const picker = screen.getByLabelText('Choose any color');
    expect(picker).toHaveAttribute('type', 'color');
    expect(picker).toHaveValue('#ef4444');
    await ui.user.click(picker);
    for (const value of ['#345678', '#987654', '#12ab34']) {
      fireEvent.input(picker, { target: { value } });
      expect(screen.getByLabelText('Custom color')).toHaveValue(value);
    }
    expect(screen.getByRole('dialog', { name: 'Edit color for Design' })).toBeInTheDocument();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    fireEvent.change(picker, { target: { value: '#12ab34' } });
    await waitFor(() => expect(picker).toBeDisabled());
    fireEvent.change(picker, { target: { value: '#12ab34' } });
    expect(screen.getByLabelText('Custom color')).toBeDisabled();
    current = { ...active, color: '#12ab34', revision: 8 };
    await act(async () => { answer.resolve(ok(current)); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Edit color for Design' })).toHaveTextContent('#12ab34');
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ expectedRevision: 7, color: '#12ab34' }]);
  });

  it('syncs the picker from HEX edits without replacing incomplete drafts or automatic colors', async () => {
    const { calls } = installFakeApi(routes([{ ...active, color: null }]));
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit color for Design' }));
    const picker = screen.getByLabelText<HTMLInputElement>('Choose any color');
    const automaticColor = picker.value;
    expect(automaticColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(screen.getByLabelText('Custom color')).toHaveValue('');
    await ui.user.type(screen.getByLabelText('Custom color'), '#ABCDEF');
    expect(picker).toHaveValue('#abcdef');
    await ui.user.clear(screen.getByLabelText('Custom color'));
    await ui.user.type(screen.getByLabelText('Custom color'), '#12');
    expect(picker).toHaveValue(automaticColor);
    expect(screen.getByLabelText('Custom color')).toHaveValue('#12');
    await ui.user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Edit color for Design' })).toHaveTextContent('Automatic color');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('keeps color-menu presses inside the editor and dismisses unchanged colors without writing', async () => {
    const { calls } = installFakeApi(routes());
    const ui = show();
    const trigger = await screen.findByRole('button', { name: 'Edit color for Design' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await ui.user.click(trigger);
    const menu = screen.getByRole('dialog', { name: 'Edit color for Design' });
    expect(menu).toHaveStyle({ position: 'fixed' });
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Custom color')).toHaveFocus();
    await ui.user.click(within(menu).getByText('Tag color', { selector: 'span' }));
    expect(menu).toBeInTheDocument();
    expect(screen.getByLabelText('Custom color')).toHaveFocus();
    await ui.user.click(screen.getByRole('heading', { name: 'Tags' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('saves a custom color once when clicking outside its menu and cancels with Escape', async () => {
    let current = active;
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tags`]: () => ok([current]), [`PATCH ${root}/tags/${active.id}`]: request => {
      current = { ...current, color: (request.body as { color: string }).color, revision: current.revision + 1 }; return ok(current);
    } });
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit color for Design' }));
    await ui.user.clear(screen.getByLabelText('Custom color'));
    await ui.user.type(screen.getByLabelText('Custom color'), '#123abc');
    const search = screen.getByRole('searchbox', { name: 'Search tags' });
    await ui.user.click(search);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(search).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Edit color for Design' })).toHaveTextContent('#123abc');
    await ui.user.click(screen.getByRole('button', { name: 'Edit color for Design' }));
    await ui.user.clear(screen.getByLabelText('Custom color'));
    await ui.user.type(screen.getByLabelText('Custom color'), '#abcdef{Escape}');
    expect(screen.getByRole('button', { name: 'Edit color for Design' })).toHaveFocus();
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ expectedRevision: 7, color: '#123abc' }]);
  });

  it('keeps an uncertain cell through filtering and retries the exact body/key', async () => {
    let count = 0, current = active;
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tags`]: () => ok([current]), [`PATCH ${root}/tags/${active.id}`]: () => {
      if (++count === 1) return Promise.reject(new TypeError('Failed to fetch'));
      current = { ...active, name: 'Research', revision: 8 }; return ok(current);
    } });
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit name for Design' }));
    await ui.user.clear(screen.getByLabelText('Tag name'));
    await ui.user.type(screen.getByLabelText('Tag name'), 'Research{Enter}');
    const retry = await screen.findByRole('button', { name: 'Retry save' });
    expect(screen.getByLabelText('Tag name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Edit color for Design' }));
    expect(screen.queryByLabelText('Custom color')).not.toBeInTheDocument();
    await ui.user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'archived');
    expect(screen.getByLabelText('Tag name')).toHaveValue('Research');
    expect(screen.queryByText('No matching tags')).not.toBeInTheDocument();
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    await ui.user.click(retry);
    await screen.findByText('No matching tags');
    await ui.user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'all');
    await screen.findByRole('link', { name: 'Open tag Research' });
    const writes = calls.filter(call => call.method === 'PATCH');
    expect(writes.map(call => call.body)).toEqual([{ expectedRevision: 7, name: 'Research' }, { expectedRevision: 7, name: 'Research' }]);
    expect(writes[0]?.headers.get('Idempotency-Key')).toBe(writes[1]?.headers.get('Idempotency-Key'));
  });

  it('reloads a conflict explicitly and preserves a concurrent rename when archiving', async () => {
    let current = active, count = 0;
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tags`]: () => ok([current]), [`PATCH ${root}/tags/${active.id}`]: () => {
      if (++count === 1) { current = { ...active, name: 'Latest name', color: '#22c55e', revision: 8 }; return failure(409, 'CONFLICT', 'internal details'); }
      current = { ...current, archivedAt: STAMP, revision: 9 }; return ok(current);
    } });
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit status for Design' }));
    await ui.user.selectOptions(within(screen.getByRole('form')).getByLabelText('Status'), 'archived');
    await ui.user.click(await screen.findByRole('button', { name: 'Load latest version' }));
    await screen.findByRole('button', { name: 'Edit name for Latest name' });
    expect(within(screen.getByRole('form')).getByLabelText('Status')).toHaveValue('archived');
    expect(screen.queryByText('internal details')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Apply change again' }));
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ expectedRevision: 7, archived: true }, { expectedRevision: 8, archived: true }]);
  });

  it('keeps invalid drafts and IME composition from creating writes', async () => {
    const { calls } = installFakeApi(routes([active]));
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit name for Design' }));
    await ui.user.clear(screen.getByLabelText('Tag name'));
    await ui.user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a tag name.');
    await ui.user.type(screen.getByLabelText('Tag name'), 'Draft');
    expect(fireEvent.keyDown(screen.getByLabelText('Tag name'), { key: 'Enter', code: 'Enter', isComposing: true })).toBe(false);
    fireEvent.keyDown(screen.getByLabelText('Tag name'), { key: 'Escape', code: 'Escape', isComposing: true });
    expect(screen.getByLabelText('Tag name')).toHaveValue('Draft');
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Edit color for Design' }));
    await ui.user.clear(screen.getByLabelText('Custom color')); await ui.user.type(screen.getByLabelText('Custom color'), 'wrong{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Use a color in #rrggbb format.');
    await ui.user.keyboard('{Escape}');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('does not rebase an open cell after background refresh or discard its draft when filtering', async () => {
    let current = active;
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tags`]: () => ok([current]), [`PATCH ${root}/tags/${active.id}`]: () => failure(409, 'CONFLICT', 'Changed') });
    const ui = show();
    await ui.user.click(await screen.findByRole('button', { name: 'Edit name for Design' }));
    await ui.user.clear(screen.getByLabelText('Tag name')); await ui.user.type(screen.getByLabelText('Tag name'), 'My draft');
    current = { ...active, name: 'Concurrent name', revision: 8 };
    await act(async () => { await ui.client.invalidateQueries({ queryKey: queryKeys.tags(anna.id, alpha.id) }); });
    expect(screen.getByLabelText('Tag name')).toHaveValue('My draft');
    await ui.user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Load latest version' });
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ expectedRevision: 7, name: 'My draft' }]);
  });

});

describe('tasks on a tag page', () => {
  it('shows retained archived tags across projects and opens the selected task in its project', async () => {
    const { calls } = installFakeApi({ ...routes(), [`GET ${root}/tasks`]: request => ok([{ ...task, projectId: request.searchParams.get('projectId'), id: request.searchParams.get('projectId') === first.id ? task.id : 'f2000000-0000-4000-8000-000000000002', title: request.searchParams.get('projectId') === first.id ? 'First tagged task' : 'Second tagged task', tags: [archived] }]) });
    const ui = show(`${path}/${archived.id}`);
    const table = await screen.findByRole('table', { name: 'Tagged tasks in Second project' });
    expect(within(table).getByText('Archive')).toBeInTheDocument();
    expect(within(table).getByText('To do')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Tagged tasks in First project' })).toBeInTheDocument();
    expect(screen.getByText('Tasks loaded: 2')).toBeInTheDocument();
    const reads = calls.filter(call => call.path === `${root}/tasks`);
    expect(reads).toHaveLength(2);
    expect(calls.some(call => call.path === `${root}/projects` && call.searchParams.get('includeArchived') === 'true')).toBe(true);
    expect(reads.every(call => call.searchParams.get('tagId') === archived.id)).toBe(true);
    await ui.user.click(within(table).getByRole('button', { name: 'Second tagged task' }));
    expect(ui.router.state.location.pathname).toBe(`/app/w/${alpha.id}/projects/${second.id}`);
    expect(ui.router.state.location.search).toBe('?task=f2000000-0000-4000-8000-000000000002');
  });

  it('restores shared task filters and updates them without losing unrelated URL state', async () => {
    const { calls } = installFakeApi(routes());
    const ui = show(`${path}/${active.id}?project=${second.id}&search=needle&completion=open&archived=1&other=kept#tasks`);
    await screen.findByText('No matching tasks');
    const firstRead = calls.find(call => call.path === `${root}/tasks`);
    expect(firstRead?.searchParams.get('projectId')).toBe(second.id);
    expect(firstRead?.searchParams.get('search')).toBe('needle');
    expect(firstRead?.searchParams.get('completion')).toBe('open');
    expect(firstRead?.searchParams.get('includeArchived')).toBe('true');
    await ui.user.click(screen.getByRole('checkbox', { name: 'Open tasks only' }));
    expect(ui.router.state.location.search).not.toContain('completion');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tasks' }), { target: { value: 'updated' } });
    await ui.user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some(call => call.searchParams.get('search') === 'updated')).toBe(true));
    expect(ui.router.state.location.search).toContain('other=kept');
    expect(ui.router.state.location.search).toContain('search=updated');
    expect(ui.router.state.location.hash).toBe('#tasks');
  });

  it('loads further task pages with their original project/filter binding', async () => {
    const many: TaskDto[] = Array.from({ length: 100 }, (_, index) => ({ ...task, id: `f2000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, title: `Tagged task ${index + 1}`, position: index, tags: [active] }));
    const { calls } = installFakeApi({ ...routes([active], [first]), [`GET ${root}/tasks`]: request => request.searchParams.has('cursor')
      ? ok([{ ...task, id: 'f2000000-0000-4000-8000-000000000101', title: 'Last tagged task', tags: [active] }])
      : json(200, { data: many, meta: { requestId: 'page-one', nextCursor: 'next-task-page' } }) });
    const ui = show(`${path}/${active.id}`);
    await ui.user.click(await screen.findByRole('button', { name: 'Load more tasks' }));
    await screen.findByRole('button', { name: 'Last tagged task' });
    expect(screen.getByText('Tasks loaded: 101')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more tasks' })).not.toBeInTheDocument();
    const reads = calls.filter(call => call.path === `${root}/tasks`);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.searchParams.get('cursor')).toBe('next-task-page');
    expect(reads.every(call => call.searchParams.get('projectId') === first.id && call.searchParams.get('tagId') === active.id && call.searchParams.get('limit') === '100')).toBe(true);
  });

  it('continues through empty batches of projects before reporting no matches', async () => {
    const projects: ProjectDto[] = Array.from({ length: 6 }, (_, index) => project(alpha.id, `e0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, `Project ${index + 1}`));
    const { calls } = installFakeApi({ ...routes([active], projects), [`GET ${root}/tasks`]: request => request.searchParams.get('projectId') === projects[5]?.id
      ? ok([{ ...task, projectId: projects[5].id, title: 'Found in last project', tags: [active] }]) : ok([]) });
    show(`${path}/${active.id}`);
    await screen.findByRole('button', { name: 'Found in last project' });
    expect(calls.filter(call => call.path === `${root}/tasks`)).toHaveLength(6);
    expect(screen.queryByText('No matching tasks')).not.toBeInTheDocument();
  });

  it('hides cached task results after access is denied and issues no writes', async () => {
    let denied = false;
    const { calls } = installFakeApi({ ...routes([active], [first]), [`GET ${root}/tasks`]: () => denied ? failure(403, 'FORBIDDEN', 'internal details') : ok([{ ...task, title: 'Visible task', tags: [active] }]) });
    const ui = show(`${path}/${active.id}`);
    await screen.findByRole('button', { name: 'Visible task' });
    denied = true;
    await act(async () => { await ui.client.invalidateQueries({ queryKey: queryKeys.tasks(anna.id, alpha.id) }); });
    await screen.findByRole('alert');
    expect(screen.queryByText('Visible task')).not.toBeInTheDocument();
    expect(screen.queryByText('internal details')).not.toBeInTheDocument();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it.each(['not-a-tag', 'f7000000-0000-4000-8000-000000000099'])('does not read tasks for an unavailable tag: %s', async id => {
    const { calls } = installFakeApi(routes());
    show(`${path}/${id}`);
    await screen.findByText('Tag unavailable');
    expect(calls.some(call => call.path === `${root}/tasks`)).toBe(false);
  });
});
