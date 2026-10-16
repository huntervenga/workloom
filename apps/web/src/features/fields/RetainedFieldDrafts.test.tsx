import type { MeetingDto, TaskDto, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { createQueryClient } from '../../lib/queryClient';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { alpha, alphaMembers, anna, boris, installFakeApi, ok, project, type RouteTable } from '../../test/fakeApi';
import { rootPath, tablePath, tableRoutes, task } from '../work-categories/test/fixtures';
import { lostResponse, MEMBER_ID, PERIOD_A, weekPath } from '../planning/test/fixtures';
import { FIELD_ID, OTHER_FIELD_ID, STAMP, field, fieldsPath, renderFieldUi } from './test/fixtures';
import { MeetingDrawer } from '../meetings/MeetingDrawer';
import { useMeetingWorkspace } from '../meetings/useMeetingWorkspace';
import { newFieldSession } from './FieldValueForm';
import { useSetTaskFieldValueMutation } from './queries';
import type { ObservableFieldValueDraftStore } from './fieldValueDraftStore';

beforeAll(async () => { await Promise.all([import('../../routes/ProjectPage'), import('../../routes/WeeklyPage')]); });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function unload() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
function setup(extra: RouteTable = {}, definitions: TaskFieldDefinitionDto[] = [field('Field signal', 'number')], initialPath = `${tablePath}?task=${task.id}`) {
  const api = installFakeApi({
    ...tableRoutes(),
    [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task),
    [`GET ${fieldsPath}`]: () => ok(definitions),
    [`GET ${rootPath}/tasks/${task.id}/field-values`]: () => ok([]),
    ...extra,
  });
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [initialPath] });
  const ui = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { ui.unmount(); router.dispose(); client.clear(); });
  return { ...ui, ...api, client, router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
async function openField(ui: ReturnType<typeof setup>, name = 'Field signal') {
  await ui.user.click(await screen.findByRole('button', { name: `Edit “${name}”` }));
  return screen.getByRole('dialog', { name: `Value of “${name}”` });
}
async function closeFieldAndDrawer(ui: ReturnType<typeof setup>) {
  await ui.user.click(within(screen.getByRole('dialog', { name: 'Value of “Field signal”' })).getByLabelText('Close', { selector: 'button' }));
  await ui.user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('actual retained custom-field draft protection', () => {
  it('protects only a hidden real field draft through native departure, routing and Stay', async () => {
    const ui = setup();
    const editor = await openField(ui);
    expect(unload()).toBe(false);
    fireEvent.change(within(editor).getByLabelText('Field signal'), { target: { value: 'not a valid number' } });
    expect(unload()).toBe(true);
    await closeFieldAndDrawer(ui);
    await ui.user.click(screen.getByRole('button', { name: `Open task “${task.title}”` }));
    expect(within(await openField(ui)).getByLabelText('Field signal')).toHaveValue('not a valid number');
    await closeFieldAndDrawer(ui);

    const hidden = { native: unload(), drafts: protectedDraftsFor(ui.client).protecting, commands: protectedCommandsFor(ui.client).protecting };
    await act(async () => { await ui.router.navigate('/outside-field-repro'); });
    const guard = screen.queryByRole('dialog', { name: 'Leave this page?' });
    expect({ ...hidden, path: ui.router.state.location.pathname, guard: guard !== null }).toEqual({ native: true, drafts: true, commands: false, path: tablePath, guard: true });
    if (!guard) throw new Error('Expected retained field navigation guard');
    expect(guard).toHaveTextContent('You have an unsaved draft');
    expect(guard).not.toHaveTextContent('The server may have saved');
    await ui.user.click(within(guard).getByRole('button', { name: 'Stay' }));
    await ui.user.click(screen.getByRole('button', { name: `Open task “${task.title}”` }));
    expect(within(await openField(ui)).getByLabelText('Field signal')).toHaveValue('not a valid number');
    expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});


it('leaves clean open/close input unprotected and releases an explicitly discarded field draft', async () => {
  const ui = setup();
  await openField(ui);
  expect(unload()).toBe(false);
  await closeFieldAndDrawer(ui);
  expect(unload()).toBe(false);
  expect(protectedDraftsFor(ui.client).protecting).toBe(false);
  await ui.user.click(screen.getByRole('button', { name: `Open task “${task.title}”` }));
  const editor = await openField(ui);
  fireEvent.change(within(editor).getByLabelText('Field signal'), { target: { value: '0' } });
  expect(unload()).toBe(true);
  await ui.user.click(within(editor).getByRole('button', { name: 'Discard draft' }));
  expect(within(editor).getByLabelText('Field signal')).toHaveValue('');
  expect(unload()).toBe(false);
  await closeFieldAndDrawer(ui);
  await act(async () => { await ui.router.navigate('/clean-field-departure'); });
  expect(ui.router.state.location.pathname).toBe('/clean-field-departure');
  expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it('asks before an actual actor switch with only a hidden field draft and keeps its raw input on Stay', async () => {
  const switchActor = vi.fn(() => ok({ actor: boris, authMode: 'dev' }));
  const ui = setup({ 'GET /api/v1/dev/actors': () => ok([anna, boris]), 'POST /api/v1/dev/session': switchActor });
  const editor = await openField(ui);
  fireEvent.change(within(editor).getByLabelText('Field signal'), { target: { value: 'invalid actor-owned input' } });
  await closeFieldAndDrawer(ui);
  (await screen.findByRole('button', { name: /Switch user/ })).focus();
  await ui.user.keyboard('{Enter}');
  await ui.user.click(await screen.findByRole('menuitemradio', { name: /Борис/ }));
  const guard = await screen.findByRole('dialog', { name: 'Switch user?' });
  expect(guard).toHaveTextContent('You have an unsaved draft');
  expect(switchActor).not.toHaveBeenCalled();
  await ui.user.click(within(guard).getByRole('button', { name: 'Stay' }));
  await ui.user.click(screen.getByRole('button', { name: `Open task “${task.title}”` }));
  expect(within(await openField(ui)).getByLabelText('Field signal')).toHaveValue('invalid actor-owned input');
  expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it('keeps pending/unknown field commands exact while confirmation retires only its own field draft', async () => {
  const gate = lostResponse();
  const first = field('Field signal', 'number');
  const second = field('Other signal', 'number', OTHER_FIELD_ID);
  const saved: TaskFieldValueDto = { workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, fieldId: FIELD_ID, definitionVersionId: first.definitionVersionId, revision: 1, value: { type: 'number', value: 0 }, updatedAt: STAMP };
  let attempts = 0;
  let confirmed = false;
  const ui = setup({
    [`GET ${rootPath}/tasks/${task.id}/field-values`]: () => ok(confirmed ? [saved] : []),
    [`PUT ${rootPath}/tasks/${task.id}/field-values/${FIELD_ID}`]: () => ++attempts === 1 ? gate.promise : (confirmed = true, ok(saved)),
  }, [first, second]);
  let editor = await openField(ui);
  fireEvent.change(within(editor).getByLabelText('Field signal'), { target: { value: '0' } });
  await ui.user.click(within(editor).getByLabelText('Close', { selector: 'button' }));
  editor = await openField(ui, 'Other signal');
  fireEvent.change(within(editor).getByLabelText('Other signal'), { target: { value: '17' } });
  await ui.user.click(within(editor).getByLabelText('Close', { selector: 'button' }));
  editor = await openField(ui);
  await ui.user.click(within(editor).getByRole('button', { name: 'Save value' }));
  await waitFor(() => expect(attempts).toBe(1));
  await closeFieldAndDrawer(ui);
  expect(protectedCommandsFor(ui.client).protecting).toBe(true);
  expect(unload()).toBe(true);
  await act(async () => { gate.lose(); });
  await act(async () => { await ui.router.navigate('/unknown-field-departure'); });
  const guard = await screen.findByRole('dialog', { name: 'Leave this page?' });
  expect(guard).toHaveTextContent('The server may have saved');
  await ui.user.click(within(guard).getByRole('button', { name: 'Stay' }));
  await ui.user.click(screen.getByRole('button', { name: `Open task “${task.title}”` }));
  editor = await openField(ui);
  expect(within(editor).getByLabelText('Field signal')).toHaveValue('0');
  expect(within(editor).getByLabelText('Field signal')).toBeDisabled();
  await ui.user.click(within(editor).getByRole('button', { name: 'Retry submission' }));
  await waitFor(() => expect(protectedCommandsFor(ui.client).protecting).toBe(false));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Value of “Field signal”' })).not.toBeInTheDocument());
  expect(unload()).toBe(true);
  editor = await openField(ui, 'Other signal');
  expect(within(editor).getByLabelText('Other signal')).toHaveValue('17');
  await ui.user.click(within(editor).getByRole('button', { name: 'Discard draft' }));
  expect(unload()).toBe(false);
  const writes = ui.calls.filter(call => call.method !== 'GET');
  expect(writes).toHaveLength(2);
  expect(writes[1]?.body).toEqual(writes[0]?.body);
  expect(writes[0]?.headers.get('Idempotency-Key')).toBeTruthy();
  expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
});


it('protects an actual Weekly meeting fallback field draft after closing its drawer', async () => {
  const meetingId = 'ab000000-0000-4000-8000-000000000001';
  const meetingTask: TaskDto = { ...task, meetingId, title: 'Weekly meeting field draft', participants: [{ membershipId: MEMBER_ID, role: 'assignee', active: true, revision: 1 }] };
  const meeting: MeetingDto = {
    id: meetingId, workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id,
    workPackageId: task.workPackageId, revision: 1, participantsRevision: 1, plannedPeriodId: PERIOD_A,
    plannedStartAt: STAMP, timezone: 'UTC', plannedDurationMinutes: 60, organizerMembershipId: MEMBER_ID,
    state: 'scheduled', actualStartAt: null, actualDurationMinutes: null, joinUrl: null, recordingUrl: null,
    summaryUrl: null, summaryText: null, scheduleFrozen: false, hasPostedAttendance: false, createdAt: STAMP, updatedAt: STAMP,
  };
  const ui = setup({
    [`GET ${rootPath}/tasks/${task.id}`]: () => ok(meetingTask),
    [`GET ${rootPath}/tasks/${task.id}/meeting`]: () => ok(meeting),
    [`GET ${rootPath}/tasks/${task.id}/attendance`]: () => ok([]),
    [`GET ${rootPath}/projects/${task.projectId}/meetings`]: () => ok([{ task: meetingTask, meeting }]),
  }, [field('Field signal', 'number')], `${weekPath}?period=${PERIOD_A}`);
  await ui.user.click(await screen.findByRole('button', { name: 'Open meeting' }));
  const editor = await openField(ui);
  expect(unload()).toBe(false);
  fireEvent.change(within(editor).getByLabelText('Field signal'), { target: { value: 'Weekly raw invalid' } });
  await closeFieldAndDrawer(ui);
  expect(unload()).toBe(true);
  expect(protectedCommandsFor(ui.client).protecting).toBe(false);
  await act(async () => { await ui.router.navigate('/outside-weekly-field'); });
  const guard = await screen.findByRole('dialog', { name: 'Leave this page?' });
  expect(guard).toHaveTextContent('You have an unsaved draft');
  await ui.user.click(within(guard).getByRole('button', { name: 'Stay' }));
  await ui.user.click(screen.getByRole('button', { name: 'Open meeting' }));
  expect(within(await openField(ui)).getByLabelText('Field signal')).toHaveValue('Weekly raw invalid');
  expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});


it('never pairs an external meeting field mutation with the controller fallback drafts', async () => {
  const meetingId = 'ab000000-0000-4000-8000-000000000001';
  const meetingTask: TaskDto = { ...task, meetingId, title: 'Partial override meeting' };
  const meeting: MeetingDto = {
    id: meetingId, workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id,
    workPackageId: task.workPackageId, revision: 1, participantsRevision: 1, plannedPeriodId: PERIOD_A,
    plannedStartAt: STAMP, timezone: 'UTC', plannedDurationMinutes: 60, organizerMembershipId: MEMBER_ID,
    state: 'scheduled', actualStartAt: null, actualDurationMinutes: null, joinUrl: null, recordingUrl: null,
    summaryUrl: null, summaryText: null, scheduleFrozen: false, hasPostedAttendance: false, createdAt: STAMP, updatedAt: STAMP,
  };
  const definition = field('Field signal', 'number');
  const controllerDraft = newFieldSession(definition, null, { type: 'number', text: 'controller-only raw input' });
  const saved: TaskFieldValueDto = { workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, fieldId: FIELD_ID, definitionVersionId: definition.definitionVersionId, revision: 1, value: { type: 'number', value: 0 }, updatedAt: STAMP };
  let confirmed = false;
  const { calls } = installFakeApi({
    ...tableRoutes(), [`GET ${fieldsPath}`]: () => ok([definition]),
    [`GET ${rootPath}/tasks/${task.id}`]: () => ok(meetingTask),
    [`GET ${rootPath}/tasks/${task.id}/meeting`]: () => ok(meeting),
    [`GET ${rootPath}/tasks/${task.id}/attendance`]: () => ok([]),
    [`GET ${rootPath}/tasks/${task.id}/field-values`]: () => ok(confirmed ? [saved] : []),
    [`PUT ${rootPath}/tasks/${task.id}/field-values/${FIELD_ID}`]: () => { confirmed = true; return ok(saved); },
  });
  let currentStore: ObservableFieldValueDraftStore | undefined;
  function Example() {
    const controller = useMeetingWorkspace(anna.id, alpha.id, task.projectId);
    const externalMutation = useSetTaskFieldValueMutation(anna.id, alpha.id);
    const [open, setOpen] = useState(true);
    const store = controller.fieldValueDrafts.current;
    currentStore = store;
    useEffect(() => { store.set(task.id, { [FIELD_ID]: controllerDraft }); }, [store]);
    return open ? <MeetingDrawer controller={controller} actorId={anna.id} workspace={alpha} project={project(alpha.id, task.projectId, 'Project')} members={alphaMembers} taskId={task.id} open onClose={() => setOpen(false)} fieldValueMutation={externalMutation} /> : null;
  }
  const ui = renderFieldUi(<MemoryRouter><Example /></MemoryRouter>);
  await ui.user.click(await screen.findByRole('button', { name: 'Edit “Field signal”' }));
  const editor = screen.getByRole('dialog', { name: 'Value of “Field signal”' });
  expect(within(editor).getByLabelText('Field signal')).toHaveValue('');
  fireEvent.change(within(editor).getByLabelText('Field signal'), { target: { value: '0' } });
  await ui.user.click(within(editor).getByRole('button', { name: 'Save value' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Value of “Field signal”' })).not.toBeInTheDocument());
  expect(currentStore?.getTask(task.id)[FIELD_ID]).toBe(controllerDraft);
  expect(calls.filter(call => call.method !== 'GET')).toHaveLength(1);
});
