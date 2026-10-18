import type { CreateTaskInput, TagDto, TaskDto } from '@workloom/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
import './ProjectPage';

const research: TagDto = { id: 'f7000000-0000-4000-8000-000000000009', workspaceId: alpha.id, name: 'Research', color: null, revision: 1, archivedAt: null };
const design: TagDto = { ...research, id: 'f7000000-0000-4000-8000-000000000008', name: 'Design' };
const saved: TaskDto = { ...task, tags: [] };
const NEW_TASK_ID = 'f2000000-0000-4000-8000-0000000000f9';
const CREATE_LABEL = 'Create tag “Research”';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Explicit columns: the tests never rely on which builtin columns are shown by default.
const preference = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'status' }, visible: true }, { column: { kind: 'builtin', key: 'tags' }, visible: true }] };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'inline-tag-fixture', nextCursor: null } });
type Calls = ReturnType<typeof installFakeApi>['calls'];
const writes = (calls: Calls) => calls.filter(call => call.method !== 'GET');
const tagPosts = (calls: Calls) => calls.filter(call => call.method === 'POST' && call.path === `${rootPath}/tags`);
const taskPosts = (calls: Calls) => calls.filter(call => call.method === 'POST' && call.path === `${rootPath}/tasks`);
const patches = (calls: Calls) => calls.filter(call => call.method === 'PATCH');
const keyOf = (call: Calls[number] | undefined) => call?.headers.get('Idempotency-Key') ?? null;
const rowOf = (node: HTMLElement) => node.closest('tr') as HTMLTableRowElement;
const draftInput = () => screen.getByRole('textbox', { name: 'Task name' });
const search = () => screen.getByRole('searchbox', { name: 'Search tags' });
const editTags = () => screen.findByRole('button', { name: `Edit tags for ${saved.title}` });

/** Server state: list and detail reads always reflect the last stored task and tag catalog. */
interface World { tasks: TaskDto[]; tags: TagDto[] }

function routes(world: World, extra: RouteTable = {}): RouteTable {
  return {
    ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => page(world.tasks),
    [`GET ${rootPath}/tasks/${saved.id}`]: () => ok(world.tasks.find(row => row.id === saved.id)),
    [`GET ${rootPath}/tags`]: () => ok(world.tags),
    [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preference),
    [`PATCH ${rootPath}/tasks/${saved.id}`]: request => {
      const body = request.body as { expectedRevision: number; tagIds: string[] };
      const current = world.tasks.find(row => row.id === saved.id) as TaskDto;
      const next: TaskDto = { ...current, tags: body.tagIds.map(id => world.tags.find(tag => tag.id === id) as TagDto), revision: current.revision + 1 };
      world.tasks = world.tasks.map(row => row.id === saved.id ? next : row);
      return ok(next);
    },
    ...extra,
  };
}

/** Commits the tag once on success; a failed attempt commits nothing. */
function commitResearch(world: World) {
  if (!world.tags.some(tag => tag.id === research.id)) world.tags = [...world.tags, research];
  return created(research);
}

describe('inline tag creation in a saved task tag editor', () => {
  it.each(['keyboard', 'button'] as const)('creates the workspace tag (%s), selects it locally and saves only on explicit Save', async mode => {
    const world: World = { tasks: [saved], tags: [] };
    const gate = deferred<undefined>();
    const { calls } = installFakeApi(routes(world, {
      [`POST ${rootPath}/tags`]: async () => { await gate.promise; return commitResearch(world); },
    }));
    const { user } = renderApp(tablePath);

    await user.click(await editTags());
    const dialog = await screen.findByRole('dialog', { name: 'Edit tags' });
    await user.type(search(), 'Research');
    const create = within(dialog).getByRole('button', { name: CREATE_LABEL });
    if (mode === 'keyboard') await user.keyboard('{Enter}');
    else await user.click(create);

    // Exactly one workspace command with the typed name; the task is untouched while it is held.
    await waitFor(() => expect(tagPosts(calls)).toHaveLength(1));
    expect(tagPosts(calls)[0]?.body).toEqual({ name: 'Research', color: null });
    expect(keyOf(tagPosts(calls)[0])).toMatch(UUID);
    expect(patches(calls)).toHaveLength(0);
    expect(writes(calls)).toHaveLength(1);

    // The acknowledgement selects the new tag in the draft and returns focus to search, still unsaved.
    gate.resolve(undefined);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Research' })).toBeChecked());
    await waitFor(() => expect(search()).toHaveFocus());
    expect(screen.getByRole('dialog', { name: 'Edit tags' })).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
    expect(tagPosts(calls)).toHaveLength(1);

    // Explicit Save sends one revisioned replacement of the tag set and nothing else.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.path).toBe(`${rootPath}/tasks/${saved.id}`);
    expect(patches(calls)[0]?.body).toEqual({ expectedRevision: saved.revision, tagIds: [research.id] });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit tags' })).not.toBeInTheDocument());
    expect(world.tasks[0]).toMatchObject({ revision: saved.revision + 1, tags: [research] });
    expect(tagPosts(calls)).toHaveLength(1);
    expect(writes(calls)).toHaveLength(2);
  });
});

