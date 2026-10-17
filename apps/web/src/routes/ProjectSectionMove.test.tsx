import type { SectionDto, TaskDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, deferred, failure, installFakeApi, json, ok, project, renderApp, type RouteTable } from '../test/fakeApi';
import { STAMP, lostResponse } from '../features/planning/test/fixtures';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const A = 'e1000000-0000-4000-8000-0000000000a1';
const B = 'e1000000-0000-4000-8000-0000000000b2';
const OLD = 'e1000000-0000-4000-8000-0000000000c3';
const section = (id: string, name: string, position: number, archivedAt: string | null = null): SectionDto => ({ id, workspaceId: alpha.id, projectId: PROJECT_ID, name, position, revision: 1, archivedAt });
const sections = [section(B, 'Second section', 1), section(A, 'First section', 0), section(OLD, 'Old archived section', 2, STAMP)];
const root: TaskDto = { ...task, title: 'Movable root', sectionId: A };
const child: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000031', title: 'Child stays with parent', parentTaskId: root.id, sectionId: A, position: 1 };
const peer: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000032', title: 'Peer in second', sectionId: B, position: 2, workPackageId: 'f1000000-0000-4000-8000-000000000032' };
const meeting: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000033', title: 'Meeting root', sectionId: A, position: 3, meetingId: 'ab000000-0000-4000-8000-000000000001', workPackageId: 'f1000000-0000-4000-8000-000000000033' };
const archivedRoot: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000034', title: 'Archived root', sectionId: A, position: 4, archivedAt: STAMP, workPackageId: 'f1000000-0000-4000-8000-000000000034' };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'section-move', nextCursor: null } });
type Calls = ReturnType<typeof installFakeApi>['calls'];
const patches = (calls: Calls) => calls.filter(call => call.method === 'PATCH');
const writes = (calls: Calls) => calls.filter(call => call.method !== 'GET');
const actionsButton = (title: string) => screen.queryByRole('button', { name: `Task actions: ${title}` });
const groupOf = (title: string) => screen.getByRole('button', { name: title }).closest('tbody');
const groupBody = (name: string) => screen.getByRole('button', { name: `Collapse section “${name}”` }).closest('tbody');

