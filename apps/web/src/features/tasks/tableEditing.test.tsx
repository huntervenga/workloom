import type { CreateTaskInput, TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, failure, installFakeApi, ok, project } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, rootPath, task } from '../planning/test/fixtures';
import { InlineTaskEdit, type InlineCloseReason } from './InlineTaskEdit';
import { QuickTaskAdd } from './QuickTaskAdd';
import { TaskDrawer } from './TaskDrawer';
import { draftFromTask, emptyDraft } from './taskDraft';
import { canResumeQuickSession, freshQuickSession, nextQuickRequest, quickDraftChanges, quickSessionHasValues, type TaskInlineField } from './tableEditing';
import { resolveQuickCreateInput, useTaskCommands, type CreateRequest, type CreateResultAnchor, type CreateSession, type EditSession, type TaskCommands } from './useTaskCommands';

const SECTION = 'e1000000-0000-4000-8000-000000000001';
const STATUS_PROGRESS = 'f6000000-0000-4000-8000-000000000002';
const statuses: TaskStatusDto[] = [
  { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 },
  { id: STATUS_PROGRESS, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored progress', group: 'in_progress', position: 1, revision: 1 },
];

function quick(seed?: CreateSession, request?: CreateRequest) {
  const onCreated = vi.fn(); const onMoreDetails = vi.fn(); const onClosed = vi.fn();
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState(() => { if (seed) commands.createSession.current = seed; return true; });
    return <>{open ? <QuickTaskAdd projectId={PROJECT_ID} sectionId={SECTION} sectionName="Stored section" statuses={statuses} commands={commands} writable request={request} onClose={reason => { onClosed(reason); setOpen(false); }} onMoreDetails={onMoreDetails} onCreated={onCreated} /> : null}<button onClick={() => setOpen(true)}>Resume QA create</button><button>Outside focus</button></>;
  }
  const view = renderFieldUi(<Example />);
  return { ...view, onCreated, onMoreDetails, onClosed, commands: () => { if (!current) throw new Error('No command harness'); return current; } };
}

function inline(field: TaskInlineField, seed?: EditSession, source: TaskDto = task) {
  const onSaved = vi.fn(); const onMoreDetails = vi.fn(); const onClosed = vi.fn<(reason?: InlineCloseReason) => void>();
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState(() => { if (seed) commands.editSessions.current.set(source.id, seed); return true; });
    return <>{open ? <InlineTaskEdit task={source} field={field} statuses={statuses} members={alphaMembers} commands={commands} writable onClose={reason => { onClosed(reason); setOpen(false); }} onMoreDetails={onMoreDetails} onSaved={onSaved} /> : null}<button onClick={() => setOpen(true)}>Resume QA cell</button><button onClick={() => setOpen(false)}>Hide QA cell</button><button>Outside focus</button></>;
  }
  const view = renderFieldUi(<Example />);
  return { ...view, onSaved, onMoreDetails, onClosed, commands: () => { if (!current) throw new Error('No command harness'); return current; } };
}

function drawer(mode: 'create' | 'edit') {
  const onCreated = vi.fn(); const onAnnounce = vi.fn();
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState(true);
    return <>{open ? <TaskDrawer actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Stored project')} sections={[]} statuses={statuses} members={alphaMembers} tags={[]} writable commands={commands} taskId={mode === 'edit' ? task.id : null} creating={mode === 'create' ? { sectionId: SECTION, parent: null } : null} onClose={() => setOpen(false)} onOpenTask={vi.fn()} onResumeCreate={vi.fn()} onCreated={onCreated} onAnnounce={onAnnounce} /> : null}<button onClick={() => setOpen(true)}>Resume QA drawer</button><button>Outside focus</button></>;
  }
  const view = renderFieldUi(<Example />);
  return { ...view, onCreated, onAnnounce, commands: () => { if (!current) throw new Error('No command harness'); return current; } };
}

function lost() {
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Response>((_resolve, fail) => { reject = fail; });
  return { promise, lose: () => reject(new TypeError('Failed to fetch')) };
}

function assertExactRetry(calls: { body: unknown; headers: Headers }[]) {
  expect(calls).toHaveLength(2);
  expect(calls[0]?.body).toEqual(calls[1]?.body);
  expect(calls[0]?.headers.get('Idempotency-Key')).toBeTruthy();
  expect(calls[0]?.headers.get('Idempotency-Key')).toBe(calls[1]?.headers.get('Idempotency-Key'));
}

/** The next unsent title is always editable; the sent session is held by the owner. */
function expectNextTitle(input: HTMLElement, value = '') {
  expect(input).toHaveValue(value);
  expect(input).not.toHaveAttribute('readonly');
  expect(input).not.toHaveAttribute('aria-disabled');
}

/** An explicitly opened choice cell shows its custom list at once; a choice is the save. */
async function choose(user: ReturnType<typeof renderFieldUi>['user'], option: string) {
  await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
}

