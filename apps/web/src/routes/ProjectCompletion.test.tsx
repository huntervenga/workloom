import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
beforeAll(async () => { await import('./ProjectPage'); });
const DONE = 'f6000000-0000-4000-8000-000000000002';
const DONE_B = 'f6000000-0000-4000-8000-000000000003';
const base: TaskStatusDto = { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored active', group: 'todo', position: 0, revision: 1 };
const done: TaskStatusDto = { ...base, id: DONE, name: 'Stored done', group: 'done', position: 1 };
const other = { ...task, id: 'f2000000-0000-4000-8000-000000000002', title: 'Other task', workPackageId: 'f1000000-0000-4000-8000-000000000002' };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'completion-fixture', nextCursor: null } });
function routes(extra: RouteTable = {}): RouteTable { return { ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => page([task]), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task), [`GET ${rootPath}/tasks/${other.id}`]: () => ok(other), [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([base, done]), ...extra }; }
const complete = () => screen.findByRole('button', { name: `Mark ${task.title} complete` });
function views() { return within(screen.getByRole('navigation', { name: 'Project views' })); }

describe('explicit task completion', () => {
  it('separates Graph selection from a revision-only one-click command and waits for confirmation', async () => {
    const gate = deferred<Response>(); const seen = { ...task, revision: 4 }; let current = seen;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: `Select task: ${task.title}` }));
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    await user.click(await complete());
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: 4, statusId: DONE });
    expect(screen.queryByRole('button', { name: `Reopen ${task.title}` })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Saving status for ${task.title}…` })).toHaveAttribute('aria-disabled', 'true');
    const sourceButton = screen.getByRole('button', { name: `Saving status for ${task.title}…` }); await user.click(sourceButton); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    await act(async () => gate.resolve(ok(current = { ...seen, statusId: DONE, revision: 5 })));
    expect(await screen.findByRole('button', { name: `Reopen ${task.title}` })).toBe(sourceButton); expect(sourceButton).toHaveFocus();
    expect(screen.getByRole('button', { name: `Select task: ${task.title}` })).toHaveAttribute('aria-pressed', 'true');
  });
  it('requires an explicit done choice when there are multiple completion statuses', async () => {
    let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([base, done, { ...done, id: DONE_B, name: 'Other done' }]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok(current = { ...task, statusId: DONE_B, revision: 2 }) }));
    const { user } = renderApp(tablePath); await user.click(await complete());
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
    await user.keyboard('{Escape}'); expect(await complete()).toHaveFocus(); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
    await user.keyboard('{Enter}'); await user.click(await screen.findByRole('menuitem', { name: 'Complete as Other done' }));
    await screen.findByRole('button', { name: `Reopen ${task.title}` });
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: 1, statusId: DONE_B });
  });
  it.each(['done', 'cancelled'] as const)('reopens a %s task only after choosing an active status, even with one choice', async group => {
    let item = { ...task, statusId: DONE };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([item]), [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([base, { ...done, group }]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok(item = { ...task, revision: 2 }) }));
    const { user } = renderApp(tablePath); await user.click(await screen.findByRole('button', { name: `Reopen ${task.title}` }));
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
    await user.click(screen.getByRole('menuitem', { name: 'Reopen as Stored active' }));
    if (group === 'cancelled') await screen.findByRole('button', { name: 'No completion status is configured.' }); else await complete(); expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: 1, statusId: task.statusId });
  });
  it('never submits an invalid retained rich draft through the circle', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: `Open task “${task.title}”` })); const drawer = await screen.findByRole('dialog');
    await user.clear(within(drawer).getByLabelText('Task name')); await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: `Resume draft for ${task.title}` }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('keeps an active inline edit intact and does not auto-save it through the circle', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: `Edit assignee for ${task.title}` }));
    expect(screen.getByRole('listbox', { name: 'Assignee' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish or collapse the current field edit first.' })).toBeDisabled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Assignee' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: task.title }));
    fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Typed title only' } });
    expect(screen.getByRole('button', { name: 'Finish or collapse the current field edit first.' })).toBeDisabled();
    expect(screen.getByLabelText('Task name')).toHaveValue('Typed title only');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('keeps a dependency refusal visible without an optimistic completed state or raw server copy', async () => {
    const { calls } = installFakeApi(routes({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(422, 'DEPENDENCY_BLOCKED', 'private predecessor value') }));
    const { user } = renderApp(tablePath); await user.click(await complete());
    await screen.findByRole('region', { name: 'Task completion status' });
    await screen.findByRole('button', { name: `Resume draft for ${task.title}` });
    expect(screen.queryByRole('button', { name: `Reopen ${task.title}` })).not.toBeInTheDocument();
    expect(screen.queryByText('private predecessor value')).not.toBeInTheDocument(); expect(within(screen.getByRole('region',{name:'Task completion status'})).getByRole('alert')).toBeVisible();
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
  it('retains a committed unknown command across Board and a hidden task and retries exact bytes/key', async () => {
    const gate = lostResponse(); let attempts = 0; let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => page(request.searchParams.has('search') ? [] : [current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempts === 1 ? gate.promise : ok(current = { ...task, statusId: DONE, revision: 2 }) }));
    const { user } = renderApp(tablePath); await user.click(await complete()); await waitFor(() => expect(attempts).toBe(1));
    await act(async () => gate.lose()); await screen.findByRole('button', { name: 'Retry original status change' });
    await user.click(views().getByRole('button', { name: 'Board' })); await user.type(screen.getByLabelText('Search tasks'), 'hidden');
    await screen.findByText('0 tasks in this view.'); await user.click(screen.getByRole('button', { name: 'Retry original status change' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry original status change' })).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const writes = calls.filter(call => call.method === 'PATCH'); expect(writes).toHaveLength(2); expect(writes[1]?.body).toEqual(writes[0]?.body); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    await user.clear(screen.getByLabelText('Search tasks')); await screen.findByRole('button', { name: `Reopen ${task.title}` });
  });
  it('does not steal focus or leave a duplicate draft after a late acknowledgement in another view', async () => {
    const gate = deferred<Response>(); let current = task; const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath); await user.click(await complete()); await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
    await user.click(views().getByRole('button', { name: 'Board' })); const focus = document.activeElement;
    await act(async () => gate.resolve(ok(current = { ...task, statusId: DONE, revision: 2 })));
    await screen.findByRole('button', { name: `Reopen ${task.title}` }); expect(document.activeElement).toBe(focus); expect(screen.queryByText('Draft kept')).not.toBeInTheDocument(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
  it.each(['viewer', 'archived', 'meeting', 'unknown-type', 'unknown-status', 'no-done'] as const)('does not send a completion for %s', async kind => {
    const item = { ...task, archivedAt: kind === 'archived' ? task.createdAt : null, meetingId: kind === 'meeting' ? DONE_B : kind === 'unknown-type' ? undefined : null, statusId: kind === 'unknown-status' ? DONE_B : task.statusId };
    const { calls } = installFakeApi(routes({ ...(kind === 'viewer' ? { 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }) } : {}), [`GET ${rootPath}/tasks`]: () => page([item]), [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok(kind === 'no-done' ? [base] : [base, done]) }));
    renderApp(tablePath); await screen.findByRole('button', { name: task.title });
    const action = screen.queryByRole('button', { name: `Mark ${task.title} complete` }); expect(action).not.toBeInTheDocument();
    if (kind === 'no-done') expect(screen.getByRole('button', { name: 'No completion status is configured.' })).toBeDisabled();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});

it('hides the table Columns trigger on Board while keeping the personal preference draft for Tasks', async () => {
  const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
  await user.click(await screen.findByRole('button', { name: 'Columns' }));
  await user.click(await screen.findByRole('checkbox', { name: 'Tags' })); await user.keyboard('{Escape}');
  await user.click(views().getByRole('button', { name: 'Board' }));
  expect(screen.queryByRole('button', { name: /^Columns/ })).not.toBeInTheDocument();
  await user.click(views().getByRole('button', { name: 'Tasks' }));
  await user.click(screen.getByRole('button', { name: 'Columns · unsaved' }));
  expect(screen.getByRole('checkbox', { name: 'Tags' })).not.toBeChecked(); expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it.each(['{Enter}', ' '] as const)('completes through the native keyboard action %s exactly once without opening a menu', async key => {
  let current = task; const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok(current = { ...task, statusId: DONE, revision: 2 }) }));
  const { user } = renderApp(tablePath); const button = await complete(); button.focus(); await user.keyboard(key);
  expect(await screen.findByRole('button', { name: `Reopen ${task.title}` })).toHaveFocus();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
});

it('releases a confirmed missing-required-field completion draft so inline edits and a new completion work immediately',async()=>{
 let current=task,attempts=0;const{calls}=installFakeApi(routes({[`GET ${rootPath}/tasks`]:()=>page([current]),[`PATCH ${rootPath}/tasks/${task.id}`]:(request)=>{attempts++;if(attempts===1)return json(422,{error:{code:'DOMAIN_VALIDATION_FAILED',message:'Do not retain private field text',retryable:false,details:{policyReason:'completion_fields_required'}},meta:{requestId:'missing-field'}});const input=request.body as {title?:string;statusId?:string};return ok(current={...current,...(input.title?{title:input.title}:{}),...(input.statusId?{statusId:input.statusId}:{}),revision:current.revision+1});}}));
 const{user}=renderApp(tablePath);await user.click(await complete());await screen.findByText('Could not close the task');expect(screen.queryByRole('button',{name:`Resume draft for ${task.title}`})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:`Reopen ${task.title}`})).not.toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:task.title}));const input=screen.getByLabelText('Task name');await user.clear(input);await user.type(input,'Editable after refusal{Enter}');await screen.findByRole('button',{name:'Editable after refusal'});
 await user.click(screen.getByRole('button',{name:'Mark Editable after refusal complete'}));await screen.findByRole('button',{name:'Reopen Editable after refusal'});expect(calls.filter(call=>call.method==='PATCH')).toHaveLength(3);expect(screen.queryByText('Do not retain private field text')).not.toBeInTheDocument();
});
