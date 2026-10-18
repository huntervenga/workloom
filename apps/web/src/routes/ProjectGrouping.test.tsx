import type { UserEvent } from '@testing-library/user-event';
import { chooseTimeContext, timeContextLabel } from '../features/work-categories/test/timeContext';
import type { SectionDto, TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { queryKeys } from '../lib/queryKeys';
import { lostResponse } from '../features/planning/test/fixtures';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

async function tableChoice(user: UserEvent, control: HTMLElement, value: 'section' | 'assignee' | 'manual' | 'due_asc') {
  await user.click(control);
  const name = { section: 'Section', assignee: 'Assignee', manual: 'Manual', due_asc: 'Due date' }[value];
  await user.click(within(screen.getByRole('listbox', { name: control.getAttribute('aria-label') ?? '' })).getByRole('option', { name }));
}

beforeAll(async () => { await import('./ProjectPage'); });
const SECTION = 'e1000000-0000-4000-8000-000000000001';
const NEXT = alphaMembers[1];
if (!NEXT) throw new Error('Missing next member fixture');
const OWNER = alphaMembers[0];
if (!OWNER) throw new Error('Missing owner fixture');
const sections: SectionDto[] = [{ id: SECTION, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Original section', position: 0, revision: 1, archivedAt: null }];
const parent: TaskDto = { ...task, sectionId: SECTION, responsibleMembershipId: OWNER.id, title: 'Assigned parent', estimateMinutes: 120 };
const child: TaskDto = { ...parent, id: 'f2000000-0000-4000-8000-000000000002', title: 'Other assignee child', responsibleMembershipId: NEXT.id, parentTaskId: parent.id };
const NEXT_STATUS = 'f6000000-0000-4000-8000-000000000002';
const page = (rows: TaskDto[], nextCursor: string | null = null) => json(200, { data: rows, meta: { requestId: 'grouping-fixture', nextCursor } });
function routes(extra: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => page([parent, child]),
    [`GET ${rootPath}/tasks/${parent.id}`]: () => ok(parent), [`GET ${rootPath}/tasks/${child.id}`]: () => ok(child),
    [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok(sections),
    [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([
      { id: parent.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored active', group: 'todo', position: 0, revision: 1 },
      { id: NEXT_STATUS, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored progress', group: 'in_progress', position: 1, revision: 1 },
    ]), ...extra };
}
const views = () => within(screen.getByRole('navigation', { name: 'Project views' }));
const groupControl = () => screen.getByRole('combobox', { name: 'Group by' });
const groupToggle = (name: string, collapsed = false) => screen.getByRole('button', { name: new RegExp(`^${collapsed ? 'Expand' : 'Collapse'} assignee group.*“${name}”$`) });
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET');
/** Choosing in an open custom list is the explicit save. */
const choose = (user: ReturnType<typeof renderApp>['user'], list: string, option: string) => user.click(within(screen.getByRole('listbox', { name: list })).getByRole('option', { name: option }));
const statusPicker = () => screen.getByRole('combobox', { name: 'Status' });
const assigneePicker = () => screen.getByRole('combobox', { name: 'Assignee' });

async function editAssignee(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: `Edit assignee for ${parent.title}` }));
  await choose(user, 'Assignee', NEXT.displayName);
}

describe('page-owned task grouping', () => {
  it('retains independent Section/Assignee collapse, selection and hour lens through Board and loaded pages', async () => {
    const later = { ...parent, id: 'f2000000-0000-4000-8000-000000000003', title: 'Later row', workPackageId: 'f1000000-0000-4000-8000-000000000003', estimateMinutes: 60 };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => request.searchParams.has('cursor') ? page([later]) : page([parent, child], 'next-page') }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: `Select task: ${parent.title}` }));
    expect(groupControl()).toHaveTextContent('Section');
    await chooseTimeContext(user, 'Week for hours', PERIOD_A);
    await user.click(screen.getByRole('button', { name: 'Collapse section “Original section”' }));
    await tableChoice(user, groupControl(), 'assignee');
    expect(screen.getByRole('button', { name: child.title }).closest('tr')).toHaveTextContent(`Subtask of ${parent.title}`);
    expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('2h');
    await user.click(groupToggle(OWNER.displayName));
    await user.click(views().getByRole('button', { name: 'Board' }));
    expect(screen.queryByRole('combobox', { name: 'Group by' })).not.toBeInTheDocument();
    await screen.findAllByRole('button', { name: parent.title });
    await user.click(views().getByRole('button', { name: 'Tasks' }));
    expect(groupControl()).toHaveTextContent('Assignee'); expect(groupToggle(OWNER.displayName, true)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_A)); expect(screen.getByLabelText('Whose hours to show')).toHaveTextContent(timeContextLabel('Whose hours to show', MEMBER_ID));
    await user.click(screen.getByRole('button', { name: 'Load more tasks' }));
    await waitFor(() => expect(groupToggle(OWNER.displayName, true).closest('th')).toHaveTextContent('2 tasks'));
    expect(screen.queryByRole('button', { name: later.title })).not.toBeInTheDocument();
    await tableChoice(user, groupControl(), 'section');
    expect(screen.getByRole('button', { name: 'Expand section “Original section”' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: 'Expand section “Original section”' }));
    expect(screen.getByRole('button', { name: `Select task: ${parent.title}` })).toHaveAttribute('aria-pressed', 'true');
    expect(writes(calls)).toHaveLength(0);
  });

  it('keeps an unsent Section quick draft reachable in details without duplicating quick rows', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: 'Add task to “Original section”' }));
    await user.type(screen.getByLabelText('Task name'), 'Unsent original draft');
    await tableChoice(user, groupControl(), 'assignee');
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
    const drawer = within(await screen.findByRole('dialog'));
    expect(drawer.getByLabelText('Task name')).toHaveValue('Unsent original draft');
    expect(drawer.getByLabelText('Section')).toHaveTextContent('Original section');
    expect(writes(calls)).toHaveLength(0);
  });

  it('resumes a held quick command in its original Section and retries identical bytes/key', async () => {
    const first = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi(routes({ [`POST ${rootPath}/tasks`]: () => ++attempts === 1 ? first.promise : created({ ...parent, title: 'Original quick command' }) }));
    const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: 'Add task to “Original section”' }));
    await user.type(screen.getByLabelText('Task name'), 'Original quick command');
    await user.click(within(screen.getByRole('form', { name: 'Add a task to Original section' })).getByRole('textbox', { name: 'Task name' })); await user.keyboard('{Enter}');
    await waitFor(() => expect(attempts).toBe(1)); await tableChoice(user, groupControl(), 'assignee');
    await act(async () => first.lose()); await user.click(await screen.findByRole('button', { name: 'Resume original editor' }));
    expect(groupControl()).toHaveTextContent('Section'); expect(screen.getByLabelText('Task name')).toHaveValue(''); expect(screen.getByText('Submitted task: Original quick command')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(screen.getByLabelText('Task name')).toHaveValue(''));
    const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[0]?.body).toMatchObject({ title: 'Original quick command', sectionId: SECTION });
    expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  });

  it('acknowledges current reassignment into a collapsed group without expanding it, returning focus to its disclosure', async () => {
    const gate = deferred<Response>(); let current = parent;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current, child]), [`GET ${rootPath}/tasks/${parent.id}`]: () => ok(current), [`PATCH ${rootPath}/tasks/${parent.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath); await screen.findByRole('button', { name: parent.title }); await tableChoice(user, groupControl(), 'assignee');
    await user.click(groupToggle(NEXT.displayName)); await editAssignee(user);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    await act(async () => gate.resolve(ok(current = { ...parent, responsibleMembershipId: NEXT.id, revision: 2 })));
    await screen.findByText(`Assignee saved: ${NEXT.displayName}.`);
    await waitFor(() => expect(groupToggle(NEXT.displayName, true)).toHaveFocus());
    expect(screen.queryByRole('button', { name: parent.title })).not.toBeInTheDocument();
    expect(groupToggle(NEXT.displayName, true)).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: 'Open task' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue(parent.title);
    expect(writes(calls)[0]?.body).toEqual({ expectedRevision: parent.revision, responsibleMembershipId: NEXT.id });
  });

  it.each(['grouping', 'filter', 'outside-focus', 'collapse', 'view'] as const)('does not steal focus or reopen a destination after pending reassignment and explicit %s change', async change => {
    const gate = deferred<Response>(); let current = parent;
    installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current, child]), [`PATCH ${rootPath}/tasks/${parent.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath); await screen.findByRole('button', { name: parent.title }); await tableChoice(user, groupControl(), 'assignee');
    await editAssignee(user);
    if (change === 'grouping') await tableChoice(user, groupControl(), 'section');
    else if (change === 'filter') await user.type(screen.getByLabelText('Search tasks'), 'changed scope');
    else if (change === 'outside-focus') await user.click(screen.getByLabelText('Search tasks'));
    else if (change === 'collapse') await user.click(groupToggle(OWNER.displayName));
    else await user.click(views().getByRole('button', { name: 'Board' }));
    const focused = document.activeElement;
    await act(async () => gate.resolve(ok(current = { ...parent, responsibleMembershipId: NEXT.id, revision: 2 })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume original editor' })).not.toBeInTheDocument());
    if (focused?.isConnected) expect(focused).toHaveFocus();
    else expect(document.activeElement).toBe(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    if (change !== 'outside-focus') expect(screen.queryByText(`Assignee saved: ${NEXT.displayName}.`)).not.toBeInTheDocument();
  });

  it('returns focus to a moved Board status control only after the new authoritative card is rendered', async () => {
    const response = deferred<Response>(); const list = deferred<Response>(); let readingHead = false;
    installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => readingHead ? list.promise : page([parent]), [`PATCH ${rootPath}/tasks/${parent.id}`]: () => response.promise }));
    const { user } = renderApp(`${tablePath}?view=board`);
    await user.click(await screen.findByRole('button', { name: 'Change status' }));
    await choose(user, 'Status', 'Stored progress');
    readingHead = true; await act(async () => response.resolve(ok({ ...parent, statusId: NEXT_STATUS, revision: 2 })));
    await act(async () => list.resolve(page([{ ...parent, statusId: NEXT_STATUS, revision: 2 }])));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change status' })).toHaveFocus());
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
  });

  it.each(['outside-focus', 'window-blur'] as const)('revokes inline restoration after ACK but before delayed authoritative head on %s', async revoke => {
    const response = deferred<Response>(); const list = deferred<Response>(); let readingHead = false;
    installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => readingHead ? list.promise : page([parent]), [`PATCH ${rootPath}/tasks/${parent.id}`]: () => response.promise }));
    const { user } = renderApp(`${tablePath}?view=board`);
    await user.click(await screen.findByRole('button', { name: 'Change status' }));
    await choose(user, 'Status', 'Stored progress');
    readingHead = true;
    await act(async () => response.resolve(ok({ ...parent, statusId: NEXT_STATUS, revision: 2 })));
    await waitFor(() => expect(screen.queryByLabelText('Status')).not.toBeInTheDocument());
    const search = screen.getByLabelText('Search tasks');
    if (revoke === 'outside-focus') await user.click(search); else fireEvent(window, new Event('blur'));
    await act(async () => list.resolve(page([{ ...parent, statusId: NEXT_STATUS, revision: 2 }])));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change status' })).not.toHaveFocus());
    if (revoke === 'outside-focus') expect(search).toHaveFocus();
  });

  it('keeps an uncertain assignee command exact across regrouping and confirms its remounted editor once', async () => {
    const first = lostResponse(); let attempts = 0; let current = parent;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current, child]), [`PATCH ${rootPath}/tasks/${parent.id}`]: () => ++attempts === 1 ? first.promise : ok(current = { ...parent, responsibleMembershipId: NEXT.id, revision: 2 }) }));
    const { user } = renderApp(tablePath); await screen.findByRole('button', { name: parent.title });
    await editAssignee(user); await tableChoice(user, groupControl(), 'assignee');
    await act(async () => first.lose());
    expect(assigneePicker()).toHaveTextContent(NEXT.displayName); expect(assigneePicker()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByLabelText('Assignee')).not.toBeInTheDocument());
    await screen.findByText(`Assignee saved: ${NEXT.displayName}.`);
    const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[0]?.body).toEqual({ expectedRevision: parent.revision, responsibleMembershipId: NEXT.id });
    expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
    await user.click(screen.getByRole('button', { name: `Edit assignee for ${parent.title}` }));
    await choose(user, 'Assignee', NEXT.displayName); expect(writes(calls)).toHaveLength(2);
  });


  it.each(['newer', 'removed', 'archived'] as const)('does not announce or focus an obsolete reassignment when the authoritative head is %s', async kind => {
    const response = deferred<Response>(); const list = deferred<Response>(); let readingHead = false;
    installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => readingHead ? list.promise : page([parent, child]), [`PATCH ${rootPath}/tasks/${parent.id}`]: () => response.promise }));
    const { user } = renderApp(tablePath); await screen.findByRole('button', { name: parent.title }); await tableChoice(user, groupControl(), 'assignee');
    await user.click(groupToggle(NEXT.displayName)); await editAssignee(user);
    readingHead = true;
    const receipt = { ...parent, responsibleMembershipId: NEXT.id, revision: 2 };
    await act(async () => response.resolve(ok(receipt)));
    expect(screen.queryByText(`Assignee saved: ${NEXT.displayName}.`)).not.toBeInTheDocument();
    const newer = kind === 'archived' ? { ...receipt, archivedAt: parent.createdAt } : { ...receipt, responsibleMembershipId: OWNER.id, revision: 3 };
    await act(async () => list.resolve(page(kind === 'removed' ? [child] : [newer, child])));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume original editor' })).not.toBeInTheDocument());
    expect(screen.queryByText(`Assignee saved: ${NEXT.displayName}.`)).not.toBeInTheDocument();
    expect(groupToggle(NEXT.displayName, true)).not.toHaveFocus();
    expect(groupToggle(NEXT.displayName, true)).toHaveAttribute('aria-expanded', 'false');
  });

  it('allows viewer grouping without mutation controls and resets an unmounted personal presentation', async () => {
    const { calls } = installFakeApi(routes({ 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }) }));
    const first = renderApp(tablePath); await screen.findByRole('button', { name: parent.title });
    await tableChoice(first.user, groupControl(), 'assignee');
    expect(screen.queryByRole('button', { name: `Edit assignee for ${parent.title}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add task to “Original section”' })).not.toBeInTheDocument();
    first.unmount(); renderApp(tablePath); await screen.findByRole('button', { name: parent.title });
    expect(groupControl()).toHaveTextContent('Section'); expect(writes(calls)).toHaveLength(0);
  });


  it('autosaves a rich description before another grouping opens its independent assignee cell', async () => {
    let current = parent;
    const { calls } = installFakeApi(routes({
      [`GET ${rootPath}/tasks`]: () => page([current, child]),
      [`GET ${rootPath}/tasks/${parent.id}`]: () => ok(current),
      [`PATCH ${rootPath}/tasks/${parent.id}`]: () => ok(current = { ...parent, description: 'Retained rich description', revision: parent.revision + 1 }),
    }));
    const { user, queryClient } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: `Open task “${parent.title}”` }));
    const drawer = within(await screen.findByRole('dialog'));
    await user.type(drawer.getByLabelText('Description'), 'Retained rich description');
    await user.click(drawer.getByLabelText('Close', { selector: 'button' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toEqual({ expectedRevision: parent.revision, description: 'Retained rich description' });
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.task(anna.id, alpha.id, parent.id))).toMatchObject({ revision: parent.revision + 1, description: 'Retained rich description' }));
    await tableChoice(user, groupControl(), 'assignee');
    await user.click(screen.getByRole('button', { name: `Edit assignee for ${parent.title}` }));
    expect(assigneePicker()).toHaveTextContent(OWNER.displayName);
    expect(screen.queryByRole('button', { name: 'Resume draft' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: `Open task “${parent.title}”` }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Description')).toHaveValue('Retained rich description');
    expect(writes(calls)).toHaveLength(1);
  });

  it.each(['same-editor', 'view-hop'] as const)('reconciles the original session without stale notice/focus after pending %s replacement', async replacement => {
    const gate = deferred<Response>(); let current = parent;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current, child]), [`PATCH ${rootPath}/tasks/${parent.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath); await screen.findByRole('button', { name: parent.title }); await tableChoice(user, groupControl(), 'assignee');
    await editAssignee(user);
    if (replacement === 'same-editor') {
      // A pending choice has no collapse control; hiding its group unmounts and remounts the same editor.
      await user.click(groupToggle(OWNER.displayName)); expect(screen.queryByRole('combobox', { name: 'Assignee' })).not.toBeInTheDocument();
      await user.click(groupToggle(OWNER.displayName, true));
    } else {
      await user.click(views().getByRole('button', { name: 'Board' }));
      await user.click(views().getByRole('button', { name: 'Tasks' }));
      await user.click(screen.getByRole('button', { name: `Edit assignee for ${parent.title}` }));
    }
    expect(assigneePicker()).toBeDisabled(); expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    const search = screen.getByLabelText('Search tasks'); await user.click(search);
    await act(async () => gate.resolve(ok(current = { ...parent, responsibleMembershipId: NEXT.id, revision: 2 })));
    await waitFor(() => expect(assigneePicker()).toBeEnabled());
    expect(assigneePicker()).toHaveTextContent(NEXT.displayName); expect(search).toHaveFocus();
    expect(screen.queryByText(`Assignee saved: ${NEXT.displayName}.`)).not.toBeInTheDocument();
    await user.click(assigneePicker()); await choose(user, 'Assignee', NEXT.displayName); expect(writes(calls)).toHaveLength(1);
  });


  it('reconciles an original Board status editor already unmounted by an authoritative lane move before its held ACK', async () => {
    const gate = deferred<Response>(); let current = parent;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${parent.id}`]: () => gate.promise }));
    const { user, queryClient } = renderApp(`${tablePath}?view=board`);
    await user.click(await screen.findByRole('button', { name: 'Change status' }));
    const original = statusPicker();
    await choose(user, 'Status', 'Stored progress');
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    // The server has committed; a legitimate refreshed read can observe it before
    // the browser receives the held original write receipt.
    current = { ...parent, statusId: NEXT_STATUS, revision: 2 };
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(anna.id, alpha.id) }); });
    await waitFor(() => expect(original.isConnected).toBe(false));
    expect(statusPicker()).toBeDisabled();
    await act(async () => gate.resolve(ok(current)));
    await waitFor(() => expect(screen.queryByLabelText('Status')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change status' })).toHaveFocus());
    expect(writes(calls)).toHaveLength(1);
  });

});
