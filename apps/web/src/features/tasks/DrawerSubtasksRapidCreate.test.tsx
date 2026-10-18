import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, failure, installFakeApi, json, ok, project, renderApp } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, rootPath, task } from '../planning/test/fixtures';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';
import { queryKeys } from '../../lib/queryKeys';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { DrawerSubtasks } from './DrawerSubtasks';
import { useTaskCommands, type TaskCommands } from './useTaskCommands';

const PARENT = 'd1000000-0000-4000-8000-000000000001';
const D_ID = 'd1000000-0000-4000-8000-0000000000d1';
const E_ID = 'd1000000-0000-4000-8000-0000000000e1';
const parent: TaskDto = { ...task, id: PARENT, title: 'Parent' };
const child = (id: string, title: string): TaskDto => ({ ...task, id, title, parentTaskId: PARENT, workPackageId: parent.workPackageId });
const statuses: TaskStatusDto[] = [{ id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Todo', group: 'todo', position: 0, revision: 1 }];

it('keeps rapid next-child text and its queued Enter through the first child acknowledgement and sibling refresh', async () => {
  const d = deferred<Response>(), e = deferred<Response>();
  const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => (request.body as { title: string }).title === 'd' ? d.promise : e.promise });
  let current: TaskCommands | undefined;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id); current = commands;
    const [children, setChildren] = useState<readonly TaskDto[]>([]);
    return <DrawerSubtasks parent={parent} scope={{ parentId: PARENT, tasks: children, partial: false, includesArchived: false, loadedAt: Date.now() }}
      projectId={PROJECT_ID} statuses={statuses} members={alphaMembers} sections={[]} tags={[]} commands={commands} writable
      onOpen={vi.fn()} onMoreDetails={vi.fn()} onCreated={next => setChildren(before => [...before, next])} />;
  }
  const ui = renderFieldUi(<Example />);
  await ui.user.click(screen.getByRole('button', { name: 'New subtask row' }));
  const input = screen.getByRole('textbox', { name: 'Task name' });
  fireEvent.change(input, { target: { value: 'd' } }); await ui.user.keyboard('{Enter}');
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.body).toEqual({ projectId: PROJECT_ID, parentTaskId: PARENT, workScope: 'detail', title: 'd', statusId: task.statusId });
  expect(input).toHaveFocus(); expect(input).toHaveValue('');
  fireEvent.change(input, { target: { value: 'e' } });
  expect(input).toHaveValue('e'); await ui.user.keyboard('{Enter}');
  expect(current?.quick.queue.map(entry => entry.input.title)).toEqual(['d', 'e']);
  expect(current?.quick.queue[1]?.sent).toBeUndefined(); expect(calls).toHaveLength(1);
  await act(async () => d.resolve(created(child(D_ID, 'd'))));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(screen.getByRole('textbox', { name: 'Task name' })).toBe(input); expect(input).toHaveFocus();
  expect(calls[1]?.body).toEqual({ projectId: PROJECT_ID, parentTaskId: PARENT, workScope: 'detail', title: 'e', statusId: task.statusId, insertion: { anchorTaskId: D_ID, placement: 'after' } });
  expect(calls[0]?.headers.get('Idempotency-Key')).toBeTruthy();
  expect(calls[1]?.headers.get('Idempotency-Key')).not.toBe(calls[0]?.headers.get('Idempotency-Key'));
  await act(async () => e.resolve(created(child(E_ID, 'e'))));
  await waitFor(() => expect(current?.quick.queue).toHaveLength(0));
  expect(screen.getByRole('button', { name: 'd' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'e' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Task name' })).toBe(input); expect(input).toHaveFocus(); expect(input).toHaveValue('');
  expect(calls).toHaveLength(2);
});


beforeAll(async () => { await import('../../routes/ProjectPage'); });

it('preserves the unsubmitted next child when its predecessor ACK refreshes the real parent pane and sibling list', async () => {
  const d = deferred<Response>();
  let currentParent = parent; let rows = [parent]; let parentReads = 0, listReads = 0;
  const home = project(alpha.id, PROJECT_ID, 'Недельный пилот');
  const placement = (row: TaskDto) => ({ id: row.id, workspaceId: row.workspaceId, taskId: row.id, projectId: row.projectId, homeProjectId: row.projectId,
    sectionId: row.sectionId, position: row.position, revision: row.revision, archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt });
  const api = installFakeApi({ ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => { listReads++; return json(200, { data: rows, meta: { requestId: 'rapid-children', nextCursor: null } }); },
    [`GET ${rootPath}/tasks/${PARENT}`]: () => { parentReads++; return ok(currentParent); },
    [`GET ${rootPath}/projects/${PROJECT_ID}/rows`]: () => json(200, { data: rows.map(row => ({ placement: placement(row), canonicalTask: row, canonicalStatus: { ...statuses[0], name: 'Запланировано' }, homeProject: home })), meta: { requestId: 'rapid-home', nextCursor: null } }),
    [`GET ${rootPath}/tasks/${PARENT}/placements`]: () => ok([placement(parent)]),
    [`POST ${rootPath}/tasks`]: request => {
      if ((request.body as { title: string }).title === 'd') return d.promise;
      const next = child(E_ID, 'e'); rows = [...rows, next]; return created(next);
    },
  });
  const ui = renderApp(`${tablePath}?task=${PARENT}`);
  const list = await screen.findByRole('region', { name: 'Subtasks' });
  await ui.user.click(within(list).getByRole('button', { name: 'New subtask row' }));
  const input = within(list).getByRole('textbox', { name: 'Task name' });
  fireEvent.change(input, { target: { value: 'd' } }); await ui.user.keyboard('{Enter}');
  const posts = () => api.calls.filter(call => call.method === 'POST' && call.path === `${rootPath}/tasks`);
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]?.body).toEqual({ projectId: PROJECT_ID, parentTaskId: PARENT, workScope: 'detail', title: 'd', statusId: task.statusId });
  expect(input).toHaveFocus(); fireEvent.change(input, { target: { value: 'e' } }); expect(input).toHaveValue('e');
  const before = { parentReads, listReads };
  currentParent = { ...parent, revision: parent.revision + 1, workPackageRevision: parent.workPackageRevision + 1 };
  rows = [currentParent, child(D_ID, 'd')];
  await act(async () => d.resolve(created(child(D_ID, 'd'))));
  await waitFor(() => expect(parentReads).toBeGreaterThan(before.parentReads));
  await waitFor(() => expect(listReads).toBeGreaterThan(before.listReads));
  await within(list).findByRole('button', { name: 'd' });
  expect(within(list).getByRole('textbox', { name: 'Task name' })).toBe(input);
  expect(input).toHaveValue('e'); expect(input).toHaveFocus(); expect(posts()).toHaveLength(1);
  await ui.user.keyboard('{Enter}');
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1]?.body).toEqual({ projectId: PROJECT_ID, parentTaskId: PARENT, workScope: 'detail', title: 'e', statusId: task.statusId, insertion: { anchorTaskId: D_ID, placement: 'after' } });
  await within(list).findByRole('button', { name: 'e' });
  expect(rows.filter(row => row.parentTaskId === PARENT).map(row => row.title)).toEqual(['d', 'e']);
  expect(rows.every(row => row.workPackageId === parent.workPackageId)).toBe(true);
  expect(posts()[0]?.headers.get('Idempotency-Key')).toBeTruthy();
  expect(posts()[1]?.headers.get('Idempotency-Key')).not.toBe(posts()[0]?.headers.get('Idempotency-Key'));
});