describe('inline tag creation in a new blank task row', () => {
  it('creates only the workspace tag, keeps the empty draft through a child Escape and sends its tags with the titled create', async () => {
    const world: World = { tasks: [saved], tags: [] };
    const gate = deferred<undefined>();
    const { calls } = installFakeApi(routes(world, {
      [`POST ${rootPath}/tags`]: async () => { await gate.promise; return commitResearch(world); },
      [`POST ${rootPath}/tasks`]: request => {
        const body = request.body as CreateTaskInput & { tagIds?: string[] };
        // A valid TaskDto built by the server, never the raw request echoed back.
        const row: TaskDto = { ...saved, id: NEW_TASK_ID, workPackageId: 'f1000000-0000-4000-8000-0000000000f9', title: body.title, position: world.tasks.length, revision: 1, tags: (body.tagIds ?? []).map(id => world.tags.find(tag => tag.id === id) as TagDto) };
        world.tasks = [...world.tasks, row];
        return created(row);
      },
    }));
    const { user } = renderApp(tablePath);

    await user.click(await screen.findByRole('button', { name: 'Add task without a section' }));
    await waitFor(() => expect(draftInput()).toHaveValue(''));
    const draftRow = rowOf(draftInput());
    await user.click(within(draftRow).getByRole('button', { name: /tags/i }));
    await user.type(search(), 'Research');
    await user.keyboard('{Enter}');

    // Only the workspace tag command is sent; the blank row creates no task.
    await waitFor(() => expect(tagPosts(calls)).toHaveLength(1));
    expect(tagPosts(calls)[0]?.body).toEqual({ name: 'Research', color: null });
    expect(keyOf(tagPosts(calls)[0])).toMatch(UUID);
    expect(taskPosts(calls)).toHaveLength(0);
    expect(writes(calls)).toHaveLength(1);

    gate.resolve(undefined);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Research' })).toBeChecked());
    expect(taskPosts(calls)).toHaveLength(0);
    expect(draftInput()).toHaveValue('');

    // The first Escape closes only the tag child; the unsaved row and empty title remain.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('searchbox', { name: 'Search tags' })).not.toBeInTheDocument());
    expect(draftInput()).toHaveValue('');
    expect(rowOf(draftInput())).toBe(draftRow);
    expect(writes(calls)).toHaveLength(1);

    // A titled Enter sends one create carrying the captured tag.
    await user.click(draftInput());
    await user.keyboard('Research brief{Enter}');
    await waitFor(() => expect(taskPosts(calls)).toHaveLength(1));
    const body = taskPosts(calls)[0]?.body as CreateTaskInput & { tagIds?: string[] };
    expect(body).toMatchObject({ projectId: PROJECT_ID, title: 'Research brief' });
    expect(body.tagIds).toEqual([research.id]);
    expect(keyOf(taskPosts(calls)[0])).toBeTruthy();
    await screen.findByRole('button', { name: 'Research brief' });
    expect(tagPosts(calls)).toHaveLength(1);
    expect(patches(calls)).toHaveLength(0);
    expect(writes(calls)).toHaveLength(2);
  });
});

