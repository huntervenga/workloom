import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, failure, installFakeApi, ok, project } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, rootPath, task } from '../planning/test/fixtures';
import { InlineTaskEdit } from './InlineTaskEdit';
import { QuickTaskAdd } from './QuickTaskAdd';
import { TaskDrawer } from './TaskDrawer';
import { draftFromTask, emptyDraft } from './taskDraft';
import type { TaskInlineField } from './tableEditing';
import { useTaskCommands, type CreateSession, type EditSession, type TaskCommands } from './useTaskCommands';

const SECTION = 'e1000000-0000-4000-8000-000000000001';
const STATUS_PROGRESS = 'f6000000-0000-4000-8000-000000000002';
const statuses: TaskStatusDto[] = [
  { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 },
  { id: STATUS_PROGRESS, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored progress', group: 'in_progress', position: 1, revision: 1 },
];

function quick(seed?: CreateSession) {
  const onCreated = vi.fn(); const onMoreDetails = vi.fn();
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState(() => { if (seed) commands.createSession.current = seed; return true; });
    return <>{open ? <QuickTaskAdd projectId={PROJECT_ID} sectionId={SECTION} sectionName="Stored section" statuses={statuses} members={alphaMembers} commands={commands} writable onClose={() => setOpen(false)} onMoreDetails={onMoreDetails} onCreated={onCreated} /> : null}<button onClick={() => setOpen(true)}>Resume QA create</button><button>Outside focus</button></>;
  }
  const view = renderFieldUi(<Example />);
  return { ...view, onCreated, onMoreDetails, commands: () => { if (!current) throw new Error('No command harness'); return current; } };
}

function inline(field: TaskInlineField, seed?: EditSession, source: TaskDto = task) {
  const onSaved = vi.fn(); const onMoreDetails = vi.fn(); const onClosed = vi.fn();
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState(() => { if (seed) commands.editSessions.current.set(source.id, seed); return true; });
    return <>{open ? <InlineTaskEdit task={source} field={field} statuses={statuses} members={alphaMembers} commands={commands} writable onClose={() => { onClosed(); setOpen(false); }} onMoreDetails={onMoreDetails} onSaved={onSaved} /> : null}<button onClick={() => setOpen(true)}>Resume QA cell</button><button>Outside focus</button></>;
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

describe('section quick creation', () => {
  it('sends only explicit basic fields, waits for confirmation, then focuses the same section for another task', async () => {
    const response = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: () => response.promise });
    const ui = quick();
    await ui.user.type(screen.getByLabelText('Task name'), '  Quick task  ');
    await ui.user.selectOptions(screen.getByLabelText('Assignee'), alphaMembers[1]?.id ?? '');
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-20' } });
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION, title: 'Quick task', statusId: task.statusId, responsibleMembershipId: alphaMembers[1]?.id, dueDate: '2026-10-20' });
    expect(ui.onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Task name')).toBeDisabled();
    await act(async () => response.resolve(created({ ...task, sectionId: SECTION, title: 'Quick task', responsibleMembershipId: alphaMembers[1]?.id, dueDate: '2026-10-20' })));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Task name')).toHaveValue('');
    await waitFor(() => expect(screen.getByLabelText('Task name')).toHaveFocus());
    expect(ui.commands().createSession.current).toBeNull();
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
    expect(screen.getByRole('button', { name: 'More details' })).toBeDisabled();
    await ui.user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA create' }));
    expect(screen.getByLabelText('Task name')).toHaveValue('Original quick draft');
    expect(screen.getByLabelText('Task name')).toBeDisabled();
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

  it('reconciles a reopened pending create after confirmation without allowing a duplicate or stealing focus', async () => {
    const response = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: () => response.promise });
    const ui = quick();
    await ui.user.type(screen.getByLabelText('Task name'), 'Pending remount create');
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(ui.commands().create.pendingCommand).not.toBeNull());
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA create' }));
    expect(screen.getByLabelText('Task name')).toBeDisabled();
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => response.resolve(created({ ...task, title: 'Pending remount create' })));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Task name')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
    expect(ui.commands().createSession.current).toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(calls).toHaveLength(1);
  });

  it('offers a richer create draft for resumption without changing it or sending a basic create', async () => {
    const { calls } = installFakeApi({});
    const seed: CreateSession = { request: { sectionId: SECTION, parent: null }, workScope: 'detail', draft: { ...emptyDraft(task.statusId, SECTION), title: 'Rich draft', description: 'Kept description', estimate: '2:00' } };
    const ui = quick(seed);
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume draft' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(ui.commands().createSession.current).toEqual(seed);
    expect(calls).toHaveLength(0);
  });
});