it.each([false, true])('queues Enter locally during a real parent renewal and waits for authorization (denied=%s)', async denied => {
  const d = deferred<Response>(), renewal = deferred<Response>();
  let rows = [parent], parentReads = 0;
  const home = project(alpha.id, PROJECT_ID, 'Недельный пилот');
  const placement = (row: TaskDto) => ({ id: row.id, workspaceId: row.workspaceId, taskId: row.id, projectId: row.projectId, homeProjectId: row.projectId,
    sectionId: row.sectionId, position: row.position, revision: row.revision, archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt });
  const api = installFakeApi({ ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => json(200, { data: rows, meta: { requestId: 'renewing-children', nextCursor: null } }),
    [`GET ${rootPath}/tasks/${PARENT}`]: () => ++parentReads === 1 ? ok(parent) : parentReads === 2 ? renewal.promise : denied ? failure(403, 'CAPABILITY_REQUIRED', 'Parent authorization revoked') : ok(parent),
    [`GET ${rootPath}/projects/${PROJECT_ID}/rows`]: () => json(200, { data: rows.map(row => ({ placement: placement(row), canonicalTask: row, canonicalStatus: { ...statuses[0], name: 'Запланировано' }, homeProject: home })), meta: { requestId: 'renewing-home', nextCursor: null } }),
    [`GET ${rootPath}/tasks/${PARENT}/placements`]: () => ok([placement(parent)]),
    [`POST ${rootPath}/tasks`]: request => {
      if ((request.body as { title: string }).title === 'd') return d.promise;
      const next = child(E_ID, 'e'); rows = [...rows, next]; return created(next);
    },
  });
  const ui = renderApp(`${tablePath}?task=${PARENT}`);
  try {
    const list = await screen.findByRole('region', { name: 'Subtasks' });
    await ui.user.click(within(list).getByRole('button', { name: 'New subtask row' }));
    const input = within(list).getByRole('textbox', { name: 'Task name' });
    fireEvent.change(input, { target: { value: 'd' } }); await ui.user.keyboard('{Enter}');
    const posts = () => api.calls.filter(call => call.method === 'POST' && call.path === `${rootPath}/tasks`);
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.change(input, { target: { value: 'e' } }); expect(input).toHaveValue('e');
    rows = [parent, child(D_ID, 'd')]; await act(async () => d.resolve(created(child(D_ID, 'd'))));
    await waitFor(() => expect(parentReads).toBeGreaterThan(1));
    expect(ui.queryClient.getQueryState(queryKeys.task(anna.id, alpha.id, PARENT))?.fetchStatus).toBe('fetching');
    expect(input).toHaveFocus(); await ui.user.keyboard('{Enter}');
    // Enter owns a local immutable submission; the parent read is still unresolved, so no POST yet.
    await waitFor(() => expect(input).toHaveValue(''));
    expect(list.querySelector('tr[data-task-draft-state="pending"]')).toHaveTextContent('e');
    expect(posts()).toHaveLength(1);
    await act(async () => renewal.resolve(denied ? failure(403, 'CAPABILITY_REQUIRED', 'Parent authorization revoked') : ok(parent)));
    if (denied) {
      await waitFor(() => expect(ui.queryClient.getQueryState(queryKeys.task(anna.id, alpha.id, PARENT))?.status).toBe('error'));
      expect(posts()).toHaveLength(1); expect(protectedDraftsFor(ui.queryClient).protecting).toBe(true);
    } else {
      await waitFor(() => expect(posts()).toHaveLength(2));
      expect(posts()[1]?.body).toEqual({ projectId: PROJECT_ID, parentTaskId: PARENT, workScope: 'detail', title: 'e', statusId: task.statusId, insertion: { anchorTaskId: D_ID, placement: 'after' } });
      await within(list).findByRole('button', { name: 'e' });
      expect(within(list).getByRole('textbox', { name: 'Task name' })).toBe(input); expect(input).toHaveFocus();
    }
  } finally { renewal.resolve(ok(parent)); d.resolve(created(child(D_ID, 'd'))); ui.unmount(); ui.queryClient.clear(); }
});


