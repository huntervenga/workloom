import type { TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installFakeApi, ok, renderApp } from '../test/fakeApi';
import { rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
import { lostResponse } from '../features/planning/test/fixtures';

// Isolate the Page-owned selection port; actual Gantt checkbox/browser coverage remains separate.
vi.mock('../features/schedule/GanttView', () => ({ GanttView: ({ tasks, selectedIds, onSelect, selectionDisabled = false, writable }: { tasks: readonly TaskDto[]; selectedIds: readonly string[]; selectionDisabled?: boolean; writable: boolean; onSelect: (id: string, checked: boolean) => void }) => <section aria-label="Timeline selection port">{tasks.map(task => <input key={task.id} type="checkbox" aria-label={`Timeline selection: ${task.title}`} checked={selectedIds.includes(task.id)} disabled={selectionDisabled} onChange={event => onSelect(task.id, event.target.checked)} />)}{writable ? <button>Timeline date edit</button> : null}</section> }));

beforeAll(async () => { await import('./ProjectPage'); });

describe('Page-owned bulk recovery across views', () => {
  it('shows the explicit week guidance once in the actual page controls', async () => {
    installFakeApi(tableRoutes()); renderApp(tablePath);
    await screen.findByRole('button', { name: `Select task: ${task.title}` });
    expect(screen.getAllByText('Choose a week to enter planned or actual hours. The selected person is shown above; estimates stay separate.')).toHaveLength(1);
  });
  it('keeps the frozen selection and exact retry reachable when Timeline tries to deselect the last unknown task', async () => {
    const lost = lostResponse(); let attempts = 0;
    const other = { ...task, id: 'f2000000-0000-4000-8000-000000000002', title: 'Other unselected task' };
    const { calls } = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => ok([task, other]), [`POST ${rootPath}/tasks/bulk-update`]: () => ++attempts === 1 ? lost.promise : ok([{ ...task, dueDate: '2027-03-20', revision: task.revision + 1 }]) });
    const ui = renderApp(tablePath);
    await ui.user.click(await screen.findByRole('button', { name: `Select task: ${task.title}` }));
    const bar = () => screen.getByRole('region', { name: 'Edit selected tasks' });
    await ui.user.click(within(bar()).getByRole('button', { name: 'Dates' }));
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-03-20' } });
    await ui.user.click(screen.getByRole('button', { name: 'Done' }));
    await ui.user.click(within(bar()).getByRole('button', { name: 'Apply to selected tasks' }));
    await waitFor(() => expect(attempts).toBe(1)); await act(async () => lost.lose());
    await screen.findByRole('button', { name: 'Retry original' });
    await ui.user.click(within(screen.getByRole('navigation', { name: 'Project views' })).getByRole('button', { name: 'Timeline' }));
    const checkbox = await screen.findByRole('checkbox', { name: `Timeline selection: ${task.title}` });
    const unselected = screen.getByRole('checkbox', { name: `Timeline selection: ${other.title}` });
    expect(checkbox).toBeChecked(); expect(unselected).not.toBeChecked();
    expect(checkbox).toBeDisabled(); expect(unselected).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Timeline date edit' })).not.toBeInTheDocument();
    await ui.user.click(checkbox); await ui.user.click(unselected);
    expect(checkbox).toBeChecked(); expect(unselected).not.toBeChecked(); expect(within(bar()).getByText('1 tasks selected')).toBeVisible();
    await ui.user.click(within(bar()).getByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(attempts).toBe(2));
    const writes = calls.filter(call => call.method !== 'GET'); expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toEqual(writes[0]?.body); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    await waitFor(() => expect(checkbox).toBeEnabled()); expect(unselected).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Timeline date edit' })).toBeVisible();
  });
});
