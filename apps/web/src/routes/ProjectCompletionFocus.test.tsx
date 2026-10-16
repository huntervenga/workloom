import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, deferred, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const DONE = 'f6000000-0000-4000-8000-000000000002';
const base: TaskStatusDto = { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored active', group: 'todo', position: 0, revision: 1 };
const done: TaskStatusDto = { ...base, id: DONE, name: 'Stored done', group: 'done', position: 1 };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'focus-fixture', nextCursor: null } });
function routes(read: () => TaskDto, patch: () => Response | Promise<Response>, extra: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => page([read()]), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(read()), [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([base, done]), [`PATCH ${rootPath}/tasks/${task.id}`]: patch, ...extra };
}

describe('completion focus across actual Board card remounts', () => {
  it.each(['{Enter}', ' '] as const)('returns keyboard focus after %s confirms a direct completion in another lane', async key => {
    const gate = deferred<Response>(); let current = task;
    const { calls } = installFakeApi(routes(() => current, () => gate.promise));
    const { user } = renderApp(`${tablePath}?view=board`);
    const source = await screen.findByRole('button', { name: `Mark ${task.title} complete` });
    source.focus(); await user.keyboard(key);
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(source).toHaveFocus();
    await act(async () => gate.resolve(ok(current = { ...task, statusId: DONE, revision: 2 })));
    const target = await screen.findByRole('button', { name: `Reopen ${task.title}` });
    expect(source.isConnected).toBe(false);
    await waitFor(() => expect(target).toHaveFocus());
  });

  it('focuses the new control after a custom done choice and after an explicit reopen menu choice', async () => {
    const otherDone = { ...done, id: 'f6000000-0000-4000-8000-000000000003', name: 'Other done', position: 2 };
    let current = task;
    const { calls } = installFakeApi(routes(() => current, () => ok(current = { ...current, statusId: current.statusId === task.statusId ? otherDone.id : task.statusId, revision: current.revision + 1 }), { [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([base, done, otherDone]) }));
    const { user } = renderApp(`${tablePath}?view=board`);
    const original = await screen.findByRole('button', { name: `Mark ${task.title} complete` });
    original.focus(); await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Complete as Other done' }));
    const reopen = await screen.findByRole('button', { name: `Reopen ${task.title}` });
    await waitFor(() => expect(reopen).toHaveFocus()); expect(original.isConnected).toBe(false);
    await user.keyboard('{Enter}'); await user.click(await screen.findByRole('menuitem', { name: 'Reopen as Stored active' }));
    const complete = await screen.findByRole('button', { name: `Mark ${task.title} complete` });
    await waitFor(() => expect(complete).toHaveFocus()); expect(reopen.isConnected).toBe(false);
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ expectedRevision: 1, statusId: otherDone.id }, { expectedRevision: 2, statusId: task.statusId }]);
  });

  it.each(['body pointer', 'outside focus', 'window blur'] as const)('does not move focus after a late acknowledgement following %s', async intent => {
    const gate = deferred<Response>(); let current = task;
    const { calls } = installFakeApi(routes(() => current, () => gate.promise));
    const { user } = renderApp(`${tablePath}?view=board`);
    const source = await screen.findByRole('button', { name: `Mark ${task.title} complete` });
    source.focus(); await user.keyboard('{Enter}');
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    if (intent === 'body pointer') await user.click(document.body);
    else if (intent === 'outside focus') screen.getByRole('searchbox').focus();
    else window.dispatchEvent(new Event('blur'));
    const outside = document.activeElement;
    await act(async () => gate.resolve(ok(current = { ...task, statusId: DONE, revision: 2 })));
    const target = await screen.findByRole('button', { name: `Reopen ${task.title}` });
    expect(target).not.toHaveFocus(); expect(document.activeElement).toBe(outside === source ? document.body : outside);
  });

  it('does not follow a late acknowledgement after the user switches to another presentation', async () => {
    const gate = deferred<Response>(); let current = task;
    installFakeApi(routes(() => current, () => gate.promise)); const { user } = renderApp(`${tablePath}?view=board`);
    const source = await screen.findByRole('button', { name: `Mark ${task.title} complete` }); source.focus(); await user.keyboard('{Enter}');
    await user.click(within(screen.getByRole('navigation', { name: 'Project views' })).getByRole('button', { name: 'Tasks' }));
    const outside = document.activeElement;
    await act(async () => gate.resolve(ok(current = { ...task, statusId: DONE, revision: 2 })));
    await screen.findByRole('button', { name: `Reopen ${task.title}` }); expect(document.activeElement).toBe(outside);
  });

  it('treats explicit lost-response retry as a new focus intent while preserving exact command bytes and key', async () => {
    const first = lostResponse(); let current = task; let count = 0;
    const { calls } = installFakeApi(routes(() => current, () => ++count === 1 ? first.promise : ok(current = { ...task, statusId: DONE, revision: 2 })));
    const { user } = renderApp(`${tablePath}?view=board`);
    const source = await screen.findByRole('button', { name: `Mark ${task.title} complete` }); source.focus(); await user.keyboard('{Enter}');
    await waitFor(() => expect(count).toBe(1)); await act(async () => first.lose());
    await user.click(await screen.findByRole('button', { name: 'Retry original status change' }));
    const target = await screen.findByRole('button', { name: `Reopen ${task.title}` }); await waitFor(() => expect(target).toHaveFocus());
    const writes = calls.filter(call => call.method === 'PATCH'); expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toEqual(writes[0]?.body); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
  });
});
