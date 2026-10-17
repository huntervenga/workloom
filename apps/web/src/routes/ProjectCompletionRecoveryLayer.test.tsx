import type { TaskStatusDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { deferred, installFakeApi, ok, renderApp } from '../test/fakeApi';
import { rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
import { lostResponse } from '../features/planning/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const active: TaskStatusDto = { id: task.statusId, workspaceId: task.workspaceId, projectId: task.projectId, name: 'Active', group: 'todo', position: 0, revision: 1 };
const done: TaskStatusDto = { ...active, id: 'f6000000-0000-4000-8000-000000000002', name: 'Done', group: 'done', position: 1 };
const statusPath = `${rootPath}/projects/${task.projectId}/statuses`;
const patchPath = `${rootPath}/tasks/${task.id}`;

describe('page-owned completion recovery outside the task layout', () => {
  it('keeps the held command recovery outside main without replacing the focused row button or changing its write', async () => {
    const gate = deferred<Response>(); let current = task;
    const { calls } = installFakeApi({ ...tableRoutes(), [`GET ${statusPath}`]: () => ok([active, done]), [`GET ${rootPath}/tasks`]: () => ok([current]), [`PATCH ${patchPath}`]: () => gate.promise });
    const ui = renderApp(tablePath);
    const button = await screen.findByRole('button', { name: `Mark ${task.title} complete` });
    await ui.user.click(button); await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    const recovery = screen.getByText('A task command is waiting for the server response. Its original values are kept.').closest<HTMLElement>('[role="status"]');
    expect(recovery).not.toBeNull(); expect(screen.getByRole('main')).not.toContainElement(recovery);
    expect(within(recovery as HTMLElement).getByRole('button', { name: 'Resume original editor' })).toBeEnabled();
    expect(screen.getByRole('button', { name: `Saving status for ${task.title}…` })).toBe(button); expect(button).toHaveFocus();
    const writes = calls.filter(call => call.method !== 'GET'); expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({ expectedRevision: task.revision, statusId: done.id });
    await act(async () => gate.resolve(ok(current = { ...task, statusId: done.id, revision: task.revision + 1 })));
    await screen.findByRole('button', { name: `Reopen ${task.title}` });
    expect(screen.queryByText('A task command is waiting for the server response. Its original values are kept.')).not.toBeInTheDocument();
  });

  it('retains unknown recovery outside main and retries the original status bytes and key', async () => {
    const lost = lostResponse(), retry = deferred<Response>(); let attempt = 0, current = task;
    const { calls } = installFakeApi({ ...tableRoutes(), [`GET ${statusPath}`]: () => ok([active, done]), [`GET ${rootPath}/tasks`]: () => ok([current]), [`PATCH ${patchPath}`]: () => ++attempt === 1 ? lost.promise : retry.promise });
    const ui = renderApp(tablePath);
    await ui.user.click(await screen.findByRole('button', { name: `Mark ${task.title} complete` }));
    await waitFor(() => expect(attempt).toBe(1)); await act(async () => lost.lose());
    const recovery = screen.getByText('A task command is unconfirmed. Its original values and key are kept.').closest<HTMLElement>('[role="status"]');
    expect(recovery).not.toBeNull(); expect(screen.getByRole('main')).not.toContainElement(recovery);
    expect(within(recovery as HTMLElement).getByRole('button', { name: 'Resume original editor' })).toBeEnabled();
    await ui.user.click(screen.getByRole('button', { name: 'Retry original status change' })); await waitFor(() => expect(attempt).toBe(2));
    const writes = calls.filter(call => call.method !== 'GET'); expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toEqual(writes[0]?.body); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    await act(async () => retry.resolve(ok(current = { ...task, statusId: done.id, revision: task.revision + 1 })));
    await screen.findByRole('button', { name: `Reopen ${task.title}` });
  });
});