/** A server whose list follows confirmed writes; `patch` decides each PATCH answer. */
function server(patch?: (body: { expectedRevision: number; sectionId?: string | null }, attempt: number) => Response | Promise<Response>, extra: RouteTable = {}) {
  let current = root; let attempts = 0;
  const routes: RouteTable = {
    ...tableRoutes(),
    [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok(sections),
    [`GET ${rootPath}/tasks`]: request => page(request.searchParams.get('includeArchived') === 'true' ? [current, child, peer, meeting, archivedRoot] : [current, child, peer, meeting]),
    [`GET ${rootPath}/tasks/${root.id}`]: () => ok(current),
    [`PATCH ${rootPath}/tasks/${root.id}`]: request => {
      const body = request.body as { expectedRevision: number; sectionId?: string | null };
      attempts += 1;
      if (patch) return patch(body, attempts);
      current = { ...current, sectionId: body.sectionId ?? null, revision: current.revision + 1 };
      return ok(current);
    },
    ...extra,
  };
  return { routes, confirm: (next: Partial<TaskDto>) => { current = { ...current, ...next, revision: current.revision + 1 }; return ok(current); } };
}

async function moveAction(user: ReturnType<typeof renderApp>['user'], title: string) {
  await user.click(await screen.findByRole('button', { name: `Task actions: ${title}` }));
  return within(await screen.findByRole('menu')).queryByRole('menuitem', { name: 'Move to section…' });
}

async function requestMove(user: ReturnType<typeof renderApp>['user'], title = root.title) {
  const action = await moveAction(user, title);
  if (!action) throw new Error('Missing move action');
  await user.click(action);
}

async function openMove(user: ReturnType<typeof renderApp>['user'], title = root.title) {
  await screen.findByRole('button', { name: title });
  await requestMove(user, title);
  return within(await screen.findByRole('listbox', { name: 'Section' }));
}

describe('root task section move', () => {
  it('offers only active sections and No section, sends exactly sectionId with the seen revision, and keeps the child with its parent', async () => {
    const fixture = server();
    const { calls } = installFakeApi(fixture.routes);
    const { user } = renderApp(tablePath);
    const row = (await screen.findByRole('button', { name: root.title })).closest('tr');
    const menu = await openMove(user);
    expect(menu.getAllByRole('option').map(option => option.textContent)).toEqual(['No section', 'First section', 'Second section']);
    expect(menu.getByRole('option', { name: 'First section' })).toHaveAttribute('aria-selected', 'true');
    expect(menu.queryByRole('option', { name: /Old archived section/ })).not.toBeInTheDocument();
    // The picker sits in the row-action overlay: the title and the fixed row stay in place.
    const overlay = row?.querySelector('[data-task-section-editor]');
    expect(overlay).toHaveClass('absolute', 'h-8', 'w-52'); expect(row).toHaveClass('h-10');
    expect(within(row as HTMLElement).getByRole('button', { name: root.title })).toBeInTheDocument();
    await user.click(menu.getByRole('option', { name: 'Second section' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.body).toEqual({ expectedRevision: root.revision, sectionId: B });
    await waitFor(() => expect(groupOf(root.title)).toBe(groupBody('Second section')));
    // The child keeps its own section but is shown under its moved parent, marked with that section.
    expect(groupOf(child.title)).toBe(groupBody('Second section'));
    expect(within(screen.getByRole('button', { name: child.title }).closest('tr') as HTMLElement).getByText('Section: First section')).toBeInTheDocument();
    expect(await screen.findByText('Moved “Movable root” to Second section.')).toBeInTheDocument();
    await waitFor(() => expect(actionsButton(root.title)).toHaveFocus());
    expect(writes(calls)).toHaveLength(1);
  });

  it('moves a root to No section and reopens a collapsed destination group to show it', async () => {
    const { calls } = installFakeApi(server().routes);
    const { user } = renderApp(tablePath);
    await screen.findByRole('button', { name: root.title });
    const noSection = screen.queryByRole('button', { name: 'Collapse section “No section”' });
    const menu = await openMove(user);
    await user.click(menu.getByRole('option', { name: 'No section' }));
    await waitFor(() => expect(patches(calls)[0]?.body).toEqual({ expectedRevision: root.revision, sectionId: null }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse section “No section”' })).toBeInTheDocument());
    expect(noSection).toBeNull();
    expect(groupOf(root.title)).toBe(groupBody('No section'));
  });

  it.each(['same', 'escape'] as const)('sends nothing when the current section is chosen again or the menu is dismissed (%s)', async how => {
    const { calls } = installFakeApi(server().routes);
    const { user } = renderApp(tablePath);
    const menu = await openMove(user);
    if (how === 'same') await user.click(menu.getByRole('option', { name: 'First section' }));
    else await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Section' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Section' })).not.toBeInTheDocument());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(writes(calls)).toHaveLength(0);
    expect(groupOf(root.title)).toBe(groupBody('First section'));
  });

  it('offers the move only on ordinary, unarchived root tasks', async () => {
    installFakeApi(server().routes);
    const { user } = renderApp(`${tablePath}?includeArchived=true`);
    await screen.findByRole('button', { name: root.title });
    expect(await moveAction(user, root.title)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(await moveAction(user, peer.title)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(await moveAction(user, child.title)).toBeNull();
    await user.keyboard('{Escape}');
    expect(await moveAction(user, meeting.title)).toBeNull();
    await user.keyboard('{Escape}');
    await screen.findByRole('button', { name: archivedRoot.title });
    expect(await moveAction(user, archivedRoot.title)).toBeNull();
  });

  it.each(['viewer', 'archived project'] as const)('offers no move for a %s', async context => {
    const extra: RouteTable = context === 'viewer'
      ? { [`GET /api/v1/workspaces/${alpha.id}`]: () => ok({ ...alpha, role: 'viewer' }), 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]) }
      : { [`GET ${rootPath}/projects/${PROJECT_ID}`]: () => ok({ ...project(alpha.id, PROJECT_ID, 'Archived project'), archivedAt: STAMP }) };
    const { calls } = installFakeApi(server(undefined, extra).routes);
    const { user } = renderApp(tablePath);
    await screen.findByRole('button', { name: root.title });
    expect(await moveAction(user, root.title)).toBeNull();
    await user.keyboard('{Escape}');
    expect(await moveAction(user, peer.title)).toBeNull();
    expect(writes(calls)).toHaveLength(0);
  });

  it('keeps an unknown move outcome on its own row and retries the exact same request', async () => {
    const lost = lostResponse();
    // The handler runs only after `fixture` exists.
    const fixture: ReturnType<typeof server> = server((body, attempt) => attempt === 1 ? lost.promise : fixture.confirm({ sectionId: body.sectionId ?? null }));
    const { calls } = installFakeApi(fixture.routes);
    const { user } = renderApp(tablePath);
    const menu = await openMove(user);
    await user.click(menu.getByRole('option', { name: 'Second section' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    await act(async () => lost.lose());
    const retry = await screen.findByRole('button', { name: 'Retry' });
    // While the outcome is unknown no other cell opens and nothing else is sent.
    await user.click(screen.getByRole('button', { name: `Edit status for ${peer.title}` }));
    expect(screen.queryByRole('listbox', { name: 'Status' })).not.toBeInTheDocument();
    expect(groupOf(root.title)).toBe(groupBody('First section'));
    await user.click(retry);
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    const [first, second] = patches(calls);
    expect(second?.body).toEqual(first?.body); expect(second?.body).toEqual({ expectedRevision: root.revision, sectionId: B });
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
    await waitFor(() => expect(groupOf(root.title)).toBe(groupBody('Second section')));
    expect(writes(calls)).toHaveLength(2);
  });

  it('keeps a rejected move as a reviewable draft after a revision conflict without resending', async () => {
    const { calls } = installFakeApi(server(() => failure(409, 'REVISION_CONFLICT', 'internal conflict detail')).routes);
    const { user } = renderApp(tablePath);
    const menu = await openMove(user);
    await user.click(menu.getByRole('option', { name: 'Second section' }));
    expect(await screen.findByText('This data changed elsewhere', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('internal conflict detail')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Section' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'More details' }));
    const drawer = within(await screen.findByRole('dialog', { name: root.title }));
    expect(drawer.getByRole('combobox', { name: 'Section' })).toHaveTextContent('Second section');
    expect(drawer.getByText('Unsaved changes')).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(1);
  });

  it('waits for a pending move before another row opens, then opens it from the reloaded rows', async () => {
    const gate = deferred<Response>();
    const fixture = server(() => gate.promise);
    const { calls } = installFakeApi(fixture.routes);
    const { user } = renderApp(tablePath);
    const menu = await openMove(user);
    await user.click(menu.getByRole('option', { name: 'Second section' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    const row = screen.getByRole('button', { name: root.title }).closest('tr');
    expect(row).toHaveClass('h-10'); expect(row?.querySelector('[data-task-section-editor]')).toHaveClass('absolute', 'w-52');
    await requestMove(user, peer.title);
    expect(screen.queryByRole('listbox', { name: 'Section' })).not.toBeInTheDocument();
    await act(async () => gate.resolve(fixture.confirm({ sectionId: B })));
    await waitFor(() => expect(groupOf(root.title)).toBe(groupBody('Second section')));
    const peerMenu = within(await screen.findByRole('listbox', { name: 'Section' }));
    expect(peerMenu.getByRole('option', { name: 'Second section' })).toHaveAttribute('aria-selected', 'true');
    expect(patches(calls)).toHaveLength(1);
  });
});
