import type { UserEvent } from '@testing-library/user-event';
import { timeContextLabel } from '../features/work-categories/test/timeContext';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeAll, expect, it } from 'vitest';
import { AppRoutes } from '../app/AppRoutes';
import { SessionProvider } from '../app/session';
import { createQueryClient } from '../lib/queryClient';
import { alphaMembers, failure, installFakeApi, ok, type RouteTable } from '../test/fakeApi';
import { chooseFilter, filterPicker } from '../features/tasks/test/filterPickers';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

const member = alphaMembers.find(item => item.id === MEMBER_ID); if (!member) throw new Error('Missing member fixture');

async function tableChoice(user: UserEvent, control: HTMLElement, value: 'section' | 'assignee' | 'manual' | 'due_asc') {
  await user.click(control);
  const name = { section: 'Section', assignee: 'Assignee', manual: 'Manual', due_asc: 'Due date' }[value];
  await user.click(within(screen.getByRole('listbox', { name: control.getAttribute('aria-label') ?? '' })).getByRole('option', { name }));
}

beforeAll(async () => { await import('./ProjectPage'); });
const groupingHelp = 'Each task appears under its assignee; meetings use their organizer. Weekly hours still belong to the selected person.';
const tableHelp = 'Groups keep their order. Tasks sort by their own due date within each group or sibling list; subtasks stay under their parent. Undated tasks come last.';
const boardHelp = 'Status lanes keep their order. Cards sort by their own due date within each lane, with undated tasks last.';
function app(url: string, extra: RouteTable = {}) {
  const api = installFakeApi({ ...tableRoutes(), ...extra });
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { ...view, ...api, router, client, user: userEvent.setup({ pointerEventsCheck: 0 }), close: () => { view.unmount(); router.dispose(); client.clear(); } };
}
function disclosure() {
  const summary = screen.getByText('About this table', { selector: 'summary' });
  const details = summary.closest('details');
  if (!details) throw new Error('Missing native table disclosure');
  return { summary, details };
}

it('keeps the ordinary Manual/Section table free of an empty guidance control', async () => {
  const ui = app(tablePath);
  try {
    await screen.findByRole('table');
    expect(screen.queryByText('About this table')).not.toBeInTheDocument();
    expect(screen.queryByText(groupingHelp)).not.toBeInTheDocument();
    expect(screen.queryByText(tableHelp)).not.toBeInTheDocument();
  } finally { ui.close(); }
});

it('puts only the applicable Table guidance in one initially closed native disclosure', async () => {
  const ui = app(`${tablePath}?sort=due_asc`);
  try {
    await screen.findByRole('table');
    const { summary, details } = disclosure();
    expect(details.open).toBe(false);
    expect(screen.getByText(tableHelp)).not.toBeVisible();
    expect(screen.queryByText(groupingHelp)).not.toBeInTheDocument();
    await tableChoice(ui.user, screen.getByRole('combobox', { name: 'Group by' }), 'assignee');
    expect(screen.getAllByText('About this table', { selector: 'summary' })).toHaveLength(1);
    expect(within(details).getByText(groupingHelp)).not.toBeVisible();
    await ui.user.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText(groupingHelp)).toBeVisible();
    expect(screen.getByText(tableHelp)).toBeVisible();
    await tableChoice(ui.user, screen.getByRole('combobox', { name: 'Sort' }), 'manual');
    expect(screen.queryByText(tableHelp)).not.toBeInTheDocument();
    expect(within(details).getByText(groupingHelp)).toBeVisible();
  } finally { ui.close(); }
});

it('keeps keyboard navigation and current URL, filters, selected task and week/person unchanged when guidance toggles', async () => {
  const ui = app(`${tablePath}?sort=due_asc&week=${PERIOD_A}&worker=${MEMBER_ID}&other=kept#anchor`);
  try {
    await screen.findByRole('table');
    await tableChoice(ui.user, screen.getByRole('combobox', { name: 'Group by' }), 'assignee');
    await ui.user.click(screen.getByText('Filters', { selector: 'summary' }));
    await chooseFilter(ui.user, 'Task participant', member.displayName);
    expect(new URLSearchParams(ui.router.state.location.search).get('participant')).toBe(MEMBER_ID);
    await ui.user.click(screen.getByText('Filters (1)', { selector: 'summary' }));
    await ui.user.click(screen.getByRole('checkbox', { name: `Select for graph: ${task.title}` }));
    await waitFor(() => expect(ui.calls.filter(call => call.path === `${rootPath}/tasks`).at(-1)?.searchParams.get('participantMembershipId')).toBe(MEMBER_ID));
    // A complete filtered result is still a loaded scope, not evidence of more pages.
    const budget = screen.getByText('Loaded team budget').closest('tr');
    expect(budget).toHaveTextContent('Budget covers loaded tasks only.');
    expect(budget).not.toHaveTextContent('More tasks available');
    const before = ui.router.state.location;
    const callsBefore = ui.calls.length;
    const { summary, details } = disclosure();
    screen.getByRole('button', { name: 'Columns' }).focus();
    await ui.user.tab();
    expect(summary).toHaveFocus();
    // jsdom does not implement native summary keyboard activation; actual Enter/Space
    // activation is a separate browser gate. Click exercises the same native toggle.
    await ui.user.click(summary);
    expect(details.open).toBe(true);
    await ui.user.tab();
    expect(summary).not.toHaveFocus();
    await ui.user.tab({ shift: true });
    expect(summary).toHaveFocus();
    await ui.user.click(summary);
    expect(details.open).toBe(false);
    expect(summary).toHaveFocus();
    expect(ui.router.state.location).toEqual(before);
    expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveTextContent('Assignee');
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Due date');
    expect(filterPicker('Task participant')).toHaveTextContent(member.displayName);
    expect(screen.getByRole('checkbox', { name: `Select for graph: ${task.title}` })).toBeChecked();
    expect(screen.getByLabelText('Week for hours')).toHaveTextContent(timeContextLabel('Week for hours', PERIOD_A));
    expect(screen.getByLabelText('Whose hours to show')).toHaveTextContent(timeContextLabel('Whose hours to show', MEMBER_ID));
    expect(ui.calls.slice(callsBefore)).toHaveLength(0);
    expect(ui.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  } finally { ui.close(); }
});

it('leaves current column-load warnings visible outside the closed help disclosure', async () => {
  const ui = app(`${tablePath}?sort=due_asc`, { [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => failure(503, 'UNAVAILABLE', 'Synthetic columns unavailable') });
  try {
    await screen.findByRole('table');
    const warning = await screen.findByText('Your columns could not be refreshed. The last available settings are shown.');
    expect(disclosure().details.open).toBe(false);
    expect(warning).toBeVisible();
    expect(warning.closest('details')).toBeNull();
    expect(screen.getByRole('button', { name: 'Columns' })).toBeEnabled();
  } finally { ui.close(); }
});

it('keeps Board due guidance visible with no Table disclosure and removes it in Manual', async () => {
  const ui = app(`${tablePath}?view=board&sort=due_asc`, { [`GET ${rootPath}/tasks`]: () => ok([task]) });
  try {
    const help = await screen.findByText(boardHelp);
    expect(help).toBeVisible();
    expect(help.closest('details')).toBeNull();
    expect(screen.queryByText('About this table')).not.toBeInTheDocument();
    expect(screen.queryByText(tableHelp)).not.toBeInTheDocument();
    await tableChoice(ui.user, screen.getByRole('combobox', { name: 'Sort' }), 'manual');
    expect(screen.queryByText(boardHelp)).not.toBeInTheDocument();
  } finally { ui.close(); }
});
