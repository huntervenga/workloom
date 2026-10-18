import { chooseTimeContext, timeContextLabel } from './test/timeContext';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { createQueryClient } from '../../lib/queryClient';
import { alphaMembers, created, deferred, installFakeApi, ok, type RouteTable } from '../../test/fakeApi';
import { PERIOD_B, commitment, lostResponse } from '../planning/test/fixtures';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, TASK_ID, OPTION_B, categorized, category, projection, rootPath, legacyTablePath, tablePath, tableRoutes, task } from './test/fixtures';

beforeAll(async () => { await import('../../routes/ProjectPage'); });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
type Kind = 'plan' | 'fact' | 'category';
function unload() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
function setup(kind: Kind, extra: RouteTable = {}) {
  const api = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/projects/${PROJECT_ID}/periods/${PERIOD_A}/task-time-summary`]: () => ok(projection(MEMBER_ID, kind === 'category' ? categorized() : null)), ...extra });
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [legacyTablePath(`${tablePath}?week=${PERIOD_A}&worker=${MEMBER_ID}`)] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { ...api, client, router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
async function open(ui: ReturnType<typeof setup>, kind: Kind) {
  await ui.user.click(await screen.findByRole('button', { name: kind === 'plan' ? `Weekly plan: ${task.title}` : `Weekly actual hours: ${task.title}` }));
  let dialog = await screen.findByRole('dialog', { name: kind === 'plan' ? 'Add to weekly plan' : kind === 'category' ? 'Edit weekly actual hours' : 'Record weekly actual hours' });
  if (kind === 'category') {
    await ui.user.click(within(dialog).getByRole('button', { name: 'Change recorded work type' }));
    dialog = await screen.findByRole('dialog', { name: 'Change recorded work type' });
  }
  return dialog;
}
async function close(ui: ReturnType<typeof setup>) { await ui.user.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); }

describe('real page retained ordinary hours drafts', () => {
  it.each(['plan', 'fact', 'category'] as const)('does not protect pristine %s open/close', async kind => {
    const ui = setup(kind); expect(unload()).toBe(false);
    await open(ui, kind); await close(ui);
    expect({ native: unload(), drafts: protectedDraftsFor(ui.client).protecting, commands: protectedCommandsFor(ui.client).protecting }).toEqual({ native: false, drafts: false, commands: false });
    expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it.each(['plan', 'fact', 'category'] as const)('guards a closed dirty %s before cross-path departure with truthful unsent copy', async kind => {
    const ui = setup(kind); const dialog = await open(ui, kind);
    fireEvent.change(within(dialog).getByLabelText(kind === 'plan' ? 'Planned hours' : kind === 'fact' ? 'Actual hours this week' : 'Reason for changing work type'), { target: { value: kind === 'category' ? 'Retained reason' : '2' } });
    await close(ui);
    const before = { native: unload(), drafts: protectedDraftsFor(ui.client).protecting, commands: protectedCommandsFor(ui.client).protecting };
    await act(async () => { await ui.router.navigate('/hours-draft-outside'); });
    expect({ before, path: ui.router.state.location.pathname, guard: screen.queryByRole('dialog', { name: 'Leave this page?' }) !== null }).toEqual({ before: { native: true, drafts: true, commands: false }, path: tablePath, guard: true });
    const guard = screen.getByRole('dialog', { name: 'Leave this page?' });
    expect(guard).toHaveTextContent('You have an unsaved draft'); expect(guard).not.toHaveTextContent('The server may have saved');
    await ui.user.click(within(guard).getByRole('button', { name: 'Stay' }));
    const restored = await open(ui, kind);
    expect(within(restored).getByLabelText(kind === 'plan' ? 'Planned hours' : kind === 'fact' ? 'Actual hours this week' : 'Reason for changing work type')).toHaveValue(kind === 'category' ? 'Retained reason' : '2');
    expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});


it.each(['plan', 'fact', 'category'] as const)('reverting a retained %s releases only actual unsent input', async kind => {
  const ui = setup(kind); const dialog = await open(ui, kind);
  const input = within(dialog).getByLabelText(kind === 'plan' ? 'Planned hours' : kind === 'fact' ? 'Actual hours this week' : 'Reason for changing work type');
  const original = (input as HTMLInputElement).value;
  fireEvent.change(input, { target: { value: kind === 'category' ? 'Retained reason' : 'invalid raw hours' } });
  expect(protectedDraftsFor(ui.client).protecting).toBe(true); expect(unload()).toBe(true);
  fireEvent.change(input, { target: { value: original } });
  expect(protectedDraftsFor(ui.client).protecting).toBe(false); expect(unload()).toBe(false);
  await close(ui);
  await act(async () => { await ui.router.navigate('/hours-draft-outside'); });
  expect(ui.router.state.location.pathname).toBe('/hours-draft-outside'); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it('releases only the hours owner on explicit leave and keeps another owner protected', async () => {
  const ui = setup('fact'); const dialog = await open(ui, 'fact');
  fireEvent.change(within(dialog).getByLabelText('Actual hours this week'), { target: { value: '2' } }); await close(ui);
  const other = protectedDraftsFor(ui.client).register(); act(() => other.set(true));
  await act(async () => { await ui.router.navigate('/hours-draft-outside'); });
  const guard = await screen.findByRole('dialog', { name: 'Leave this page?' });
  await ui.user.click(within(guard).getByRole('button', { name: 'Leave without saving' }));
  await waitFor(() => expect(ui.router.state.location.pathname).toBe('/hours-draft-outside'));
  expect(protectedDraftsFor(ui.client).protecting).toBe(true);
  act(() => other.dispose()); expect(protectedDraftsFor(ui.client).protecting).toBe(false); expect(unload()).toBe(false);
  expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});


it.each(['plan', 'fact', 'category'] as const)('clears a confirmed exact %s session without pristine-session phantom protection', async kind => {
  const source = categorized();
  const ui = setup(kind, {
    [`POST ${rootPath}/periods/${PERIOD_A}/commitments`]: () => created(commitment(120)),
    [`PUT ${rootPath}/tasks/${TASK_ID}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`]: () => ok(categorized(120)),
    [`POST ${rootPath}/worklogs/${source.id}/recategorize`]: () => ok({ ...categorized(60, 2), category: category(OPTION_B, 'New work type') }),
  });
  const dialog = await open(ui, kind);
  if (kind === 'category') {
    await ui.user.selectOptions(within(dialog).getByLabelText('New work type'), OPTION_B);
    fireEvent.change(within(dialog).getByLabelText('Reason for changing work type'), { target: { value: 'Correction' } });
  } else fireEvent.change(within(dialog).getByLabelText(kind === 'plan' ? 'Planned hours' : 'Actual hours this week'), { target: { value: '2' } });
  expect(protectedDraftsFor(ui.client).protecting).toBe(true);
  await ui.user.click(within(dialog).getByRole('button', { name: kind === 'plan' ? 'Save personal plan' : kind === 'fact' ? 'Save actual hours' : 'Save new work type' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(protectedDraftsFor(ui.client).protecting).toBe(false); expect(protectedCommandsFor(ui.client).protecting).toBe(false); expect(unload()).toBe(false);
  expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
});

it('keeps an independent plan draft protected after a different fact save confirms', async () => {
  const ui = setup('fact', { [`PUT ${rootPath}/tasks/${TASK_ID}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`]: () => ok(categorized(120)) });
  let dialog = await open(ui, 'plan'); fireEvent.change(within(dialog).getByLabelText('Planned hours'), { target: { value: '3' } }); await close(ui);
  dialog = await open(ui, 'fact'); fireEvent.change(within(dialog).getByLabelText('Actual hours this week'), { target: { value: '2' } });
  await ui.user.click(within(dialog).getByRole('button', { name: 'Save actual hours' })); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(protectedDraftsFor(ui.client).protecting).toBe(true); expect(unload()).toBe(true);
  dialog = await open(ui, 'plan'); expect(within(dialog).getByLabelText('Planned hours')).toHaveValue('3');
  fireEvent.change(within(dialog).getByLabelText('Planned hours'), { target: { value: '' } }); await close(ui);
  expect(protectedDraftsFor(ui.client).protecting).toBe(false); expect(unload()).toBe(false);
});

it('keeps pending/unknown hours in the command registry and retries original bytes/key after Stay', async () => {
  const gate = lostResponse(); let attempts = 0;
  const ui = setup('fact', { [`PUT ${rootPath}/tasks/${TASK_ID}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`]: () => ++attempts === 1 ? gate.promise : ok(categorized(120)) });
  const dialog = await open(ui, 'fact'); fireEvent.change(within(dialog).getByLabelText('Actual hours this week'), { target: { value: '2' } });
  await ui.user.click(within(dialog).getByRole('button', { name: 'Save actual hours' })); await waitFor(() => expect(attempts).toBe(1)); await close(ui);
  expect(protectedCommandsFor(ui.client).protecting).toBe(true);
  await act(async () => gate.lose());
  await act(async () => { await ui.router.navigate('/hours-draft-outside'); });
  const guard = await screen.findByRole('dialog', { name: 'Leave this page?' }); expect(guard).toHaveTextContent('The server may have saved');
  await ui.user.click(within(guard).getByRole('button', { name: 'Stay' }));
  await ui.user.click(screen.getByRole('button', { name: 'Open original hours save' }));
  await ui.user.click(within(await screen.findByRole('dialog', { name: 'Record weekly actual hours' })).getByRole('button', { name: 'Retry original save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); expect(protectedCommandsFor(ui.client).protecting).toBe(false); expect(protectedDraftsFor(ui.client).protecting).toBe(false); expect(unload()).toBe(false);
  const writes = ui.calls.filter(call => call.method !== 'GET'); expect(writes).toHaveLength(2);
  expect(writes[1]?.path).toBe(writes[0]?.path); expect(writes[1]?.body).toEqual(writes[0]?.body); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
});


it('keeps another week/person draft open and protected after the earlier save acknowledges late', async () => {
  const other = alphaMembers[1]?.id; if (!other) throw new Error('Missing colleague');
  const gate = deferred<Response>();
  const ui = setup('fact', {
    [`GET ${rootPath}/projects/${PROJECT_ID}/periods/${PERIOD_B}/task-time-summary`]: request => ok({ ...projection(request.searchParams.get('membershipId') ?? MEMBER_ID), periodId: PERIOD_B }),
    [`PUT ${rootPath}/tasks/${TASK_ID}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`]: () => gate.promise,
  });
  await screen.findByRole('table');
  await chooseTimeContext(ui.user, 'Week for hours', PERIOD_B); await chooseTimeContext(ui.user, 'Whose hours to show', other);
  let dialog = await open(ui, 'fact'); fireEvent.change(within(dialog).getByLabelText('Actual hours this week'), { target: { value: '4' } }); await close(ui);
  await chooseTimeContext(ui.user, 'Week for hours', PERIOD_A); await chooseTimeContext(ui.user, 'Whose hours to show', MEMBER_ID);
  dialog = await open(ui, 'fact'); fireEvent.change(within(dialog).getByLabelText('Actual hours this week'), { target: { value: '2' } });
  await ui.user.click(within(dialog).getByRole('button', { name: 'Save actual hours' })); await waitFor(() => expect(ui.calls.some(call => call.method === 'PUT')).toBe(true)); await close(ui);
  await chooseTimeContext(ui.user, 'Week for hours', PERIOD_B); await chooseTimeContext(ui.user, 'Whose hours to show', other);
  dialog = await open(ui, 'fact'); expect(within(dialog).getByLabelText('Actual hours this week')).toHaveValue('4'); expect(within(dialog).getByLabelText('Actual hours this week')).toBeDisabled();
  await act(async () => gate.resolve(ok(categorized(120))));
  expect(screen.getByRole('dialog', { name: 'Record weekly actual hours' })).toBe(dialog);
  expect(within(dialog).getByLabelText('Actual hours this week')).toHaveValue('4'); expect(within(dialog).getByLabelText('Actual hours this week')).toBeEnabled();
  expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_B)); expect(screen.getByLabelText('Whose hours to show')).toHaveTextContent(timeContextLabel('Whose hours to show', other));
  expect(protectedCommandsFor(ui.client).protecting).toBe(false); expect(protectedDraftsFor(ui.client).protecting).toBe(true);
  fireEvent.change(within(dialog).getByLabelText('Actual hours this week'), { target: { value: '' } }); await close(ui);
  expect(protectedDraftsFor(ui.client).protecting).toBe(false); expect(unload()).toBe(false); expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
});