describe('section quick creation', () => {
  it('clears the next input before the ACK and serializes explicitly queued titles without clearing newer text', async () => {
    const response = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => (request.body as { title: string }).title === 'Quick task' ? response.promise : created({ ...task, id: 'f2000000-0000-4000-8000-000000000102', sectionId: SECTION, title: 'Queued second task' }) });
    const ui = quick();
    const input = screen.getByLabelText('Task name');
    expect(input).toHaveFocus();
    expect(document.querySelector('select')).toBeNull();
    await ui.user.type(input, '  Quick task  ');
    expect(calls).toHaveLength(0);
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION, title: 'Quick task', statusId: task.statusId });
    expect(ui.onCreated).not.toHaveBeenCalled();
    expectNextTitle(input);
    expect(input).toHaveFocus();
    await ui.user.type(input, 'Queued second task{Enter}Third unsent title');
    expect(calls).toHaveLength(1);
    expect(ui.commands().createSession.current?.draft.title).toBe('  Quick task  ');
    expect(ui.commands().quick.queue.map(entry => entry.session.draft.title)).toEqual(['  Quick task  ', 'Queued second task']);
    await act(async () => response.resolve(created({ ...task, sectionId: SECTION, title: 'Quick task' })));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(2));
    expectNextTitle(screen.getByLabelText('Task name'), 'Third unsent title');
    expect(screen.getByLabelText('Task name')).toHaveFocus();
    expect(ui.commands().createSession.current?.draft.title).toBe('Third unsent title');
    expect(calls.map(call => (call.body as { title: string }).title)).toEqual(['Quick task', 'Queued second task']);
    expect(calls[1]?.headers.get('Idempotency-Key')).not.toBe(calls[0]?.headers.get('Idempotency-Key'));
  });

  it('adds several tasks with Enter only, each once with its own key, while blank Enter creates nothing and keeps focus', async () => {
    let next = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => created({ ...task, id: `f2000000-0000-4000-8000-00000000010${++next}`, sectionId: SECTION, title: (request.body as { title: string }).title }) });
    const ui = quick();
    const input = screen.getByLabelText('Task name');
    for (const title of ['First fast task', 'Second fast task']) {
      await ui.user.type(input, `${title}{Enter}`);
      await waitFor(() => expect(input).toHaveValue(''));
      expect(input).toHaveFocus();
    }
    await ui.user.keyboard('{Enter}');
    await ui.user.type(input, '   {Enter}');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls.map(call => (call.body as { title: string }).title)).toEqual(['First fast task', 'Second fast task']);
    expect(new Set(calls.map(call => call.headers.get('Idempotency-Key'))).size).toBe(2);
    expect(ui.onCreated).toHaveBeenCalledTimes(2);
    expect(ui.onClosed).not.toHaveBeenCalled();
  });

  it('closes an untouched row when focus leaves, keeps a typed draft uncreated while focused, and discards it on Escape', async () => {
    const { calls } = installFakeApi({});
    const ui = quick();
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('blur'));
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA create' }));
    await ui.user.type(screen.getByLabelText('Task name'), 'Typed but not sent');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(screen.getByLabelText('Task name')).toHaveValue('Typed but not sent');
    expect(ui.onClosed).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    await ui.user.keyboard('{Escape}');
    expect(ui.onClosed).toHaveBeenLastCalledWith('cancel');
    // Escape is the explicit discard of a never-sent draft: nothing keeps or brings it back.
    expect(ui.commands().createSession.current).toBeNull();
    expect(ui.commands().quick.draft).toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA create' }));
    expectNextTitle(screen.getByLabelText('Task name'));
    expect(screen.queryByRole('button', { name: 'Resume draft' })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('retains an escaped draft and retries an unknown create with its original values and key after reopening', async () => {
    const first = lost(); let attempt = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: () => ++attempt === 1 ? first.promise : created({ ...task, sectionId: SECTION, title: 'Original quick draft' }) });
    const ui = quick();
    await ui.user.type(screen.getByLabelText('Task name'), 'Original quick draft');
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(attempt).toBe(1));
    await act(async () => first.lose());
    await screen.findByRole('button', { name: 'Retry original' });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More details' })).toBeDisabled();
    await ui.user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA create' }));
    expectNextTitle(screen.getByLabelText('Task name'));
    expect(ui.commands().createSession.current?.draft.title).toBe('Original quick draft');
    await ui.user.click(screen.getByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    assertExactRetry(calls);
  });

  it('clears a late confirmed draft without reopening the editor or taking outside focus', async () => {
    const response = deferred<Response>();
    installFakeApi({ [`POST ${rootPath}/tasks`]: () => response.promise });
    const ui = quick();
    await ui.user.type(screen.getByLabelText('Task name'), 'Late confirmation');
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(ui.commands().create.pendingCommand).not.toBeNull());
    await ui.user.click(screen.getByRole('button', { name: 'Collapse editor' }));
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => response.resolve(created({ ...task, sectionId: SECTION, title: 'Late confirmation' })));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
    expect(ui.commands().createSession.current).toBeNull();
  });

  it('does not take focus back when a pending create confirms after the person moved elsewhere', async () => {
    const response = deferred<Response>();
    installFakeApi({ [`POST ${rootPath}/tasks`]: () => response.promise });
    const ui = quick();
    await ui.user.type(screen.getByLabelText('Task name'), 'Moved away{Enter}');
    await waitFor(() => expect(ui.commands().create.pendingCommand).not.toBeNull());
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => response.resolve(created({ ...task, sectionId: SECTION, title: 'Moved away' })));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
  });

  it('reconciles a reopened pending create after confirmation without allowing a duplicate or stealing focus', async () => {
    const response = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: () => response.promise });
    const ui = quick();
    await ui.user.type(screen.getByLabelText('Task name'), 'Pending remount create');
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(ui.commands().create.pendingCommand).not.toBeNull());
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA create' }));
    expectNextTitle(screen.getByLabelText('Task name'));
    expect(ui.commands().createSession.current?.draft.title).toBe('Pending remount create');
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => response.resolve(created({ ...task, title: 'Pending remount create' })));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Task name')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
    expect(ui.commands().createSession.current).toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(calls).toHaveLength(1);
  });

  it('holds queued creates behind an unknown response, keeps them exact across Escape and remount, and discards only the unsent title', async () => {
    const first = lost(); let attempt = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => ++attempt === 1 ? first.promise : created({ ...task, title: (request.body as { title: string }).title }) });
    const ui = quick();
    await ui.user.type(screen.getByLabelText('Task name'), 'First unknown{Enter}Second queued{Enter}Third unsent');
    expect(calls).toHaveLength(1);
    await act(async () => first.lose());
    await screen.findByRole('button', { name: 'Retry original' });
    expect(calls).toHaveLength(1);
    expect(ui.commands().quick.queue.map(entry => entry.input.title)).toEqual(['First unknown', 'Second queued']);
    await ui.user.keyboard('{Escape}');
    // Only the never-sent third title is gone; the unknown front and the queued follower stay as sent.
    expect(ui.commands().quick.queue.map(entry => entry.input.title)).toEqual(['First unknown', 'Second queued']);
    expect(ui.commands().createSession.current?.draft.title).toBe('First unknown');
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA create' }));
    expectNextTitle(screen.getByLabelText('Task name'));
    await ui.user.click(screen.getByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(2));
    expect(calls).toHaveLength(3);
    assertExactRetry(calls.slice(0, 2));
    expect(calls[2]?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION, title: 'Second queued', statusId: task.statusId });
    expect(calls[2]?.headers.get('Idempotency-Key')).not.toBe(calls[0]?.headers.get('Idempotency-Key'));
    expectNextTitle(screen.getByLabelText('Task name'));
    expect(ui.onCreated).toHaveBeenCalledTimes(2);
  });

  it('keeps a definitely rejected front for explicit retry or discard and never drops the next typed title', async () => {
    let attempt = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => ++attempt === 1 ? failure(409, 'REVISION_CONFLICT', 'private') : created({ ...task, title: (request.body as { title: string }).title }) });
    const ui = quick();
    await ui.user.type(screen.getByLabelText('Task name'), 'Rejected first{Enter}Replacement unsent');
    await screen.findByRole('button', { name: 'Discard rejected task' });
    expect(calls).toHaveLength(1);
    expectNextTitle(screen.getByLabelText('Task name'), 'Replacement unsent');
    await ui.user.click(screen.getByRole('button', { name: 'Discard rejected task' }));
    expect(ui.commands().quick.queue).toHaveLength(0);
    expect(ui.commands().createSession.current?.draft.title).toBe('Replacement unsent');
    await ui.user.click(screen.getByLabelText('Task name')); await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(calls.map(call => (call.body as { title: string }).title)).toEqual(['Rejected first', 'Replacement unsent']);
  });

  it.each([
    ['richer', { title: 'Rich draft', description: 'Kept description', estimate: '2:00' }],
    ['assignee or date', { title: 'Earlier quick draft', responsibleMembershipId: alphaMembers[1]?.id ?? null, dueDate: '2026-10-20' }],
  ] as const)('offers a %s create draft for resumption without changing it or sending a title-only create', async (_kind, patch) => {
    const { calls } = installFakeApi({});
    const seed: CreateSession = { request: { sectionId: SECTION, parent: null }, workScope: 'detail', origin: 'quick', draft: { ...emptyDraft(task.statusId, SECTION), ...patch } };
    const ui = quick(seed);
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume draft' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(ui.commands().createSession.current).toEqual(seed);
    expect(calls).toHaveLength(0);
  });
});

