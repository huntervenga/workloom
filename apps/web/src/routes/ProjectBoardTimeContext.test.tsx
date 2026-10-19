import { timeContextLabel } from '../features/work-categories/test/timeContext';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/AppRoutes';
import { SessionProvider } from '../app/session';
import { createQueryClient } from '../lib/queryClient';
import { alphaMembers, failure, installFakeApi, ok } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, TASK_ID, categorized, rootPath, legacyTablePath, tablePath, tableRoutes, task } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
function LocationProbe() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}{location.hash}</output>; }
function renderProject(path: string) {
  const client = createQueryClient({ retry: false });
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><SessionProvider><AppRoutes /><LocationProbe /></SessionProvider></MemoryRouter></QueryClientProvider>);
  return { ...view, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
const views = () => within(screen.getByRole('navigation', { name: 'Project views' }));
async function showBoard(user: ReturnType<typeof renderProject>['user']) {
  await user.click(views().getByRole('button', { name: 'Board' }));
  await screen.findByRole('region', { name: 'Task status lanes' });
}
async function closeFact(user: ReturnType<typeof renderProject>['user']) {
  const dialog = screen.getByRole('dialog', { name: 'Record weekly actual hours' });
  const close = within(dialog).getAllByRole('button', { name: 'Close' }).find(button => button.hasAttribute('aria-label'));
  if (!close) throw new Error('Missing dialog close');
  await user.click(close);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('Board density with retained time context', () => {
  it('hides hours pickers on Board and restores them unchanged in Tasks while retaining meeting selection and Week navigation', async () => {
    const person = alphaMembers[1]?.id; if (!person) throw new Error('Missing colleague');
    const { calls } = installFakeApi(tableRoutes());
    const { user } = renderProject(legacyTablePath(`${tablePath}?week=${PERIOD_A}&worker=${person}&meetingPeriod=${PERIOD_A}&meetingMember=${MEMBER_ID}&meetingAttendance=saved-attendance&other=kept#anchor`));
    await screen.findByRole('table');
    await waitFor(() => expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_A)));
    expect(screen.getByLabelText('Whose hours to show')).toHaveTextContent(timeContextLabel('Whose hours to show', person));
    const reportHref = `${tablePath}/reports`;
    expect(views().getByRole('link', { name: 'Reports' })).toHaveAttribute('href', reportHref);
    expect(views().queryByRole('link', { name: 'Legacy weekly planning' })).not.toBeInTheDocument();
    await showBoard(user);
    expect(screen.queryByLabelText('Week for hours')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Whose hours to show')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Weekly hours in table' })).not.toBeInTheDocument();
    expect(screen.getByText('1 loaded task in this view.')).toBeInTheDocument();
    expect(views().getByRole('link', { name: 'Reports' })).toHaveAttribute('href', reportHref);
    expect(views().queryByRole('link', { name: 'Legacy weekly planning' })).not.toBeInTheDocument();
    const location = screen.getByTestId('location');
    for (const part of [`week=${PERIOD_A}`, `worker=${person}`, `meetingPeriod=${PERIOD_A}`, `meetingMember=${MEMBER_ID}`, 'meetingAttendance=saved-attendance', 'other=kept', '#anchor', 'view=board']) expect(location).toHaveTextContent(part);
    await user.click(views().getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('table');
    expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_A));
    expect(screen.getByLabelText('Whose hours to show')).toHaveTextContent(timeContextLabel('Whose hours to show', person));
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('keeps one pending/unknown hours notice across Tasks and Board and retries the original bytes and key', async () => {
    const gate = lostResponse(); let attempt = 0;
    const path = `${rootPath}/tasks/${TASK_ID}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`;
    const { calls } = installFakeApi({ ...tableRoutes(), [`PUT ${path}`]: () => ++attempt === 1 ? gate.promise : ok(categorized(300)) });
    const { user } = renderProject(legacyTablePath(`${tablePath}?week=${PERIOD_A}&worker=${MEMBER_ID}`));
    await user.click(await screen.findByRole('button', { name: `Weekly actual hours: ${task.title}` }));
    let dialog = await screen.findByRole('dialog', { name: 'Record weekly actual hours' });
    await user.type(within(dialog).getByLabelText('Actual hours this week'), '5');
    await user.click(within(dialog).getByRole('button', { name: 'Save actual hours' }));
    await waitFor(() => expect(attempt).toBe(1));
    await closeFact(user);
    await showBoard(user);
    expect(screen.getAllByRole('button', { name: 'Open original hours save' })).toHaveLength(1);
    expect(screen.getByText(/waiting for server response. The original week and person are preserved/)).toBeInTheDocument();
    await act(async () => gate.lose());
    await screen.findByText(/result still unknown. The original week and person are preserved/);
    await user.click(views().getByRole('button', { name: 'Tasks' }));
    expect(screen.getAllByRole('button', { name: 'Open original hours save' })).toHaveLength(1);
    await showBoard(user);
    expect(screen.getAllByRole('button', { name: 'Open original hours save' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Open original hours save' }));
    dialog = await screen.findByRole('dialog', { name: 'Record weekly actual hours' });
    expect(within(dialog).getByLabelText('Actual hours this week')).toHaveValue('5:00');
    expect(within(dialog).getByRole('region', { name: 'Time entry context' })).toHaveTextContent(task.title);
    await user.click(within(dialog).getByRole('button', { name: 'Retry original save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Open original hours save' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Week for hours')).not.toBeInTheDocument();
    const writes = calls.filter(call => call.method !== 'GET');
    expect(writes).toHaveLength(2);
    expect(writes[0]?.method).toBe('PUT'); expect(writes[0]?.path).toBe(path);
    expect(writes[0]?.body).toEqual({ expectedRevision: null, minutes: 300, state: 'active', reason: null });
    expect(writes[1]?.path).toBe(writes[0]?.path); expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
  });

  it('keeps retained time query errors and retry available on Board while the pickers are absent', async () => {
    let unavailable = true;
    const route = `GET ${rootPath}/projects/${PROJECT_ID}/periods/${PERIOD_A}/task-time-summary`;
    const base = tableRoutes();
    const successfulSummary = base[route]; if (!successfulSummary) throw new Error('Missing summary fixture');
    const { calls } = installFakeApi({ ...base, [route]: request => unavailable ? failure(503, 'TEMPORARILY_UNAVAILABLE', 'private time error') : successfulSummary(request) });
    const { user } = renderProject(legacyTablePath(`${tablePath}?view=board&week=${PERIOD_A}&worker=${MEMBER_ID}`));
    const heading = await screen.findByRole('heading', { name: 'Unable to load weekly time' });
    expect(screen.queryByLabelText('Week for hours')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Task status lanes' })).toBeInTheDocument();
    const alert = heading.closest('[role="alert"]'); if (!alert) throw new Error('Missing error card');
    expect(document.body).not.toHaveTextContent('private time error');
    unavailable = false;
    await user.click(within(alert as HTMLElement).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Unable to load weekly time' })).not.toBeInTheDocument());
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
