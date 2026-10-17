import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, deferred, failure, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { lostResponse, rootPath, task } from '../planning/test/fixtures';
import { useTaskCommands } from '../tasks/useTaskCommands';
import { BulkTaskToolbar } from './BulkTaskToolbar';

const second = { ...task, id: 'f2000000-0000-4000-8000-000000000002', revision: 3, startDate: '2027-02-01', dueDate: '2027-02-28' };
const rows = [{ ...task, startDate: '2027-01-01', dueDate: '2027-01-30' }, second];
const endpoint = `POST ${rootPath}/tasks/bulk-update`;
function example() {
  const confirmed = vi.fn();
  function Example() { const commands = useTaskCommands(anna.id, alpha.id); return <BulkTaskToolbar projectId={task.projectId} tasks={rows} count={2} members={alphaMembers} commands={commands} writable blocked={false} onClear={vi.fn()} onConfirmed={confirmed} />; }
  return { ...renderFieldUi(<Example />), confirmed };
}
const apply = () => screen.getByRole('button', { name: 'Apply to selected tasks' });
async function stageDue(ui: ReturnType<typeof example>, date: string) {
  await ui.user.click(screen.getByRole('button', { name: 'Dates' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit selected task dates' });
  fireEvent.change(within(dialog).getByLabelText('Due date'), { target: { value: date } });
  await ui.user.click(within(dialog).getByRole('button', { name: 'Done' }));
}
describe('explicit atomic bulk editing', () => {
  it('stages only the touched endpoint and confirms all rows after the held receipt', async () => {
    const gate = deferred<Response>(); const { calls } = installFakeApi({ [endpoint]: () => gate.promise });
    const ui = example(); await stageDue(ui, '2027-03-20');
    expect(calls).toHaveLength(0); await ui.user.click(apply());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ projectId: task.projectId, tasks: rows.map(row => ({ taskId: row.id, expectedRevision: row.revision })), changes: { dueDate: '2027-03-20' } });
    expect(ui.confirmed).not.toHaveBeenCalled(); expect(apply()).toBeDisabled();
    await act(async () => gate.resolve(ok(rows.map(row => ({ ...row, dueDate: '2027-03-20', revision: row.revision + 1 })))));
    await waitFor(() => expect(ui.confirmed).toHaveBeenCalledTimes(1));
    expect(screen.getByText('2 tasks updated.')).toBeVisible();
  });
  it('allows deliberate clear on mixed blank date input and rejects an invalid final per-row range before any write', async () => {
    const { calls } = installFakeApi({}); const ui = example();
    await ui.user.click(screen.getByRole('button', { name: 'Dates' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit selected task dates' });
    await ui.user.click(within(dialog).getByRole('button', { name: 'Clear due date' }));
    await ui.user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(apply()).toBeEnabled();
    await stageDue(ui, '2026-12-01'); await ui.user.click(apply());
    expect(screen.getByRole('alert')).toHaveTextContent('Check the selected changes and dates.'); expect(calls).toHaveLength(0);
  });
  it('sends explicit null only for the date deliberately cleared from a mixed selection', async () => {
    const gate = deferred<Response>(); const { calls } = installFakeApi({ [endpoint]: () => gate.promise }); const ui = example();
    await ui.user.click(screen.getByRole('button', { name: 'Dates' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit selected task dates' });
    await ui.user.click(within(dialog).getByRole('button', { name: 'Clear due date' }));
    await ui.user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(calls).toHaveLength(0); await ui.user.click(apply());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]?.body as { changes: unknown }).changes).toEqual({ dueDate: null });
    expect(ui.confirmed).not.toHaveBeenCalled();
    await act(async () => gate.resolve(ok(rows.map(row => ({ ...row, dueDate: null, revision: row.revision + 1 })))));
    await waitFor(() => expect(ui.confirmed).toHaveBeenCalledTimes(1));
  });
  it('locks a lost acknowledgement to the exact selected IDs, revisions, patch and key', async () => {
    const lost = lostResponse(), retry = deferred<Response>(); let attempts = 0;
    const { calls } = installFakeApi({ [endpoint]: () => ++attempts === 1 ? lost.promise : retry.promise });
    const ui = example(); await stageDue(ui, '2027-03-20'); await ui.user.click(apply());
    await waitFor(() => expect(attempts).toBe(1)); await act(async () => lost.lose());
    const retryButton = await screen.findByRole('button', { name: 'Retry original' });
    expect(ui.confirmed).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Clear selection' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toBeDisabled();
    await ui.user.click(retryButton); await waitFor(() => expect(attempts).toBe(2));
    expect(calls[1]?.body).toEqual(calls[0]?.body); expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
    await act(async () => retry.resolve(ok(rows.map(row => ({ ...row, dueDate: '2027-03-20', revision: row.revision + 1 })))));
    await waitFor(() => expect(ui.confirmed).toHaveBeenCalledTimes(1));
  });
  it('does not announce success for a partial acknowledgement or a known rejection', async () => {
    const { calls } = installFakeApi({ [endpoint]: () => ok([rows[0]]) }); const ui = example();
    await stageDue(ui, '2027-03-20'); await ui.user.click(apply());
    expect(await screen.findByRole('button', { name: 'Retry original' })).toBeVisible();
    expect(ui.confirmed).not.toHaveBeenCalled(); expect(screen.queryByText('2 tasks updated.')).not.toBeInTheDocument(); expect(calls).toHaveLength(1);
  });
  it('keeps a known rejection visible without success or automatic writes', async () => {
    const { calls } = installFakeApi({ [endpoint]: () => failure(409, 'REVISION_CONFLICT', 'private detail') }); const ui = example();
    await stageDue(ui, '2027-03-20'); await ui.user.click(apply());
    await screen.findByRole('alert'); expect(ui.confirmed).not.toHaveBeenCalled(); expect(calls).toHaveLength(1); expect(screen.queryByText('private detail')).not.toBeInTheDocument();
  });
});