describe('quick create row context', () => {
  const GROUP_MEMBER = alphaMembers[1]?.id ?? 'missing-member';
  const OTHER_MEMBER = alphaMembers[0]?.id ?? 'missing-member';
  const inGroup = (responsible: string | null): CreateRequest => ({ sectionId: SECTION, parent: null, defaultResponsibleMembershipId: responsible });

  it('starts a group row with that group’s assignee as its pristine baseline, and counts only the person’s own change', () => {
    const fresh = freshQuickSession(SECTION, task.statusId, inGroup(GROUP_MEMBER));
    expect(fresh.draft.responsibleMembershipId).toBe(GROUP_MEMBER);
    expect(quickDraftChanges(fresh)).toEqual([]);
    expect(quickSessionHasValues(fresh)).toBe(false);
    const unassigned = { ...fresh, draft: { ...fresh.draft, responsibleMembershipId: null } };
    expect(quickDraftChanges(unassigned)).toEqual(['responsibleMembershipId']);
    expect(quickSessionHasValues(unassigned)).toBe(true);
    // Without a group nothing is invented, and an explicit Unassigned group starts unassigned.
    expect(freshQuickSession(SECTION, task.statusId).draft.responsibleMembershipId).toBeNull();
    expect(quickSessionHasValues(freshQuickSession(SECTION, task.statusId, inGroup(null)))).toBe(false);
  });

  it('resumes a group draft only in the same group row, never retargeting it to another group or the plain section', () => {
    const typed = freshQuickSession(SECTION, task.statusId, inGroup(GROUP_MEMBER));
    const draft = { ...typed, draft: { ...typed.draft, title: 'Group draft' } };
    expect(canResumeQuickSession(draft, SECTION, inGroup(GROUP_MEMBER))).toBe(true);
    expect(canResumeQuickSession(draft, SECTION, inGroup(OTHER_MEMBER))).toBe(false);
    expect(canResumeQuickSession(draft, SECTION, inGroup(null))).toBe(false);
    expect(canResumeQuickSession(draft, SECTION)).toBe(false);
  });

  it('sends the group’s assignee in the body as the draft’s own value and never the row-local context', async () => {
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => created({ ...task, sectionId: SECTION, responsibleMembershipId: GROUP_MEMBER, title: (request.body as { title: string }).title }) });
    const ui = quick(undefined, inGroup(GROUP_MEMBER));
    // Untouched, the group default is no draft: leaving closes the row and protects nothing.
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('blur'));
    expect(ui.commands().createSession.current).toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA create' }));
    await ui.user.type(screen.getByLabelText('Task name'), 'Grouped task{Enter}');
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION, title: 'Grouped task', statusId: task.statusId, responsibleMembershipId: GROUP_MEMBER });
  });

  it('chains a first child without an anchor: its body has no place, each next one waits for and follows the confirmed child', () => {
    const parent: TaskDto = { ...task, sectionId: SECTION };
    const body = (title: string): CreateTaskInput => ({ projectId: PROJECT_ID, sectionId: SECTION, parentTaskId: parent.id, workScope: 'detail', title, statusId: task.statusId });
    const first = freshQuickSession(null, task.statusId, { sectionId: null, parent, continueInPlace: true });
    expect(first.request.sectionId).toBe(SECTION);
    expect(resolveQuickCreateInput({ session: first, input: body('First child') })).toEqual(body('First child'));
    const anchor: CreateResultAnchor = { taskId: null };
    const second = freshQuickSession(null, task.statusId, nextQuickRequest(first.request, anchor));
    expect(resolveQuickCreateInput({ session: second, input: body('Second child') })).toBeNull();
    anchor.taskId = 'f2000000-0000-4000-8000-0000000000c9';
    expect(resolveQuickCreateInput({ session: second, input: body('Second child') })).toEqual({ ...body('Second child'), insertion: { anchorTaskId: anchor.taskId, placement: 'after' } });
    // The section's bottom row keeps adding at the end instead of chaining.
    const bottom = freshQuickSession(SECTION, task.statusId);
    expect(resolveQuickCreateInput({ session: freshQuickSession(SECTION, task.statusId, nextQuickRequest(bottom.request, anchor)), input: body('Bottom') })).toEqual(body('Bottom'));
    // A first-child draft belongs to that continuation only.
    const typed = { ...first, draft: { ...first.draft, title: 'Typed child' } };
    expect(canResumeQuickSession(typed, null, { sectionId: null, parent, continueInPlace: true })).toBe(true);
    expect(canResumeQuickSession(typed, null, { sectionId: null, parent })).toBe(false);
  });
});

