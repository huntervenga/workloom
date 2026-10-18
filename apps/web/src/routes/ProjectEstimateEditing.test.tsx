import type { TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { queryKeys } from '../lib/queryKeys';
import { lostResponse } from '../features/planning/test/fixtures';
import { rootPath, task, legacyTablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const base: TaskDto = { ...task, title: 'Shared budget root', estimateMinutes: 120, workPackageRevision: 7 };
const detail: TaskDto = { ...base, id: 'f2000000-0000-4000-8000-000000000002', title: 'Shared detail', parentTaskId: base.id };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'estimate-fixture', nextCursor: null } });
function routes(extra: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), [`GET ${rootPath}/tasks`]: () => page([base, detail]), [`GET ${rootPath}/tasks/${base.id}`]: () => ok(base), [`GET ${rootPath}/tasks/${detail.id}`]: () => ok(detail), ...extra };
}
const edit = (title = base.title) => screen.findByRole('button', { name: `Edit team estimate for ${title}` });
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET');
const helper = 'This changes the shared budget for the whole team and every task in this work package.';

describe('inline team package estimate', () => {
  it('saves the whole shared package with both source revisions, waits for confirmation and deduplicates the footer', async () => {
    const gate = deferred<Response>(); let rows = [base, detail];
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page(rows), [`PATCH ${rootPath}/tasks/${detail.id}`]: () => gate.promise }));
    const { user } = renderApp(legacyTablePath());
    await user.click(await edit(detail.title));
    const input = screen.getByLabelText('Team estimate (hours)'); expect(input).toHaveFocus(); expect(input).toHaveValue('2:00');
    expect(screen.getByText(helper, { exact: false })).toBeVisible(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '1,5' } }); await user.keyboard('{Enter}');
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toEqual({ expectedRevision: detail.revision, estimateMinutes: 90, expectedWorkPackageRevision: 7 });
    expect(input).toHaveAttribute('readonly'); expect(input).toHaveFocus(); expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('2h');
    rows = rows.map(row => ({ ...row, estimateMinutes: 90, workPackageRevision: 8 }));
    await act(async () => gate.resolve(ok(rows[1])));
    await waitFor(() => expect(screen.getByRole('button', { name: `Edit team estimate for ${detail.title}` })).toHaveFocus());
    expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('1h 30m');
    expect(writes(calls)).toHaveLength(1);
  });

  it.each([{ raw: '', minutes: null }, { raw: '0', minutes: 0 }, { raw: '0,35', minutes: 21 }, { raw: '1:05', minutes: 65 }])('preserves the meaning of $raw as $minutes minutes through explicit Save', async ({ raw, minutes }) => {
    let current = base;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${base.id}`]: () => ok(current = { ...base, estimateMinutes: minutes, workPackageRevision: 8 }) }));
    const { user } = renderApp(legacyTablePath()); await user.click(await edit());
    expect(screen.getByText(helper, { exact: false })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Team estimate (hours)'), { target: { value: raw } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Team estimate (hours)')).not.toBeInTheDocument());
    expect(writes(calls)[0]?.body).toEqual({ expectedRevision: base.revision, estimateMinutes: minutes, expectedWorkPackageRevision: 7 });
  });

  it.each(['1:75', '-1', '0.001'])('shows invalid raw text %s without writing, then Escape cancels it before reopening', async raw => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(legacyTablePath()); await user.click(await edit());
    fireEvent.change(screen.getByLabelText('Team estimate (hours)'), { target: { value: raw } }); await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Team estimate (hours)')).toHaveAttribute('aria-invalid', 'true'); expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByLabelText('Team estimate (hours)')).toHaveValue(raw); await user.keyboard('{Escape}');
    await user.click(await edit()); expect(screen.getByLabelText('Team estimate (hours)')).toHaveValue('2:00');
    expect(screen.getByLabelText('Team estimate (hours)')).not.toHaveAttribute('aria-invalid', 'true');
    expect(writes(calls)).toHaveLength(0);
  });

  it('does not save an equivalent estimate or submit composing/modified Enter input', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(legacyTablePath()); await user.click(await edit());
    const input = screen.getByLabelText('Team estimate (hours)');
    fireEvent.change(input, { target: { value: '1,5' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); fireEvent.keyDown(input, { key: 'Enter', altKey: true });
    expect(writes(calls)).toHaveLength(0);
    fireEvent.change(input, { target: { value: '2.00' } }); await user.keyboard('{Enter}');
    await edit(); expect(screen.queryByLabelText('Team estimate (hours)')).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(0);
  });

  it('autosaves a drawer estimate on Close and opens its confirmed shared budget in the cell without another write', async () => {
    let current = base;
    const { calls } = installFakeApi(routes({
      [`GET ${rootPath}/tasks`]: () => page([current, { ...detail, estimateMinutes: current.estimateMinutes, workPackageRevision: current.workPackageRevision }]),
      [`GET ${rootPath}/tasks/${base.id}`]: () => ok(current),
      [`PATCH ${rootPath}/tasks/${base.id}`]: () => ok(current = { ...base, estimateMinutes: 210, workPackageRevision: 8 }),
    }));
    const { user } = renderApp(legacyTablePath());
    await user.click(await screen.findByRole('button', { name: `Open task “${base.title}”` }));
    const drawer = within(await screen.findByRole('dialog'));
    fireEvent.change(drawer.getByLabelText('Team estimate, hours'), { target: { value: '3,5' } });
    await user.click(drawer.getByLabelText('Close', { selector: 'button' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toEqual({ expectedRevision: base.revision, expectedWorkPackageRevision: 7, estimateMinutes: 210 });
    await waitFor(() => expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('3h 30m'));
    await user.click(await edit());
    expect(screen.getByLabelText('Team estimate (hours)')).toHaveValue('3:30');
    expect(screen.queryByRole('button', { name: 'Resume draft' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(writes(calls)).toHaveLength(1);
  });

  it.each(['newer', 'conflicting', 'duplicate-conflict'] as const)('refuses fresh editing from a %s loaded package projection without duplicating task rows/counts/selection', async kind => {
    const other = kind === 'duplicate-conflict' ? { ...base, estimateMinutes: 180 } : { ...detail, estimateMinutes: 180, workPackageRevision: kind === 'newer' ? 8 : 7 };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([base, other]) }));
    const { user } = renderApp(legacyTablePath()); await screen.findByRole('button', { name: base.title });
    expect(screen.queryByRole('button', { name: `Edit team estimate for ${base.title}` })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: base.title })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: `Select task: ${base.title}` })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: `Select task: ${base.title}` }));
    expect(screen.getByRole('button', { name: `Select task: ${base.title}` })).toHaveAttribute('aria-pressed', 'true');
    const footer = screen.getByText('Loaded team budget').closest('tr');
    if (kind === 'newer') expect(footer).toHaveTextContent('3h'); else expect(footer).toHaveTextContent('Shared estimates disagree');
    if (kind === 'duplicate-conflict') {
      expect(screen.getByRole('button', { name: 'Collapse section “No section”' }).closest('th')).toHaveTextContent('1 task');
      expect(footer).toHaveTextContent('Loaded: 1');
    }
    expect(writes(calls)).toHaveLength(0);
  });

  it('keeps a changed draft but blocks a fresh save when another loaded package projection advances', async () => {
    let rows = [base, detail]; const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page(rows) }));
    const { user, queryClient } = renderApp(legacyTablePath()); await user.click(await edit());
    fireEvent.change(screen.getByLabelText('Team estimate (hours)'), { target: { value: '3:45' } });
    rows = [base, { ...detail, estimateMinutes: 180, workPackageRevision: 8 }];
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(anna.id, alpha.id) }); });
    expect(screen.getByLabelText('Team estimate (hours)')).toHaveValue('3:45');
    expect(await screen.findByText('Refresh task data before editing this shared package estimate.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' })); expect(writes(calls)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'More details' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Team estimate, hours')).toHaveValue('3:45');
  });

  it('retries the exact unknown package write through hidden Board recovery with the original key and both revisions', async () => {
    const first = lostResponse(); let attempts = 0; let current = base;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`GET ${rootPath}/tasks/${base.id}`]: () => ok(current), [`PATCH ${rootPath}/tasks/${base.id}`]: () => ++attempts === 1 ? first.promise : ok(current) }));
    const { user } = renderApp(legacyTablePath()); await user.click(await edit());
    fireEvent.change(screen.getByLabelText('Team estimate (hours)'), { target: { value: '1,25' } }); await user.keyboard('{Enter}');
    await waitFor(() => expect(attempts).toBe(1));
    current = { ...base, estimateMinutes: 75, workPackageRevision: 8 };
    await act(async () => first.lose());
    await user.click(within(screen.getByRole('navigation', { name: 'Project views' })).getByRole('button', { name: 'Board' }));
    await user.click(await screen.findByRole('button', { name: 'Resume original editor' }));
    const drawer = within(await screen.findByRole('dialog'));
    expect(drawer.getByLabelText('Team estimate, hours')).toHaveValue('1,25'); expect(drawer.getByLabelText('Team estimate, hours')).toBeDisabled();
    await user.click(drawer.getByRole('button', { name: 'Retry submission' })); await waitFor(() => expect(attempts).toBe(2));
    const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[0]?.body).toEqual({ expectedRevision: base.revision, expectedWorkPackageRevision: 7, estimateMinutes: 75 });
    expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  });

  it('shows a server lock refusal and keeps the raw draft without clearing another field', async () => {
    const { calls } = installFakeApi(routes({ [`PATCH ${rootPath}/tasks/${base.id}`]: () => failure(409, 'FIELD_LOCKED', 'server details are not UI copy') }));
    const { user } = renderApp(legacyTablePath()); await user.click(await edit());
    fireEvent.change(screen.getByLabelText('Team estimate (hours)'), { target: { value: '4:00' } }); await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible()); expect(screen.getByLabelText('Team estimate (hours)')).toHaveValue('4:00'); expect(writes(calls)).toHaveLength(1);
  });

  it('does not offer estimate edits for viewers', async () => {
    const { calls } = installFakeApi(routes({ 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }) }));
    const { user } = renderApp(legacyTablePath()); await screen.findByRole('button', { name: base.title });
    expect(screen.queryByRole('button', { name: `Edit team estimate for ${base.title}` })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: base.title })); expect(within(await screen.findByRole('dialog')).getByLabelText('Team estimate, hours')).toBeDisabled();
    expect(writes(calls)).toHaveLength(0);
  });


  it.each(['meeting', 'archived', 'unknown-type'] as const)('does not offer a fresh estimate edit for a %s task', async kind => {
    const row = kind === 'meeting' ? { ...base, meetingId: 'f8000000-0000-4000-8000-000000000001' } : kind === 'archived' ? { ...base, archivedAt: base.createdAt } : { ...base, meetingId: undefined };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([row]) }));
    renderApp(legacyTablePath()); await screen.findByRole('button', { name: base.title });
    expect(screen.queryByRole('button', { name: `Edit team estimate for ${base.title}` })).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(0);
  });

  it('confirms an estimate pending across collapse/reopen once even though the task revision does not change', async () => {
    const gate = deferred<Response>(); let current = base;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${base.id}`]: () => gate.promise }));
    const { user } = renderApp(legacyTablePath()); await user.click(await edit());
    fireEvent.change(screen.getByLabelText('Team estimate (hours)'), { target: { value: '1:15' } }); await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1)); await user.click(screen.getByRole('button', { name: 'Collapse editor' })); await user.click(await edit());
    expect(screen.getByLabelText('Team estimate (hours)')).toHaveValue('1:15'); expect(screen.getByLabelText('Team estimate (hours)')).toHaveAttribute('readonly');
    await act(async () => gate.resolve(ok(current = { ...base, estimateMinutes: 75, workPackageRevision: 8 })));
    await waitFor(() => expect(screen.getByLabelText('Team estimate (hours)')).not.toHaveAttribute('readonly'));
    expect(screen.getByLabelText('Team estimate (hours)')).toHaveValue('1:15'); await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(writes(calls)).toHaveLength(1);
  });

  it.each(['exact', 'newer-package', 'newer-sibling-package', 'outside-focus'] as const)('returns focus only for an exact current package receipt head (%s)', async kind => {
    const response = deferred<Response>(); const head = deferred<Response>(); let readingHead = false;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => readingHead ? head.promise : page([base, detail]), [`PATCH ${rootPath}/tasks/${base.id}`]: () => response.promise }));
    const { user } = renderApp(legacyTablePath()); await user.click(await edit());
    fireEvent.change(screen.getByLabelText('Team estimate (hours)'), { target: { value: '1:30' } }); await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const receipt = { ...base, estimateMinutes: 90, workPackageRevision: 8 };
    readingHead = true; await act(async () => response.resolve(ok(receipt)));
    await waitFor(() => expect(screen.queryByLabelText('Team estimate (hours)')).not.toBeInTheDocument());
    const search = screen.getByLabelText('Search tasks'); if (kind === 'outside-focus') await user.click(search);
    const newer = { ...receipt, estimateMinutes: 180, workPackageRevision: 9 };
    const rows = kind === 'newer-package' ? [newer] : kind === 'newer-sibling-package' ? [receipt, { ...detail, estimateMinutes: 180, workPackageRevision: 9 }] : [receipt];
    await act(async () => head.resolve(page(rows)));
    if (kind === 'exact') await waitFor(() => expect(screen.getByRole('button', { name: `Edit team estimate for ${base.title}` })).toHaveFocus());
    else if (kind === 'outside-focus') expect(search).toHaveFocus();
    else {
      await waitFor(() => expect(screen.getByRole('button', { name: base.title })).toBeVisible());
      expect(document.activeElement?.getAttribute('data-task-cell')).not.toBe(`${base.id}:estimate`);
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(1);
  });

});