describe('inline tag creation failure after the editor collapses', () => {
  it('keeps a page status for a failed create, retries the original command and never auto-attaches on reopen', async () => {
    const world: World = { tasks: [saved], tags: [] };
    let attempts = 0;
    const { calls } = installFakeApi(routes(world, {
      [`POST ${rootPath}/tags`]: () => attempts++ === 0 ? failure(503, 'UNAVAILABLE', 'Tag service unavailable') : commitResearch(world),
    }));
    const { user } = renderApp(tablePath);

    await user.click(await editTags());
    const dialog = await screen.findByRole('dialog', { name: 'Edit tags' });
    await user.type(search(), 'Research');
    await user.keyboard('{Enter}');
    // Both the picker and the page recovery offer a retry; scope to the picker while it is open.
    await within(dialog).findByRole('button', { name: 'Retry creating tag' });
    expect(tagPosts(calls)).toHaveLength(1);
    const first = tagPosts(calls)[0];
    expect(first?.body).toEqual({ name: 'Research', color: null });
    expect(keyOf(first)).toMatch(UUID);

    // The clean task editor collapses, yet the pending tag outcome stays visible on the page.
    await user.click(screen.getByRole('button', { name: 'Collapse editor' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit tags' })).not.toBeInTheDocument());
    const status = screen.getByRole('status', { name: 'Inline tag creation' });
    expect(status).toBeVisible();
    expect(patches(calls)).toHaveLength(0);

    // Retry repeats the exact original body and key once; it never writes the task.
    await user.click(within(status).getByRole('button', { name: 'Retry creating tag' }));
    await waitFor(() => expect(tagPosts(calls)).toHaveLength(2));
    expect(tagPosts(calls)[1]?.body).toEqual(first?.body);
    expect(keyOf(tagPosts(calls)[1])).toBe(keyOf(first));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Inline tag creation' })).toHaveTextContent(/created/i));
    expect(screen.getByRole('status', { name: 'Inline tag creation' })).toHaveTextContent(/not added/i);
    expect(patches(calls)).toHaveLength(0);
    expect(world.tasks[0]).toEqual(saved);

    // Reopening shows the tag as available but unselected; the user must choose it explicitly.
    await user.click(await editTags());
    await screen.findByRole('dialog', { name: 'Edit tags' });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Research' })).not.toBeChecked());
    expect(patches(calls)).toHaveLength(0);
    await user.click(screen.getByRole('checkbox', { name: 'Research' }));
    expect(patches(calls)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.body).toEqual({ expectedRevision: saved.revision, tagIds: [research.id] });
    expect(tagPosts(calls)).toHaveLength(2);
    expect(writes(calls)).toHaveLength(3);
  });
});

describe('inline tag creation for a workspace member', () => {
  it('selects and saves an existing tag but offers no create for an unmatched search', async () => {
    const world: World = { tasks: [saved], tags: [design] };
    const memberAlpha = { ...alpha, role: 'member' as const };
    const members = alphaMembers.map(member => member.userId === anna.id ? { ...member, role: 'member' as const } : member);
    const { calls } = installFakeApi(routes(world, {
      'GET /api/v1/workspaces': () => ok([memberAlpha]),
      [`GET /api/v1/workspaces/${alpha.id}`]: () => ok(memberAlpha),
      [`GET /api/v1/workspaces/${alpha.id}/memberships`]: () => ok(members),
      [`POST ${rootPath}/tags`]: () => commitResearch(world),
    }));
    const { user } = renderApp(tablePath);

    await user.click(await editTags());
    const dialog = await screen.findByRole('dialog', { name: 'Edit tags' });
    await user.type(search(), 'Research');
    await user.keyboard('{Enter}');
    expect(within(dialog).queryByRole('button', { name: /Create tag/ })).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent(/owner/i);
    expect(dialog).toHaveTextContent(/admin/i);
    expect(screen.getByRole('dialog', { name: 'Edit tags' })).toBeInTheDocument();
    expect(tagPosts(calls)).toHaveLength(0);
    expect(writes(calls)).toHaveLength(0);

    await user.clear(search());
    await user.click(screen.getByRole('checkbox', { name: 'Design' }));
    expect(writes(calls)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.body).toEqual({ expectedRevision: saved.revision, tagIds: [design.id] });
    expect(tagPosts(calls)).toHaveLength(0);
    expect(writes(calls)).toHaveLength(1);
  });
});