describe('immediate inline choices', () => {
  it.each([
    ['statusId', 'Stored progress', { statusId: STATUS_PROGRESS }],
    ['responsibleMembershipId', 'Unassigned', { responsibleMembershipId: null }],
    ['priority', 'High', { priority: 'high' }],
  ] as const)('opens a custom %s list at once and saves only the explicit choice with the original revision', async (field, option, patch) => {
    const gate = deferred<Response>();
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise });
    const ui = inline(field);
    expect(document.querySelector('select')).toBeNull();
    const list = screen.getByRole('listbox');
    expect(list.closest('form')).toBeNull();
    expect(calls).toHaveLength(0);
    await choose(ui.user, option);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ expectedRevision: task.revision, ...patch });
    expect(screen.getByRole('combobox', { name: field === 'statusId' ? 'Status' : field === 'priority' ? 'Priority' : 'Assignee' })).toBeDisabled();
    expect(screen.getByRole('form')).toHaveAttribute('aria-busy', 'true');
    expect(ui.onSaved).not.toHaveBeenCalled();
    await act(async () => gate.resolve(ok({ ...task, ...patch, revision: task.revision + 1 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
  });

  it('closes on Escape without a write and returns the close to the cell; choosing the current value writes nothing', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('statusId');
    await ui.user.keyboard('{ArrowDown}{Escape}');
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('cancel'));
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' }));
    await choose(ui.user, 'Stored todo');
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledTimes(2));
    expect(calls).toHaveLength(0);
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
  });

  it('keeps an unknown update locked and retries exactly after Escape and reopen', async () => {
    const first = lost(); let attempt = 0;
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempt === 1 ? first.promise : ok({ ...task, statusId: STATUS_PROGRESS, revision: 2 }) });
    const ui = inline('statusId');
    await choose(ui.user, 'Stored progress');
    await waitFor(() => expect(attempt).toBe(1));
    await act(async () => first.lose());
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry.closest('form')).toBe(screen.getByRole('form'));
    expect(retry.closest('[data-cell-popover]')).not.toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Hide QA cell' }));
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeDisabled();
    expect(screen.getByLabelText('Status')).toHaveTextContent('Stored progress');
    expect(screen.getByRole('button', { name: 'More details' })).toBeDisabled();
    await ui.user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    assertExactRetry(calls);
  });

  it.each([false, true])('reconciles a reopened pending cell to its confirmed revision without saving the old choice again (retry: %s)', async retry => {
    const response = deferred<Response>();
    const first = lost(); let attempts = 0;
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempts === 1 && retry ? first.promise : response.promise });
    const ui = inline('statusId');
    await choose(ui.user, 'Stored progress');
    await waitFor(() => expect(ui.commands().update.pendingCommand).not.toBeNull());
    if (retry) {
      await act(async () => first.lose());
      await ui.user.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(calls).toHaveLength(2));
    }
    await ui.user.click(screen.getByRole('button', { name: 'Hide QA cell' }));
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' }));
    expect(screen.getByLabelText('Status')).toBeDisabled();
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => response.resolve(ok({ ...task, statusId: STATUS_PROGRESS, revision: task.revision + 1 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Status')).toHaveTextContent('Stored progress');
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
    expect(ui.onClosed).not.toHaveBeenCalled();
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
    await ui.user.click(screen.getByLabelText('Status'));
    await choose(ui.user, 'Stored progress');
    expect(calls).toHaveLength(retry ? 2 : 1);
    if (retry) assertExactRetry(calls);
  });

  it('refuses richer or different-cell drafts and leaves all of their values intact', async () => {
    const { calls } = installFakeApi({});
    const seed: EditSession = { base: task, draft: { ...draftFromTask(task), description: 'Unsaved drawer content', dueDate: '2026-10-20' }, inlineField: 'dueDate' };
    const ui = inline('statusId', seed);
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume draft' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(ui.commands().editSessions.current.get(task.id)).toEqual(seed);
    expect(calls).toHaveLength(0);
  });

  it('preserves a rejected stale choice and requires explicit details review instead of adopting a new revision', async () => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(409, 'REVISION_CONFLICT', 'private server internals') });
    const ui = inline('statusId');
    await choose(ui.user, 'Stored progress');
    await waitFor(() => expect(ui.commands().update.error).not.toBeNull());
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByLabelText('Status')).toHaveTextContent('Stored progress');
    expect(screen.getByLabelText('Status')).toBeDisabled();
    expect(ui.commands().editSessions.current.get(task.id)?.base.revision).toBe(task.revision);
    expect(screen.queryByText('private server internals')).not.toBeInTheDocument();
    expect(calls).toHaveLength(1);
    await ui.user.click(screen.getByRole('button', { name: 'More details' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('does not close another view or steal focus after a hidden pending choice confirms', async () => {
    const response = deferred<Response>();
    installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => response.promise });
    const ui = inline('statusId');
    await choose(ui.user, 'Stored progress');
    await waitFor(() => expect(ui.commands().update.pendingCommand).not.toBeNull());
    await ui.user.click(screen.getByRole('button', { name: 'Hide QA cell' }));
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => response.resolve(ok({ ...task, statusId: STATUS_PROGRESS, revision: 2 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(ui.onClosed).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
  });
});

describe('inline text commits', () => {
  it.each([
    ['title', { title: 'Renamed task' }],
    ['dueDate', { dueDate: '2026-10-20' }],
    ['estimate', { estimateMinutes: 90 }],
  ] as const)('commits %s when focus leaves the editor, with only that field and the original revision', async (field, patch) => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: request => ok({ ...task, ...(request.body as object), revision: task.revision + 1 }) });
    const packages = new Map([[task.workPackageId, { workPackageId: task.workPackageId, revision: task.workPackageRevision, estimate: { status: 'estimated' as const, minutes: task.estimateMinutes ?? 0 }, taskIds: [task.id] }]]);
    const onSaved = vi.fn();
    function Example() {
      const commands = useTaskCommands(anna.id, alpha.id);
      const [open, setOpen] = useState(true);
      return <>{open ? <InlineTaskEdit task={task} field={field} statuses={statuses} members={alphaMembers} commands={commands} writable estimatePackages={packages} onClose={() => setOpen(false)} onMoreDetails={vi.fn()} onSaved={onSaved} /> : null}<button>Outside focus</button></>;
    }
    const ui = renderFieldUi(<Example />);
    if (field === 'title') { await ui.user.clear(screen.getByLabelText('Task name')); await ui.user.type(screen.getByLabelText('Task name'), '  Renamed task  '); }
    else if (field === 'dueDate') fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-20' } });
    else { await ui.user.clear(screen.getByLabelText('Team estimate (hours)')); await ui.user.type(screen.getByLabelText('Team estimate (hours)'), '1:30'); }
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as Record<string, unknown>;
    if (field === 'estimate') expect(body).toMatchObject({ estimateMinutes: 90 });
    else expect(body).toEqual({ expectedRevision: task.revision, ...patch });
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
  });

  it('closes an untouched text editor on blur without a write, keeping outside focus', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('dueDate');
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('blur'));
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
    expect(calls).toHaveLength(0);
  });

  it('discards an unsent single-field text buffer on Escape and reopens the unchanged original revision', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('title');
    fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Kept title draft' } });
    await ui.user.keyboard('{Escape}');
    expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('cancel');
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' }));
    expect(screen.getByLabelText('Task name')).toHaveValue(task.title);
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
    expect(ui.commands().update.pendingCommand).toBeNull();
    expect(ui.commands().update.uncertain).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('rejects a due date before the current start without sending or changing the original date', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('dueDate', undefined, { ...task, startDate: '2026-10-19' });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-18' } });
    await ui.user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Due date must be on or after the start date.');
    expect(screen.getByLabelText('Due date')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert').closest('[data-cell-popover]')).not.toBeNull();
    // Leaving an invalid draft keeps it and its explanation instead of closing or sending it.
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(screen.getByLabelText('Due date')).toHaveValue('2026-10-18');
    expect(ui.onClosed).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(task.dueDate).toBeNull();
  });
});

