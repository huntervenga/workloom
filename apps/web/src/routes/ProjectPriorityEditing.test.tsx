import type { TaskDto, TaskPriority } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { preferenceKey } from '../features/task-table/personalColumnsApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { MEMBER_ID, PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const base: TaskDto = { ...task, title: 'Priority source task', priority: 'medium', revision: 7 };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'priority-fixture', nextCursor: null } });
const preferencePath = `${rootPath}/projects/${PROJECT_ID}/table-preferences/me`;
const preferences = (visible = true) => ({ workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: MEMBER_ID, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'priority' }, visible }] });
function routes(extra: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), [`GET ${preferencePath}`]: () => ok(preferences()), [`GET ${rootPath}/tasks`]: () => page([base]), [`GET ${rootPath}/tasks/${base.id}`]: () => ok(base), ...extra };
}
const edit = () => screen.findByRole('button', { name: `Edit priority for ${base.title}` });
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET');

describe('actual project inline Priority', () => {
  it('opens a native Priority selector in the visible column without a drawer or selection write', async () => {
    const { calls } = installFakeApi(routes());
    const { user } = renderApp(tablePath);
    await screen.findByRole('columnheader', { name: 'Priority' });
    await user.click(await edit());
    const select = screen.getByRole('combobox', { name: 'Priority' });
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('medium');
    expect(within(select).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['none', 'low', 'medium', 'high', 'urgent']);
    await user.selectOptions(select, 'urgent');
    expect(writes(calls)).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['none', 'low', 'medium', 'high', 'urgent'] as TaskPriority[])('saves %s through the existing command with exact task revision and waits for confirmation', async priority => {
    let current: TaskDto = { ...base, priority: priority === 'medium' ? 'none' as const : 'medium' as const };
    const source = current, gate = deferred<Response>();
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${base.id}`]: () => gate.promise }));
    const { user } = renderApp(tablePath); await user.click(await edit());
    const select = screen.getByRole('combobox', { name: 'Priority' }); await user.selectOptions(select, priority); expect(writes(calls)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toEqual({ expectedRevision: source.revision, priority }); expect(select).toBeDisabled();
    current = { ...current, priority, revision: source.revision + 1 }; await act(async () => gate.resolve(ok(current)));
    await waitFor(() => expect(screen.getByRole('button', { name: `Edit priority for ${base.title}` })).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(1);
  });

  it('does not send unchanged Priority and keeps a changed selection after Escape/reopen', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath); await user.click(await edit());
    await user.click(screen.getByRole('button', { name: 'Save' })); await edit(); expect(writes(calls)).toHaveLength(0);
    await user.click(await edit()); await user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'urgent'); await user.keyboard('{Escape}');
    await user.click(await edit()); expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue('urgent'); expect(writes(calls)).toHaveLength(0);
  });

  it('keeps a drawer Priority draft Resume-only and does not submit it through a cell', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: base.title }));
    const drawer = within(await screen.findByRole('dialog')); await user.click(drawer.getByText('More details', { selector: 'summary' }));
    await user.selectOptions(drawer.getByRole('combobox', { name: 'Priority' }), 'high');
    await user.click(drawer.getByLabelText('Close', { selector: 'button' })); await user.click(await edit());
    expect(screen.queryByRole('combobox', { name: 'Priority' })).not.toBeInTheDocument(); await user.click(screen.getByRole('button', { name: 'Resume draft' }));
    const resumed = within(await screen.findByRole('dialog'));
    const resumedDetails = resumed.getByText('More details', { selector: 'summary' }); if (!resumedDetails.closest('details')?.open) await user.click(resumedDetails);
    expect(resumed.getByRole('combobox', { name: 'Priority' })).toHaveValue('high'); expect(writes(calls)).toHaveLength(0);
  });

  it.each(['Board', 'hidden-column'] as const)('retries a lost Priority response through %s recovery with the original payload and key', async mode => {
    const first = lostResponse(); let attempts = 0, current = base, visible = true;
    const { calls } = installFakeApi(routes({ [`GET ${preferencePath}`]: () => ok(preferences(visible)), [`GET ${rootPath}/tasks`]: () => page([current]), [`GET ${rootPath}/tasks/${base.id}`]: () => ok(current), [`PATCH ${rootPath}/tasks/${base.id}`]: () => ++attempts === 1 ? first.promise : ok(current) }));
    const { user, queryClient } = renderApp(tablePath); await user.click(await edit());
    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'urgent'); await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(attempts).toBe(1)); current = { ...base, priority: 'urgent', revision: 8 }; await act(async () => first.lose());
    if (mode === 'Board') await user.click(within(screen.getByRole('navigation', { name: 'Project views' })).getByRole('button', { name: 'Board' }));
    else { visible = false; await act(async () => { await queryClient.invalidateQueries({ queryKey: preferenceKey(anna.id, alpha.id, PROJECT_ID), exact: true }); }); }
    await user.click(await screen.findByRole('button', { name: 'Resume original editor' }));
    const drawer = within(await screen.findByRole('dialog'));
    const details = drawer.getByText('More details', { selector: 'summary' }); if (!details.closest('details')?.open) await user.click(details);
    expect(drawer.getByRole('combobox', { name: 'Priority' })).toHaveValue('urgent'); expect(drawer.getByRole('combobox', { name: 'Priority' })).toBeDisabled();
    await user.click(drawer.getByRole('button', { name: 'Retry submission' })); await waitFor(() => expect(attempts).toBe(2));
    const sent = writes(calls); expect(sent).toHaveLength(2); expect(sent[0]?.body).toEqual({ expectedRevision: 7, priority: 'urgent' }); expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  });

  it.each(['exact', 'newer-priority', 'newer-revision', 'outside-focus'] as const)('returns focus only for the exact current Priority receipt (%s)', async kind => {
    const response = deferred<Response>(), head = deferred<Response>(); let readingHead = false;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => readingHead ? head.promise : page([base]), [`PATCH ${rootPath}/tasks/${base.id}`]: () => response.promise }));
    const { user } = renderApp(tablePath); await user.click(await edit());
    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'low'); await user.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const receipt = { ...base, priority: 'low' as const, revision: 8 }; readingHead = true; await act(async () => response.resolve(ok(receipt)));
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Priority' })).not.toBeInTheDocument());
    const search = screen.getByLabelText('Search tasks'); if (kind === 'outside-focus') await user.click(search);
    const current = kind === 'newer-priority' ? { ...receipt, priority: 'urgent' as const } : kind === 'newer-revision' ? { ...receipt, revision: 9 } : receipt;
    await act(async () => head.resolve(page([current])));
    if (kind === 'exact') await waitFor(() => expect(screen.getByRole('button', { name: `Edit priority for ${base.title}` })).toHaveFocus());
    else if (kind === 'outside-focus') expect(search).toHaveFocus();
    else { await screen.findByRole('button', { name: base.title }); expect(document.activeElement?.getAttribute('data-task-cell')).not.toBe(`${base.id}:priority`); }
    expect(writes(calls)).toHaveLength(1); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a server refusal in safe copy with its selected Priority', async () => {
    const { calls } = installFakeApi(routes({ [`PATCH ${rootPath}/tasks/${base.id}`]: () => failure(409, 'REVISION_CONFLICT', 'Untrusted backend message') }));
    const { user } = renderApp(tablePath); await user.click(await edit()); await user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'high'); await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible()); expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue('high'); expect(screen.queryByText('Untrusted backend message')).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(1);
  });

  it.each(['viewer', 'meeting', 'archived', 'unknown-type'] as const)('does not offer fresh Priority editing for %s', async kind => {
    const source = kind === 'meeting' ? { ...base, meetingId: base.id } : kind === 'archived' ? { ...base, archivedAt: base.createdAt } : kind === 'unknown-type' ? { ...base, meetingId: undefined } : base;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([source]), ...(kind === 'viewer' ? { 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }) } : {}) }));
    renderApp(tablePath); await screen.findByRole('button', { name: base.title }); expect(screen.queryByRole('button', { name: `Edit priority for ${base.title}` })).not.toBeInTheDocument(); expect(writes(calls)).toHaveLength(0);
  });

});
