import type { UserEvent } from '@testing-library/user-event';
import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, installFakeApi, json, ok, renderApp, type FakeRequest, type RouteTable } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { field as fieldFixture } from '../features/fields/test/fixtures';
import { PROJECT_ID, rootPath, task, legacyTablePath, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });

const PROGRESS = 'f6000000-0000-4000-8000-000000000002';
const DONE = 'f6000000-0000-4000-8000-000000000003';
const NEXT = alphaMembers[1];
if (!NEXT) throw new Error('Missing next member fixture');
const todo: TaskStatusDto = { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored active', group: 'todo', position: 0, revision: 1 };
const progress: TaskStatusDto = { ...todo, id: PROGRESS, name: 'Stored progress', group: 'in_progress', position: 1 };
const done: TaskStatusDto = { ...todo, id: DONE, name: 'Stored done', group: 'done', position: 2 };
const first: TaskDto = { ...task, title: 'First selected task', revision: 3, startDate: null, dueDate: null };
const second: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000002', workPackageId: 'f1000000-0000-4000-8000-000000000002', title: 'Second selected task', revision: 7, startDate: null, dueDate: null };
const third: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-000000000003', workPackageId: 'f1000000-0000-4000-8000-000000000003', title: 'Unselected task', revision: 2, startDate: null, dueDate: null };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'bulk-inline-fixture', nextCursor: null } });
const bulkPath = `${rootPath}/tasks/bulk-update`;

/** A live list: every confirmed write replaces its rows, so refetches read the new heads. */
function routes(extra: (rows: { current: TaskDto[] }) => RouteTable = () => ({})): RouteTable {
  const rows = { current: [first, second, third] };
  return {
    ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => page(rows.current),
    ...Object.fromEntries(rows.current.map(row => [`GET ${rootPath}/tasks/${row.id}`, () => ok(rows.current.find(item => item.id === row.id))])),
    [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([todo, progress, done]),
    ...extra(rows),
  };
}
/** The server's answer for an accepted batch: every listed row at its next revision. */
function applied(rows: { current: TaskDto[] }, request: FakeRequest) {
  const body = request.body as { tasks: { taskId: string; expectedRevision: number }[]; changes: Partial<TaskDto> };
  const changed = body.tasks.map(target => ({ ...rows.current.find(row => row.id === target.taskId) as TaskDto, ...body.changes, revision: target.expectedRevision + 1 }));
  rows.current = rows.current.map(row => changed.find(item => item.id === row.id) ?? row);
  return ok(changed);
}
const writes = (calls: FakeRequest[]) => calls.filter(call => call.method !== 'GET');
const bulkWrites = (calls: FakeRequest[]) => calls.filter(call => call.method === 'POST' && call.path === bulkPath);
const gutter = (row: TaskDto) => screen.getByRole('button', { name: `Select task: ${row.title}` });
const cell = (field: RegExp, row: TaskDto) => screen.getByRole('button', { name: new RegExp(`^Edit ${field.source} for ${row.title}$`, 'i') });
const choose = (user: UserEvent, list: string, option: string) => user.click(within(screen.getByRole('listbox', { name: list })).getByRole('option', { name: option }));
const bar = () => screen.getByRole('region', { name: 'Edit selected tasks' });
const views = () => within(screen.getByRole('navigation', { name: 'Project views' }));
const both = [{ taskId: first.id, expectedRevision: first.revision }, { taskId: second.id, expectedRevision: second.revision }];

async function selectBoth(user: UserEvent) {
  await user.click(await screen.findByRole('button', { name: `Select task: ${first.title}` }));
  await user.keyboard('{Control>}'); await user.click(gutter(second)); await user.keyboard('{/Control}');
  expect(gutter(first)).toHaveAttribute('aria-pressed', 'true'); expect(gutter(second)).toHaveAttribute('aria-pressed', 'true');
}

describe('selected-cell bulk inline editing', () => {
  it('applies a status chosen in a selected row to the whole frozen selection through one atomic command', async () => {
    const { calls } = installFakeApi(routes(rows => ({ [`POST ${bulkPath}`]: request => applied(rows, request) })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(cell(/status/, first));
    const countVisible = screen.queryByText('Applies to 2 selected tasks') !== null;
    await choose(user, 'Status', 'Stored progress');
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls).map(call => ({ method: call.method, path: call.path }))).toEqual([{ method: 'POST', path: bulkPath }]);
    expect(countVisible).toBe(true);
    await screen.findByText('Saved 2 selected tasks.');
    expect(bulkWrites(calls)).toHaveLength(1); expect(writes(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: both, changes: { statusId: PROGRESS } });
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument());
    expect(screen.queryByText('Draft kept')).not.toBeInTheDocument();
    expect(gutter(first)).toHaveAttribute('aria-pressed', 'true'); expect(gutter(second)).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends exactly the explicitly changed start and due keys from a selected date cell', async () => {
    const { calls } = installFakeApi(routes(rows => ({ [`POST ${bulkPath}`]: request => applied(rows, request) })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(cell(/(due )?dates?/, second));
    await user.click(screen.getByRole('button', { name: '+ Start date' }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-03-10' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-03-20' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved 2 selected tasks.');
    expect(writes(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: both, changes: { startDate: '2027-03-10', dueDate: '2027-03-20' } });
  });

  it('applies an assignee choice to the selection and never adds title, description or estimate keys', async () => {
    const { calls } = installFakeApi(routes(rows => ({ [`POST ${bulkPath}`]: request => applied(rows, request) })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(cell(/assignee/, first)); await choose(user, 'Assignee', NEXT.displayName);
    await screen.findByText('Saved 2 selected tasks.');
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: both, changes: { responsibleMembershipId: NEXT.id } });
    expect(writes(calls)).toHaveLength(1);
  });

  it.each(['unselected', 'single'] as const)('keeps the single-task command for an %s row', async kind => {
    const { calls } = installFakeApi(routes(rows => ({ [`PATCH ${rootPath}/tasks/${first.id}`]: () => ok(rows.current[0] = { ...first, statusId: PROGRESS, revision: first.revision + 1 }), [`PATCH ${rootPath}/tasks/${third.id}`]: () => ok(rows.current[2] = { ...third, statusId: PROGRESS, revision: third.revision + 1 }) })));
    const { user } = renderApp(tablePath);
    if (kind === 'unselected') await selectBoth(user); else await user.click(await screen.findByRole('button', { name: `Select task: ${first.title}` }));
    const edited = kind === 'unselected' ? third : first;
    await user.click(cell(/status/, edited));
    expect(screen.queryByText('Applies to 2 selected tasks')).not.toBeInTheDocument();
    await choose(user, 'Status', 'Stored progress');
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: 'PATCH', body: { expectedRevision: edited.revision, statusId: PROGRESS } });
    expect(bulkWrites(calls)).toHaveLength(0);
  });

  it('completes the whole selection with the status the clicked row’s circle chose, in one command', async () => {
    const { calls } = installFakeApi(routes(rows => ({ [`POST ${bulkPath}`]: request => applied(rows, request) })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(screen.getByRole('button', { name: `Mark ${second.title} complete` }));
    await screen.findByText('Status saved for 2 selected tasks.');
    expect(writes(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: both, changes: { statusId: DONE } });
  });

  it('keeps an unknown batch frozen across views and retries its exact bytes and key only on request', async () => {
    const lost = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi(routes(rows => ({ [`POST ${bulkPath}`]: request => ++attempts === 1 ? lost.promise : applied(rows, request) })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(cell(/status/, first)); await choose(user, 'Status', 'Stored progress');
    await waitFor(() => expect(attempts).toBe(1)); await act(async () => lost.lose());
    await within(bar()).findByRole('button', { name: 'Retry original' });
    await user.keyboard('{Escape}');
    await user.click(views().getByRole('button', { name: 'Board' })); await user.click(views().getByRole('button', { name: 'Tasks' }));
    await user.click(await screen.findByRole('button', { name: `Select task: ${third.title}` }));
    expect(gutter(third)).toHaveAttribute('aria-pressed', 'false'); expect(gutter(first)).toHaveAttribute('aria-pressed', 'true');
    expect(within(bar()).getByText('2 tasks selected')).toBeVisible();
    expect(attempts).toBe(1);
    await user.click(within(bar()).getByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(attempts).toBe(2));
    const sent = writes(calls); expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
    expect(sent[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: both, changes: { statusId: PROGRESS } });
    await waitFor(() => expect(screen.queryByText('Draft kept')).not.toBeInTheDocument());
  });

  it('does not report success for a partial answer and never retries it automatically', async () => {
    const { calls } = installFakeApi(routes(rows => ({ [`POST ${bulkPath}`]: () => ok([rows.current[0] = { ...first, statusId: PROGRESS, revision: first.revision + 1 }]) })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(cell(/status/, first)); await choose(user, 'Status', 'Stored progress');
    await within(bar()).findByRole('button', { name: 'Retry original' });
    expect(screen.queryByText('Saved 2 selected tasks.')).not.toBeInTheDocument();
    expect(writes(calls)).toHaveLength(1);
  });

  it('refuses the whole batch with a notice when another selected task holds a draft', async () => {
    const { calls } = installFakeApi(routes());
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: `Open task “${second.title}”` }));
    await user.clear(within(await screen.findByRole('dialog')).getByLabelText('Task name')); await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await selectBoth(user);
    await user.click(cell(/status/, first)); await choose(user, 'Status', 'Stored progress');
    await screen.findByText('Another selected task has an unsaved draft. Save or discard it first.');
    expect(writes(calls)).toHaveLength(0);
  });

  it('applies a shared estimate with every selected package revision in one command', async () => {
    const { calls } = installFakeApi(routes(rows => ({ [`POST ${bulkPath}`]: request => applied(rows, request) })));
    const { user } = renderApp(legacyTablePath(tablePath)); await selectBoth(user);
    await user.click(cell(/.*estimate/, first));
    const input = screen.getByRole('textbox', { name: 'Team estimate (hours)' });
    await user.clear(input); await user.type(input, '2'); await user.keyboard('{Enter}');
    await screen.findByText('Saved 2 selected tasks.');
    expect(writes(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: [first, second].map(row => ({ taskId: row.id, expectedRevision: row.revision, expectedWorkPackageRevision: row.workPackageRevision })), changes: { estimateMinutes: 120 } });
  });

  it('keeps the selection captured when an editor opened even if an unselected row is clicked later', async () => {
    const { calls } = installFakeApi(routes(rows => ({ [`POST ${bulkPath}`]: request => applied(rows, request) })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(cell(/(due )?dates?/, first));
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-03-20' } });
    // A selection event does not retarget the already-open cell; the mouse-down remains in its panel.
    fireEvent.click(gutter(third));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved 2 selected tasks.');
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: both, changes: { dueDate: '2027-03-20' } });
  });

  it('autosaves the typed selected custom field on blur through one guarded batch without per-task writes', async () => {
    const definition = { ...fieldFixture('Score', 'number'), projectId: PROJECT_ID, revision: 4 };
    const { calls } = installFakeApi(routes(rows => ({
      [`GET ${rootPath}/fields`]: () => ok([definition]),
      [`GET ${rootPath}/projects/${PROJECT_ID}/columns`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, revision: 1, columns: [{ fieldId: definition.id, position: 0, width: 160, visible: true }] }),
      [`GET ${rootPath}/projects/${PROJECT_ID}/field-values`]: () => ok([]),
      [`POST ${bulkPath}`]: request => ok((request.body as { tasks: { taskId: string }[] }).tasks.map(target => rows.current.find(row => row.id === target.taskId))),
    })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(screen.getByRole('button', { name: `Edit Score for ${first.title}` }));
    const dialog = screen.getByRole('dialog', { name: `Edit Score for ${first.title}` });
    await user.click(within(dialog).getByLabelText('Score'));
    fireEvent.change(within(dialog).getByLabelText('Score'), { target: { value: '0' } });
    await user.tab();
    await screen.findByText('Saved 2 selected tasks.');
    expect(writes(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: both.map(row => ({ ...row, expectedFieldValueRevision: 0 })), changes: { customField: { fieldId: definition.id, expectedDefinitionRevision: 4, value: { type: 'number', value: 0 } } } });
  });

  it('labels a selected title edit as single-task and never mass-renames', async () => {
    const { calls } = installFakeApi(routes(rows => ({ [`PATCH ${rootPath}/tasks/${first.id}`]: () => ok(rows.current[0] = { ...first, title: first.title + ' revised', revision: first.revision + 1 }) })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(screen.getByRole('button', { name: first.title }));
    expect(within(screen.getByRole('form', { name: /in the task table$/ })).getByText('Editing this task only')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Task name' }), ' revised'); await user.keyboard('{Enter}');
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: 'PATCH', path: `${rootPath}/tasks/${first.id}`, body: { title: first.title + ' revised' } });
    expect(bulkWrites(calls)).toHaveLength(0);
  });
});

describe('Escape and the selection', () => {
  it('clears the selection from a keyboard-focused gutter', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath); await selectBoth(user);
    gutter(second).focus(); await user.keyboard('{Escape}');
    expect(gutter(first)).toHaveAttribute('aria-pressed', 'false'); expect(gutter(second)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('region', { name: 'Edit selected tasks' })).not.toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });

  it('closes an open picker first and clears the selection only on the next neutral Escape', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(cell(/status/, first)); expect(screen.getByRole('listbox', { name: 'Status' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument());
    expect(gutter(first)).toHaveAttribute('aria-pressed', 'true'); expect(gutter(second)).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(cell(/status/, first)).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(gutter(first)).toHaveAttribute('aria-pressed', 'false');
    expect(writes(calls)).toHaveLength(0);
  });

  it('keeps a selection held by an unknown batch and its recovery', async () => {
    const lost = lostResponse();
    installFakeApi(routes(() => ({ [`POST ${bulkPath}`]: () => lost.promise })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(screen.getByRole('button', { name: `Mark ${first.title} complete` }));
    await act(async () => lost.lose());
    await within(bar()).findByRole('button', { name: 'Retry original' });
    gutter(first).focus(); await user.keyboard('{Escape}');
    expect(gutter(first)).toHaveAttribute('aria-pressed', 'true'); expect(gutter(second)).toHaveAttribute('aria-pressed', 'true');
    expect(within(bar()).getByRole('button', { name: 'Retry original' })).toBeVisible();
  });
});


afterEach(() => vi.unstubAllGlobals());
describe('selection Escape beside the desktop task pane', () => {
  it('clears a neutral outside table selection while leaving the nonmodal pane open', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1280'), media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => true }));
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(screen.getByRole('button', { name: `Open task “${third.title}”` }));
    await screen.findByRole('dialog', { name: third.title });
    gutter(second).focus(); await user.keyboard('{Escape}');
    expect(gutter(first)).toHaveAttribute('aria-pressed', 'false'); expect(gutter(second)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('dialog', { name: third.title })).toBeInTheDocument(); expect(writes(calls)).toHaveLength(0);
  });
});

describe('neighboring table edits beside an existing desktop task pane', () => {
  const desktop = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1280'), media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => true }));
  it('keeps the same open task pane while a neighboring assignee edit saves only that neighbor', async () => {
    desktop();
    const { calls } = installFakeApi(routes(rows => ({ [`PATCH ${rootPath}/tasks/${first.id}`]: request => ok(rows.current[0] = { ...first, responsibleMembershipId: (request.body as { responsibleMembershipId: string }).responsibleMembershipId, revision: first.revision + 1 }) })));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: `Open task “${third.title}”` }));
    const pane = await screen.findByRole('dialog', { name: third.title });
    expect(pane).toHaveAttribute('data-task-panel');
    await user.click(cell(/assignee/, first));
    expect(screen.getByRole('dialog', { name: third.title })).toBe(pane);
    await choose(user, 'Assignee', NEXT.displayName);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: 'PATCH', path: `${rootPath}/tasks/${first.id}`, body: { expectedRevision: first.revision, responsibleMembershipId: NEXT.id } });
    expect(screen.getByRole('dialog', { name: third.title })).toBe(pane);
    expect(pane).toBeInTheDocument(); expect(bulkWrites(calls)).toHaveLength(0);
  });

  it('keeps the same pane when a neighboring custom-value editor applies its captured selection', async () => {
    desktop();
    const definition = { ...fieldFixture('Score', 'number'), projectId: PROJECT_ID, revision: 4 };
    const { calls } = installFakeApi(routes(rows => ({
      [`GET ${rootPath}/fields`]: () => ok([definition]),
      [`GET ${rootPath}/projects/${PROJECT_ID}/columns`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, revision: 1, columns: [{ fieldId: definition.id, position: 0, width: 160, visible: true }] }),
      [`GET ${rootPath}/projects/${PROJECT_ID}/field-values`]: () => ok([]),
      [`POST ${bulkPath}`]: request => ok((request.body as { tasks: { taskId: string }[] }).tasks.map(target => rows.current.find(row => row.id === target.taskId))),
    })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(screen.getByRole('button', { name: `Open task “${third.title}”` }));
    const pane = await screen.findByRole('dialog', { name: third.title });
    await user.click(screen.getByRole('button', { name: `Edit Score for ${first.title}` }));
    const editor = screen.getByRole('dialog', { name: `Edit Score for ${first.title}` });
    expect(pane).toBeInTheDocument();
    await user.click(within(editor).getByLabelText('Score'));
    fireEvent.change(within(editor).getByLabelText('Score'), { target: { value: '0' } });
    await user.tab();
    await screen.findByText('Saved 2 selected tasks.');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `Edit Score for ${first.title}` })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: third.title })).toBe(pane);
    expect(writes(calls)).toHaveLength(1); expect(bulkWrites(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: both.map(target => ({ ...target, expectedFieldValueRevision: 0 })), changes: { customField: { fieldId: definition.id, expectedDefinitionRevision: 4, value: { type: 'number', value: 0 } } } });
  });
});