describe('authoritative task write rejection', () => {
  it.each([{ status: 409, code: 'DEPENDENCY_BLOCKED' }, { status: 409, code: 'FIELD_LOCKED' }, { status: 403, code: 'FORBIDDEN' }])('retains the original choice after $code without claiming success or retrying automatically', async ({ status, code }) => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(status, code, 'sensitive rejection details') });
    const ui = inline('statusId');
    await choose(ui.user, 'Stored progress');
    await waitFor(() => expect(ui.commands().update.error).not.toBeNull());
    expect(ui.onSaved).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(ui.commands().editSessions.current.get(task.id)?.draft.statusId).toBe(STATUS_PROGRESS);
    expect(ui.commands().editSessions.current.get(task.id)?.base.revision).toBe(task.revision);
    expect(screen.queryByText('sensitive rejection details')).not.toBeInTheDocument();
    if (status === 403) expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'More details' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });
});

describe('full drawer confirmation identity', () => {
  it.each(['create', 'edit'] as const)('reconciles a reopened pending rich %s without late navigation or a second write', async mode => {
    const response = deferred<Response>();
    const { calls } = installFakeApi({
      [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task),
      [`POST ${rootPath}/tasks`]: () => response.promise,
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => response.promise,
    });
    const ui = drawer(mode);
    const name = await screen.findByLabelText('Task name');
    if (mode === 'create') {
      await ui.user.clear(name);
      await ui.user.type(name, 'Rich pending title');
      await ui.user.type(screen.getByLabelText('Description'), 'Kept rich description');
      await ui.user.click(screen.getByRole('button', { name: 'Create task' }));
    } else {
      // Stage both fields without a blur; the saved pane's explicit shortcut flushes one rich body.
      fireEvent.change(name, { target: { value: 'Rich pending title' } });
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Kept rich description' } });
      fireEvent.keyDown(screen.getByLabelText('Task name'), { key: 'Enter', ctrlKey: true });
    }
    await waitFor(() => expect(mode === 'create' ? ui.commands().create.pendingCommand : ui.commands().update.pendingCommand).not.toBeNull());
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA drawer' }));
    expect(await screen.findByLabelText('Task name')).toHaveValue('Rich pending title');
    if (mode === 'create') expect(screen.getByLabelText('Task name')).toBeDisabled();
    else {
      expect(screen.getByLabelText('Task name')).toBeEnabled();
      expect(calls.filter(call => call.method === 'PATCH')[0]?.body).toEqual({ expectedRevision: task.revision, title: 'Rich pending title', description: 'Kept rich description' });
    }
    await act(async () => response.resolve(mode === 'create' ? created({ ...task, title: 'Rich pending title', description: 'Kept rich description' }) : ok({ ...task, title: 'Rich pending title', description: 'Kept rich description', revision: task.revision + 1 })));
    await waitFor(() => expect(mode === 'create' ? ui.commands().create.pendingCommand : ui.commands().update.pendingCommand).toBeNull());
    expect(screen.getByLabelText('Task name')).toHaveValue(mode === 'create' ? '' : 'Rich pending title');
    expect(ui.onCreated).not.toHaveBeenCalled();
    expect(ui.commands().createSession.current).toBeNull();
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
    if (mode === 'create') await ui.user.click(screen.getByRole('button', { name: 'Create task' }));
    else fireEvent.keyDown(screen.getByLabelText('Task name'), { key: 'Enter', ctrlKey: true });
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });

  it('confirms an old create exactly once while preserving an independent create and edit session', async () => {
    const response = deferred<Response>();
    installFakeApi({ [`POST ${rootPath}/tasks`]: () => response.promise });
    const ui = quick();
    await ui.user.type(screen.getByLabelText('Task name'), 'Original sent title');
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(ui.commands().create.pendingCommand).not.toBeNull());
    const submitted = ui.commands().createSession.current;
    if (!submitted) throw new Error('Missing sent session');
    await ui.user.keyboard('{Escape}');
    const independentCreate: CreateSession = { request: { sectionId: null, parent: null }, workScope: 'detail', draft: { ...emptyDraft(task.statusId, null), title: 'Independent rich draft', description: 'Keep me' } };
    const independentEdit: EditSession = { base: task, draft: { ...draftFromTask(task), title: 'Independent edit draft' } };
    ui.commands().createSession.current = independentCreate;
    ui.commands().editSessions.current.set(task.id, independentEdit);
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    const confirmed = { ...task, title: 'Original sent title' };
    await act(async () => response.resolve(created(confirmed)));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(ui.commands().createSession.current).toBe(independentCreate);
    expect(ui.commands().editSessions.current.get(task.id)).toBe(independentEdit);
    expect(ui.commands().confirmedSessions.current.get(submitted)).toEqual(confirmed);
    let duplicate = true;
    act(() => { duplicate = ui.commands().confirmSession(submitted, confirmed); });
    expect(duplicate).toBe(false);
    expect(ui.onCreated).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
  });
});

