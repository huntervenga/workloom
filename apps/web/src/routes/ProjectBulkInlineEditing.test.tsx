import type { UserEvent } from '@testing-library/user-event';
import type { TaskDto, TaskStatusDto, TaskFieldData, TaskFieldDefinitionDto, TaskFieldValueDto, BulkUpdateTasksInput } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, deferred, failure, installFakeApi, json, ok, renderApp, type FakeRequest, type RouteTable } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { STAMP, field as fieldFixture } from '../features/fields/test/fixtures';
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
/** Opt-in custom receipt includes the actual persisted field value, independently of task revision. */
function customApplied(rows: { current: TaskDto[] }, request: FakeRequest, definition: TaskFieldDefinitionDto) {
  const body = request.body as { tasks: { taskId: string }[]; changes: { customField: { value: TaskFieldData } } };
  return ok(body.tasks.map(target => {
    const row = rows.current.find(row => row.id === target.taskId);
    if (!row) throw new Error('Custom receipt target missing from fixture');
    return { ...row, customFieldAck: {
      workspaceId: alpha.id, projectId: PROJECT_ID, taskId: target.taskId, fieldId: definition.id, definitionVersionId: definition.definitionVersionId,
      revision: 1, value: body.changes.customField.value, updatedAt: STAMP,
    } };
  }));
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
      [`POST ${bulkPath}`]: request => customApplied(rows, request, definition),
    })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(screen.getByRole('button', { name: `Edit Score for ${first.title}` }));
    const dialog = screen.getByRole('textbox', { name: `Edit Score for ${first.title}` }).closest('[data-inline-field-cell]') as HTMLElement;
    await user.click(within(dialog).getByLabelText(`Edit Score for ${first.title}`));
    fireEvent.change(within(dialog).getByLabelText(`Edit Score for ${first.title}`), { target: { value: '0' } });
    await user.tab();
    await screen.findByText('Saved 2 selected tasks.');
    expect(writes(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, includeFieldValueAck: true, tasks: both.map(row => ({ ...row, expectedFieldValueRevision: 0 })), changes: { customField: { fieldId: definition.id, expectedDefinitionRevision: 4, value: { type: 'number', value: 0 } } } });
  });

  it('starts a selected custom edit from a single-write ACK while its authoritative refetch is still pending', async () => {
    const definition = { ...fieldFixture('Hours Estimation', 'duration'), projectId: PROJECT_ID };
    const refetch = deferred<Response>(); let valueReads = 0;
    const persisted: TaskFieldValueDto = { workspaceId: alpha.id, projectId: PROJECT_ID, taskId: first.id, fieldId: definition.id,
      definitionVersionId: definition.definitionVersionId, revision: 1, value: { type: 'duration', value: 150 }, updatedAt: STAMP };
    const { calls } = installFakeApi(routes(rows => ({
      [`GET ${rootPath}/fields`]: () => ok([definition]),
      [`GET ${rootPath}/projects/${PROJECT_ID}/columns`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, revision: 1, columns: [{ fieldId: definition.id, position: 0, width: 160, visible: true }] }),
      [`GET ${rootPath}/projects/${PROJECT_ID}/field-values`]: () => ++valueReads === 1 ? ok([]) : refetch.promise,
      [`PUT ${rootPath}/tasks/${first.id}/field-values/${definition.id}`]: () => ok(persisted),
      [`POST ${bulkPath}`]: request => {
        const input = request.body as BulkUpdateTasksInput;
        if (input.changes.restore) {
          const restore = input.changes.restore;
          return ok(input.tasks.map(target => {
            const row = rows.current.find(row => row.id === target.taskId);
            const value = restore.find(change => change.taskId === target.taskId)?.changes.customField?.value;
            if (!row || !value) throw new Error('Restored custom ACK fixture target missing');
            return { ...row, customFieldAck: { ...persisted, taskId: target.taskId, revision: (target.expectedFieldValueRevision ?? 0) + 1, value } };
          }));
        }
        const source = input.tasks.find(target => target.taskId === first.id);
        if (source?.expectedFieldValueRevision !== persisted.revision) return failure(409, 'REVISION_CONFLICT', 'Field value changed.');
        const result = input.tasks.map(target => {
          const row = rows.current.find(row => row.id === target.taskId);
          if (!row) throw new Error('Custom ACK fixture target missing');
          return { ...row, customFieldAck: {
            ...persisted, taskId: target.taskId, revision: target.taskId === first.id ? 2 : 1, value: { type: 'duration', value: 180 },
          } };
        });
        return ok(result);
      },
    })));
    const { user } = renderApp(tablePath);
    const name = `Edit Hours Estimation for ${first.title}`;
    await user.click(await screen.findByRole('button', { name }));
    await user.type(screen.getByRole('textbox', { name }), '2.5{Enter}');
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    await waitFor(() => expect(valueReads).toBeGreaterThan(1));
    expect(screen.getByRole('button', { name })).toHaveTextContent('2h 30m');
    // A confirmed single value must survive switching to the selected-row editor before GET settles.
    await selectBoth(user);
    await user.click(screen.getByRole('button', { name }));
    expect(screen.getByRole('textbox', { name })).toHaveValue('2:30');
    await user.clear(screen.getByRole('textbox', { name }));
    await user.type(screen.getByRole('textbox', { name }), '3{Enter}');
    await screen.findByText('Saved 2 selected tasks.');
    expect(bulkWrites(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, includeFieldValueAck: true,
      tasks: both.map(target => ({ ...target, expectedFieldValueRevision: target.taskId === first.id ? 1 : 0 })),
      changes: { customField: { fieldId: definition.id, expectedDefinitionRevision: 1, value: { type: 'duration', value: 180 } } } });
    // The inverse also uses persisted ACK heads, and preserves the actual 150 / absent before-values.
    await waitFor(() => expect(gutter(first)).not.toHaveAttribute('aria-disabled', 'true'));
    gutter(first).focus(); await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(bulkWrites(calls)).toHaveLength(2));
    expect(bulkWrites(calls)[1]?.body).toEqual({ projectId: PROJECT_ID, includeFieldValueAck: true,
      tasks: both.map(target => ({ ...target, expectedFieldValueRevision: target.taskId === first.id ? 2 : 1 })),
      changes: { restore: both.map(target => ({ taskId: target.taskId, changes: { customField: { fieldId: definition.id, expectedDefinitionRevision: 1,
        value: { type: 'duration', value: target.taskId === first.id ? 150 : null } } } })) } });
    // Settle only after the guarded batch and its exact inverse; no sleeps or deadline changes.
    await act(async () => refetch.resolve(ok([{ ...persisted, revision: 3 }, { ...persisted, taskId: second.id, revision: 2, value: { type: 'duration', value: null } }])));
  });

  it('keeps an ordinary duration edit anchored to the selection captured before a later selection change', async () => {
    const definition = { ...fieldFixture('Hours Estimation', 'duration'), projectId: PROJECT_ID, revision: 4 };
    const { calls } = installFakeApi(routes(rows => ({
      [`GET ${rootPath}/fields`]: () => ok([definition]),
      [`GET ${rootPath}/projects/${PROJECT_ID}/columns`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, revision: 1, columns: [{ fieldId: definition.id, position: 0, width: 160, visible: true }] }),
      [`GET ${rootPath}/projects/${PROJECT_ID}/field-values`]: () => ok([]),
      [`POST ${bulkPath}`]: request => customApplied(rows, request, definition),
    })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    const name = `Edit Hours Estimation for ${first.title}`;
    await user.click(screen.getByRole('button', { name }));
    const input = screen.getByRole('textbox', { name });
    fireEvent.change(input, { target: { value: '1:30' } });
    fireEvent.click(gutter(third));
    expect(screen.getByRole('textbox', { name })).toBe(input);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await screen.findByText('Saved 2 selected tasks.');
    expect(writes(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, includeFieldValueAck: true, tasks: both.map(target => ({ ...target, expectedFieldValueRevision: 0 })), changes: { customField: { fieldId: definition.id, expectedDefinitionRevision: 4, value: { type: 'duration', value: 90 } } } });
  });

  it('keeps an already-open one-task custom editor single-task when a later selection grows', async () => {
    const definition = { ...fieldFixture('Hours Estimation', 'duration'), projectId: PROJECT_ID };
    const { calls } = installFakeApi(routes(() => ({
      [`GET ${rootPath}/fields`]: () => ok([definition]),
      [`GET ${rootPath}/projects/${PROJECT_ID}/columns`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, revision: 1, columns: [{ fieldId: definition.id, position: 0, width: 160, visible: true }] }),
      [`GET ${rootPath}/projects/${PROJECT_ID}/field-values`]: () => ok([]),
      [`PUT ${rootPath}/tasks/${first.id}/field-values/${definition.id}`]: request => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, taskId: first.id, fieldId: definition.id, definitionVersionId: definition.definitionVersionId, revision: 1, value: (request.body as { value: TaskFieldData }).value, updatedAt: STAMP }),
    })));
    const { user } = renderApp(tablePath);
    const name = `Edit Hours Estimation for ${first.title}`;
    await user.click(await screen.findByRole('button', { name }));
    const input = screen.getByRole('textbox', { name });
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.click(gutter(first)); fireEvent.click(gutter(second), { ctrlKey: true });
    expect(screen.getByRole('textbox', { name })).toBe(input);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: 'PUT', path: `${rootPath}/tasks/${first.id}/field-values/${definition.id}`, body: { expectedRevision: 0, expectedDefinitionRevision: 1, value: { type: 'duration', value: 120 } } });
    expect(bulkWrites(calls)).toHaveLength(0);
  });

  it('retries an uncertain ordinary custom batch with its exact original value, targets and key', async () => {
    const definition = { ...fieldFixture('Hours Estimation', 'duration'), projectId: PROJECT_ID };
    const gate = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi(routes(rows => ({
      [`GET ${rootPath}/fields`]: () => ok([definition]),
      [`GET ${rootPath}/projects/${PROJECT_ID}/columns`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, revision: 1, columns: [{ fieldId: definition.id, position: 0, width: 160, visible: true }] }),
      [`GET ${rootPath}/projects/${PROJECT_ID}/field-values`]: () => ok([]),
      [`POST ${bulkPath}`]: request => ++attempts === 1 ? gate.promise : customApplied(rows, request, definition),
    })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    const name = `Edit Hours Estimation for ${first.title}`;
    await user.click(screen.getByRole('button', { name }));
    await user.type(screen.getByRole('textbox', { name }), '0{Enter}');
    await waitFor(() => expect(attempts).toBe(1));
    await act(async () => gate.lose());
    const retry = await within(bar()).findByRole('button', { name: 'Retry original' });
    fireEvent.click(gutter(third));
    expect(attempts).toBe(1);
    await user.click(retry);
    await screen.findByText('Saved 2 selected tasks.');
    const sent = bulkWrites(calls); expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
    expect(sent[0]?.body).toEqual({ projectId: PROJECT_ID, includeFieldValueAck: true, tasks: both.map(target => ({ ...target, expectedFieldValueRevision: 0 })), changes: { customField: { fieldId: definition.id, expectedDefinitionRevision: 1, value: { type: 'duration', value: 0 } } } });
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
      [`POST ${bulkPath}`]: request => customApplied(rows, request, definition),
    })));
    const { user } = renderApp(tablePath); await selectBoth(user);
    await user.click(screen.getByRole('button', { name: `Open task “${third.title}”` }));
    const pane = await screen.findByRole('dialog', { name: third.title });
    await user.click(screen.getByRole('button', { name: `Edit Score for ${first.title}` }));
    const editor = screen.getByRole('textbox', { name: `Edit Score for ${first.title}` }).closest('[data-inline-field-cell]') as HTMLElement;
    expect(pane).toBeInTheDocument();
    await user.click(within(editor).getByLabelText(`Edit Score for ${first.title}`));
    fireEvent.change(within(editor).getByLabelText(`Edit Score for ${first.title}`), { target: { value: '0' } });
    await user.tab();
    await screen.findByText('Saved 2 selected tasks.');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `Edit Score for ${first.title}` })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: third.title })).toBe(pane);
    expect(writes(calls)).toHaveLength(1); expect(bulkWrites(calls)).toHaveLength(1);
    expect(bulkWrites(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, includeFieldValueAck: true, tasks: both.map(target => ({ ...target, expectedFieldValueRevision: 0 })), changes: { customField: { fieldId: definition.id, expectedDefinitionRevision: 4, value: { type: 'number', value: 0 } } } });
  });
});