describe('explicit inline task edits', () => {
  it.each(['statusId', 'responsibleMembershipId', 'dueDate'] as const)('updates only %s with the original task revision after explicit Save', async field => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: request => ok({ ...task, ...(request.body as object), revision: task.revision + 1 }) });
    const ui = inline(field);
    const patch = field === 'statusId' ? { statusId: STATUS_PROGRESS } : field === 'responsibleMembershipId' ? { responsibleMembershipId: null } : { dueDate: '2026-10-20' };
    if (field === 'statusId') await ui.user.selectOptions(screen.getByLabelText('Status'), STATUS_PROGRESS);
    else if (field === 'responsibleMembershipId') await ui.user.selectOptions(screen.getByLabelText('Assignee'), '');
    else fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-20' } });
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls[0]?.body).toEqual({ expectedRevision: task.revision, ...patch });
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
  });

  it('keeps a single-field draft across Escape and resumes it without losing its original base revision', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('statusId');
    await ui.user.selectOptions(screen.getByLabelText('Status'), STATUS_PROGRESS);
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' }));
    expect(screen.getByLabelText('Status')).toHaveValue(STATUS_PROGRESS);
    expect(ui.commands().editSessions.current.get(task.id)?.base.revision).toBe(task.revision);
    expect(calls).toHaveLength(0);
  });

  it('keeps an unknown update locked and retries exactly after Escape and reopen', async () => {
    const first = lost(); let attempt = 0;
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempt === 1 ? first.promise : ok({ ...task, statusId: STATUS_PROGRESS, revision: 2 }) });
    const ui = inline('statusId');
    await ui.user.selectOptions(screen.getByLabelText('Status'), STATUS_PROGRESS);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(attempt).toBe(1));
    await act(async () => first.lose());
    await screen.findByRole('button', { name: 'Retry' });
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' }));
    expect(screen.getByLabelText('Status')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More details' })).toBeDisabled();
    await ui.user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    assertExactRetry(calls);
  });

  it.each([false, true])('reconciles a reopened pending cell to its confirmed revision without saving the old draft again (retry: %s)', async retry => {
    const response = deferred<Response>();
    const first = lost(); let attempts = 0;
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempts === 1 && retry ? first.promise : response.promise });
    const ui = inline('statusId');
    await ui.user.selectOptions(screen.getByLabelText('Status'), STATUS_PROGRESS);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ui.commands().update.pendingCommand).not.toBeNull());
    if (retry) {
      await act(async () => first.lose());
      await ui.user.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(calls).toHaveLength(2));
    }
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA cell' }));
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => response.resolve(ok({ ...task, statusId: STATUS_PROGRESS, revision: task.revision + 1 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Status')).toHaveValue(STATUS_PROGRESS);
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
    expect(ui.onClosed).toHaveBeenCalledTimes(1);
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls).toHaveLength(retry ? 2 : 1);
    if (retry) assertExactRetry(calls);
  });

  it('refuses richer or different-cell drafts and leaves all of their values intact', async () => {
    const { calls } = installFakeApi({});
    const seed: EditSession = { base: task, draft: { ...draftFromTask(task), description: 'Unsaved drawer content', dueDate: '2026-10-20' }, inlineField: 'dueDate' };
    const ui = inline('statusId', seed);
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume draft' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(ui.commands().editSessions.current.get(task.id)).toEqual(seed);
    expect(calls).toHaveLength(0);
  });

  it('preserves a rejected stale draft and requires explicit details review instead of adopting a new revision', async () => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(409, 'REVISION_CONFLICT', 'private server internals') });
    const ui = inline('statusId');
    await ui.user.selectOptions(screen.getByLabelText('Status'), STATUS_PROGRESS);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ui.commands().update.error).not.toBeNull());
    expect(screen.getByLabelText('Status')).toHaveValue(STATUS_PROGRESS);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
    expect(ui.commands().editSessions.current.get(task.id)?.base.revision).toBe(task.revision);
    expect(screen.queryByText('private server internals')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls).toHaveLength(1);
    await ui.user.click(screen.getByRole('button', { name: 'More details' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
  });

  it('rejects a due date before the current start without sending or changing the original date', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('dueDate', undefined, { ...task, startDate: '2026-10-19' });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-18' } });
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Due date must be on or after the start date.');
    expect(screen.getByLabelText('Due date')).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
    expect(task.dueDate).toBeNull();
  });

  it('does not close another view or steal focus after an escaped pending edit confirms', async () => {
    const response = deferred<Response>();
    installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => response.promise });
    const ui = inline('statusId');
    await ui.user.selectOptions(screen.getByLabelText('Status'), STATUS_PROGRESS);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ui.commands().update.pendingCommand).not.toBeNull());
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => response.resolve(ok({ ...task, statusId: STATUS_PROGRESS, revision: 2 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(ui.onClosed).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outside focus' })).toHaveFocus();
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
  });
});