it('preserves an independent replacement edit draft when an old pending inline choice confirms', async () => {
  const response = deferred<Response>();
  installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => response.promise });
  const ui = inline('statusId');
  await choose(ui.user, 'Stored progress');
  await waitFor(() => expect(ui.commands().update.pendingCommand).not.toBeNull());
  await ui.user.click(screen.getByRole('button', { name: 'Hide QA cell' }));
  const independent: EditSession = { base: task, draft: { ...draftFromTask(task), description: 'Independent replacement' } };
  ui.commands().editSessions.current.set(task.id, independent);
  await act(async () => response.resolve(ok({ ...task, statusId: STATUS_PROGRESS, revision: task.revision + 1 })));
  await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
  expect(ui.commands().editSessions.current.get(task.id)).toBe(independent);
  expect(ui.onClosed).not.toHaveBeenCalled();
});


describe('inline title keyboard and retained sessions', () => {
  it.each(['{Enter}', '{Control>}{Enter}{/Control}', '{Meta>}{Enter}{/Meta}'])('saves a title only on deliberate %s, excluding IME and modified line gestures', async shortcut => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok({ ...task, title: 'Composed title', revision: 2 }) });
    const ui = inline('title'); const input = screen.getByLabelText('Task name');
    await ui.user.clear(input); await ui.user.type(input, 'Composed title');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229 });
    await ui.user.keyboard('{Shift>}{Enter}{/Shift}{Alt>}{Enter}{/Alt}');
    expect(calls).toHaveLength(0); expect(input).toHaveFocus();
    await ui.user.keyboard(shortcut);
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1); expect(calls[0]?.body).toEqual({ expectedRevision: task.revision, title: 'Composed title' });
  });

  it('keeps the sent title focused and read-only while pending, so typing cannot change the sent value', async () => {
    const gate = deferred<Response>();
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise });
    const ui = inline('title'); const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: 'Sent title' } });
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(input).toHaveFocus(); expect(input).toHaveAttribute('readonly'); expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    await ui.user.type(input, ' extra{Enter}');
    expect(input).toHaveValue('Sent title'); expect(calls).toHaveLength(1);
    await act(async () => gate.resolve(ok({ ...task, title: 'Sent title', revision: 2 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
  });

  it.each(['', 'x'.repeat(501)])('retains an invalid title without submitting until explicit Escape discards only its unsent buffer', async title => {
    const { calls } = installFakeApi({}); const ui = inline('title'); const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: title } });
    await ui.user.keyboard('{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true'); expect(input).toHaveAccessibleDescription(screen.getByRole('alert').textContent ?? '');
    expect(input).toHaveValue(title); expect(calls).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    await ui.user.keyboard('{Escape}');
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' }));
    expect(screen.getByLabelText('Task name')).toHaveValue(task.title);
    expect(calls).toHaveLength(0);
  });

  it('closes an unchanged trimmed title on Enter without an update, offering the next quick task', async () => {
    const { calls } = installFakeApi({}); const ui = inline('title');
    fireEvent.change(screen.getByLabelText('Task name'), { target: { value: `  ${task.title}  ` } });
    await ui.user.keyboard('{Enter}'); expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('next'); expect(calls).toHaveLength(0);
  });

  it('passes the continue intent only for plain Enter, never for Ctrl/Cmd+Enter or blur commits', async () => {
    // The answer keeps the stored title: the open cell rebases onto it and still shows the same text.
    installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok({ ...task, revision: task.revision + 1 }) });
    const intents: boolean[] = [];
    function Example() {
      const commands = useTaskCommands(anna.id, alpha.id);
      const [mount, setMount] = useState(0);
      return <><InlineTaskEdit key={mount} task={task} field="title" statuses={statuses} members={alphaMembers} commands={commands} writable onClose={vi.fn()} onMoreDetails={vi.fn()} onSaved={vi.fn()}
        onSaveStarted={(_form, intent) => { intents.push(intent.continueWithNext); return { onSuccess: () => setMount(value => value + 1), onSettled: () => undefined }; }} /><button>Outside focus</button></>;
    }
    const ui = renderFieldUi(<Example />);
    for (const [title, gesture] of [['Plain', '{Enter}'], ['Modified', '{Control>}{Enter}{/Control}'], ['Blurred', null]] as const) {
      const input = await screen.findByDisplayValue(task.title);
      fireEvent.change(input, { target: { value: title } });
      if (gesture) await ui.user.keyboard(gesture); else await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
      await waitFor(() => expect(intents).toHaveLength(['Plain', 'Modified', 'Blurred'].indexOf(title) + 1));
      await screen.findByDisplayValue(task.title);
    }
    expect(intents).toEqual([true, false, false]);
  });

  it.each(['rich-title', 'other-cell'] as const)('offers only Resume for a %s draft instead of saving it through the title input', async origin => {
    const seed: EditSession = { base: task, draft: { ...draftFromTask(task), ...(origin === 'rich-title' ? { title: 'Drawer title' } : { dueDate: '2026-10-20' }) }, ...(origin === 'other-cell' ? { inlineField: 'dueDate' as const } : {}) };
    const { calls } = installFakeApi({}); const ui = inline('title', seed);
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume draft' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1); expect(ui.commands().editSessions.current.get(task.id)).toBe(seed); expect(calls).toHaveLength(0);
  });

  it.each([false, true])('reconciles the exact reopened title session once after confirmation (unknown retry: %s)', async retry => {
    const response = deferred<Response>(); const first = lost(); let attempt = 0;
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempt === 1 && retry ? first.promise : response.promise });
    const ui = inline('title'); fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Confirmed new title' } });
    await ui.user.keyboard('{Enter}'); await waitFor(() => expect(attempt).toBe(1));
    if (retry) { await act(async () => first.lose()); await screen.findByRole('button', { name: 'Retry' }); }
    await ui.user.keyboard('{Escape}'); await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' }));
    expect(screen.getByLabelText('Task name')).toHaveValue('Confirmed new title'); expect(screen.getByLabelText('Task name')).toHaveAttribute('readonly');
    if (retry) { await ui.user.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(attempt).toBe(2)); await ui.user.keyboard('{Escape}'); await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' })); }
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => response.resolve(ok({ ...task, title: 'Confirmed new title', revision: 2 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1)); expect(screen.getByLabelText('Task name')).toHaveValue('Confirmed new title');
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus(); expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
    await ui.user.click(screen.getByLabelText('Task name')); await ui.user.keyboard('{Enter}'); expect(calls).toHaveLength(retry ? 2 : 1);
    if (retry) assertExactRetry(calls);
  });
});