it.each(['success', 'denied', 'error', 'departed'] as const)('owns one current parent read after pane close and dispatches only on authorized success (%s)', async outcome => {
  const d = deferred<Response>(), canceledRenewal = deferred<Response>(), currentRenewal = deferred<Response>();
  let rows = [parent], parentReads = 0;
  const home = project(alpha.id, PROJECT_ID, 'Недельный пилот');
  const placement = (row: TaskDto) => ({ id: row.id, workspaceId: row.workspaceId, taskId: row.id, projectId: row.projectId, homeProjectId: row.projectId,
    sectionId: row.sectionId, position: row.position, revision: row.revision, archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt });
  const api = installFakeApi({ ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => json(200, { data: rows, meta: { requestId: 'canceled-children', nextCursor: null } }),
    [`GET ${rootPath}/tasks/${PARENT}`]: () => {
      parentReads++;
      return parentReads === 2 ? canceledRenewal.promise : parentReads === 3 ? currentRenewal.promise : ok(parent);
    },
    [`GET ${rootPath}/projects/${PROJECT_ID}/rows`]: () => json(200, { data: rows.map(row => ({ placement: placement(row), canonicalTask: row, canonicalStatus: { ...statuses[0], name: 'Запланировано' }, homeProject: home })), meta: { requestId: 'canceled-home', nextCursor: null } }),
    [`GET ${rootPath}/tasks/${PARENT}/placements`]: () => ok([placement(parent)]),
    [`POST ${rootPath}/tasks`]: request => {
      if ((request.body as { title: string }).title === 'd') return d.promise;
      const next = child(E_ID, 'e'); rows = [...rows, next]; return created(next);
    },
  });
  const ui = renderApp(`${tablePath}?task=${PARENT}`);
  try {
    const list = await screen.findByRole('region', { name: 'Subtasks' });
    await ui.user.click(within(list).getByRole('button', { name: 'New subtask row' }));
    const input = within(list).getByRole('textbox', { name: 'Task name' });
    fireEvent.change(input, { target: { value: 'd' } }); await ui.user.keyboard('{Enter}');
    const posts = () => api.calls.filter(call => call.method === 'POST' && call.path === `${rootPath}/tasks`);
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.change(input, { target: { value: 'e' } });
    rows = [parent, child(D_ID, 'd')]; await act(async () => d.resolve(created(child(D_ID, 'd'))));
    await waitFor(() => expect(parentReads).toBe(2));
    await ui.user.keyboard('{Enter}'); await waitFor(() => expect(input).toHaveValue(''));
    expect(posts()).toHaveLength(1);
    await ui.user.click(screen.getByRole('button', { name: 'Close' }));
    const key = queryKeys.task(anna.id, alpha.id, PARENT);
    // Closing removes the last detail observer and cancels its stale read. The page queue owns one new read, without reopening.
    await waitFor(() => expect(parentReads).toBe(3));
    expect(screen.queryByRole('dialog', { name: 'Parent' })).not.toBeInTheDocument();
    expect(ui.queryClient.getQueryState(key)?.status).toBe('success');
    expect(ui.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    expect(ui.queryClient.getQueryState(key)?.fetchStatus).toBe('fetching');
    expect(posts()).toHaveLength(1); expect(protectedDraftsFor(ui.queryClient).protecting).toBe(true);
    if (outcome === 'departed') ui.unmount();
    await act(async () => currentRenewal.resolve(outcome === 'denied' ? failure(403, 'CAPABILITY_REQUIRED', 'Parent authorization revoked')
      : outcome === 'error' ? failure(500, 'INTERNAL_ERROR', 'Parent renewal failed') : ok(parent)));
    if (outcome === 'success') {
      await waitFor(() => expect(posts()).toHaveLength(2));
      expect(posts()[1]?.body).toEqual({ projectId: PROJECT_ID, parentTaskId: PARENT, workScope: 'detail', title: 'e', statusId: task.statusId, insertion: { anchorTaskId: D_ID, placement: 'after' } });
      expect(posts()[1]?.headers.get('Idempotency-Key')).not.toBe(posts()[0]?.headers.get('Idempotency-Key'));
      expect(rows.filter(row => row.parentTaskId === PARENT).map(row => row.title)).toEqual(['d', 'e']);
    } else {
      await waitFor(() => expect(ui.queryClient.getQueryState(key)?.status).toBe(outcome === 'departed' ? 'success' : 'error'));
      // A scope cache notification must not start another read or bypass an error/departed owner.
      await act(async () => {
        const workspaceKey = queryKeys.workspace(anna.id, alpha.id);
        ui.queryClient.setQueryData(workspaceKey, ui.queryClient.getQueryData(workspaceKey));
        for (let step = 0; step < 20; step++) await Promise.resolve();
      });
      expect(parentReads).toBe(3); expect(posts()).toHaveLength(1);
      if (outcome !== 'departed') expect(protectedDraftsFor(ui.queryClient).protecting).toBe(true);
    }
  } finally { canceledRenewal.resolve(ok(parent)); currentRenewal.resolve(ok(parent)); d.resolve(created(child(D_ID, 'd'))); ui.unmount(); ui.queryClient.clear(); }
});