describe('authoritative task write rejection', () => {
  it.each([{ status: 409, code: 'DEPENDENCY_BLOCKED' }, { status: 409, code: 'FIELD_LOCKED' }, { status: 403, code: 'FORBIDDEN' }])('retains the original draft after $code without claiming success or retrying automatically', async ({ status, code }) => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(status, code, 'sensitive rejection details') });
    const ui = inline('statusId');
    await ui.user.selectOptions(screen.getByLabelText('Status'), STATUS_PROGRESS);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
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
    await ui.user.clear(name);
    await ui.user.type(name, 'Rich pending title');
    await ui.user.type(screen.getByLabelText('Description'), 'Kept rich description');
    await ui.user.click(screen.getByRole('button', { name: mode === 'create' ? 'Create task' : 'Save' }));
    await waitFor(() => expect(mode === 'create' ? ui.commands().create.pendingCommand : ui.commands().update.pendingCommand).not.toBeNull());
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA drawer' }));
    expect(await screen.findByLabelText('Task name')).toHaveValue('Rich pending title');
    expect(screen.getByLabelText('Task name')).toBeDisabled();
    await act(async () => response.resolve(mode === 'create' ? created({ ...task, title: 'Rich pending title', description: 'Kept rich description' }) : ok({ ...task, title: 'Rich pending title', description: 'Kept rich description', revision: task.revision + 1 })));
    await waitFor(() => expect(mode === 'create' ? ui.commands().create.pendingCommand : ui.commands().update.pendingCommand).toBeNull());
    expect(screen.getByLabelText('Task name')).toHaveValue(mode === 'create' ? '' : 'Rich pending title');
    expect(ui.onCreated).not.toHaveBeenCalled();
    expect(ui.commands().createSession.current).toBeNull();
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
    await ui.user.click(screen.getByRole('button', { name: mode === 'create' ? 'Create task' : 'Save' }));
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

it('preserves an independent replacement edit draft when an old pending inline edit confirms', async () => {
  const response = deferred<Response>();
  installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => response.promise });
  const ui = inline('statusId');
  await ui.user.selectOptions(screen.getByLabelText('Status'), STATUS_PROGRESS);
  await ui.user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(ui.commands().update.pendingCommand).not.toBeNull());
  await ui.user.keyboard('{Escape}');
  const independent: EditSession = { base: task, draft: { ...draftFromTask(task), description: 'Independent replacement' } };
  ui.commands().editSessions.current.set(task.id, independent);
  await act(async () => response.resolve(ok({ ...task, statusId: STATUS_PROGRESS, revision: task.revision + 1 })));
  await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
  expect(ui.commands().editSessions.current.get(task.id)).toBe(independent);
  expect(ui.onClosed).toHaveBeenCalledTimes(1);
});
