import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { MyTaskDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, failure, installFakeApi, json, renderApp, singleActorRoutes } from '../../test/fakeApi';
import { uniqueLoadedMyTasks } from './api';

const id = (n: number) => `ee000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function item(n: number, title = `Task ${n}`): MyTaskDto {
  const projectId = id(n + 100), statusId = id(n + 200);
  return { task: { id: id(n), workspaceId: alpha.id, projectId, sectionId: null, parentTaskId: null, workPackageId: id(n + 300), workPackageRevision: 1, title, description: '', statusId, responsibleMembershipId: alphaMembers[0]?.id ?? null, participants: [], participantsRevision: 1, dueDate: n === 3 ? null : '2026-10-16', priority: 'none', tags: [], estimateMinutes: null, revision: 1, position: 0, visibility: 'workspace', archivedAt: null, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' }, project: { id: projectId, name: `Project ${n}`, archivedAt: null }, status: { id: statusId, name: 'В работе', group: 'in_progress' } };
}
const path = `/api/v1/workspaces/${alpha.id}/my-tasks`;
const page = (items: MyTaskDto[], nextCursor: string | null = null) => json(200, { data: items, meta: { requestId: 'inbox-test', nextCursor } });

describe('personal task inbox', () => {
  it('loads cross-project rows directly and opens the existing project/task route without translating persisted content', async () => {
    const first = item(1, 'Задача клиента');
    first.task.attachmentCount = 2;
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: () => page([first, item(2)]) });
    renderApp(`/w/${alpha.id}/my-tasks`);
    expect(await screen.findByRole('heading', { name: 'My tasks' })).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'Open task “Задача клиента”' });
    expect(screen.getByRole('img', { name: '2 attachments' })).toBeVisible();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(link).toHaveAttribute('href', `/w/${alpha.id}/projects/${first.task.projectId}?task=${first.task.id}`);
    expect(screen.getAllByText('В работе')).toHaveLength(2);
    expect(screen.getByText('Project 1')).toBeInTheDocument();
    expect(screen.getByText('Project 2')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 tasks loaded');
    const request = calls.find(call => call.path === path);
    expect(request?.searchParams.get('relation')).toBe('all');
    expect(request?.searchParams.has('membershipId')).toBe(false);
    expect(request?.searchParams.has('projectId')).toBe(false);
    // Project names come from the rows: no per-project read. Only the sidebar's one shared
    // workspace project list may load, and it never feeds these rows.
    expect(calls.some(call => /\/projects\/[^/]+/.test(call.path))).toBe(false);
    expect(calls.filter(call => /\/projects$/.test(call.path)).length).toBeLessThanOrEqual(1);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('sends relation/completion/archive filters and applies a bounded server-side search only on submit', async () => {
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: () => page([]) });
    const { user } = renderApp(`/w/${alpha.id}/my-tasks`);
    await screen.findByRole('heading', { name: 'You have no open tasks' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'My involvement' }), 'assigned');
    await screen.findByRole('heading', { name: 'No tasks match these filters' });
    await waitFor(() => expect(calls.filter(call => call.path === path).at(-1)?.searchParams.get('relation')).toBe('assigned'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'closed');
    await user.click(screen.getByRole('checkbox', { name: 'Include archived' }));
    const input = screen.getByRole('textbox', { name: 'Search my tasks' });
    const beforeTyping = calls.filter(call => call.path === path).length;
    await user.type(input, '  %_search  ');
    expect(calls.filter(call => call.path === path)).toHaveLength(beforeTyping);
    await user.click(screen.getByRole('button', { name: 'Apply search' }));
    await waitFor(() => expect(calls.filter(call => call.path === path).at(-1)?.searchParams.get('search')).toBe('%_search'));
    const request = calls.filter(call => call.path === path).at(-1);
    expect(request?.searchParams.get('completion')).toBe('closed');
    expect(request?.searchParams.get('includeArchived')).toBe('true');
    expect(input).toHaveAttribute('maxlength', '200');
  });

  it('deduplicates overlapping live pages and never presents loaded rows as an authoritative total', async () => {
    const changed = { ...item(2, 'Updated task'), task: { ...item(2).task, title: 'Updated task', revision: 2 } };
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: request => request.searchParams.has('cursor') ? page([changed, item(3)]) : page([item(1), item(2)], 'next-live-page') });
    const { user } = renderApp(`/w/${alpha.id}/my-tasks`);
    await user.click(await screen.findByRole('button', { name: 'Load more tasks' }));
    expect(await screen.findByRole('link', { name: 'Open task “Updated task”' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('3 tasks loaded');
    // Three task rows; undated open work sits under one date-group heading.
    expect(screen.getByRole('list', { name: 'My tasks across projects' }).querySelectorAll('li:not([role="presentation"])')).toHaveLength(3);
    expect(screen.getAllByText('No due date').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Load more tasks' })).not.toBeInTheDocument();
    expect(calls.filter(call => call.path === path).at(-1)?.searchParams.get('cursor')).toBe('next-live-page');
    expect(uniqueLoadedMyTasks([{ items: [item(2)], nextCursor: 'next' }, { items: [changed], nextCursor: null }])[0]?.task.revision).toBe(2);
  });

  it('hides previously loaded rows after denial and never exposes a server error message', async () => {
    let denied = false;
    installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: () => denied ? failure(404, 'NOT_FOUND', 'secret database diagnostic') : page([item(1, 'Previously visible')]) });
    const { user } = renderApp(`/w/${alpha.id}/my-tasks`);
    expect(await screen.findByRole('link', { name: 'Open task “Previously visible”' })).toBeInTheDocument();
    denied = true;
    const refresh = screen.getAllByRole('button', { name: 'Refresh' }).at(-1) as HTMLElement;
    await user.click(refresh);
    expect(await screen.findByRole('heading', { name: 'Unable to load tasks' })).toBeInTheDocument();
    expect(screen.queryByText('Previously visible')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('secret database diagnostic');
    expect(screen.getByRole('status')).toHaveTextContent('Tasks could not be loaded.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search my tasks' }), { target: { value: 'kept draft' } });
    expect(screen.getByRole('textbox', { name: 'Search my tasks' })).toHaveValue('kept draft');
  });
});
