import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, failure, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
import { reportKeys } from './queries';
import { calendarRange } from './ReportConfigEditor';
import { definition, fact, plan, PROJECT_ID, REPORT_ID, reportPath, result, rootPath, routes, tablePath, uiPath } from './test/fixtures';
async function choose(user: ReturnType<typeof renderApp>['user'], label: string, option: string) { await user.click(screen.getByRole('combobox', { name: label })); await user.click(within(screen.getByRole('listbox', { name: label })).getByRole('option', { name: option })); }
beforeAll(async () => { await import('../../routes/ReportsPage'); await import('../../routes/ProjectPage'); });
async function edit(user: ReturnType<typeof renderApp>['user']) { await screen.findByRole('button', { name: 'New report' }); await waitFor(() => expect(screen.getByRole('button', { name: 'New report' })).toBeEnabled()); await choose(user, 'Saved reports', 'Budget review'); await user.click(await screen.findByRole('button', { name: 'Edit report' })); }
describe('report scope, renamed sources and authoritative column totals', () => {
  it('keeps renamed field identity, supports inclusive date presets/custom ranges and All time without writing a period', async () => {
    let saved = definition(); const renamed = { ...plan, name: 'A renamed source', revision: 2 };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/fields`]: () => ok([renamed, fact]), [`GET ${reportPath}/${REPORT_ID}`]: () => ok(saved), [`PATCH ${reportPath}/${REPORT_ID}`]: request => { const body = request.body as { name: string; config: typeof saved.config }; saved = { ...saved, name: body.name, config: body.config, revision: 2 }; return ok(saved); } }));
    const { user } = renderApp(uiPath); await edit(user);
    const field = screen.getByRole('combobox', { name: 'Value field 1' }); expect(field).toHaveTextContent('A renamed source');
    await choose(user, 'Date filter', 'Due date');
    await choose(user, 'Range preset', 'This week');
    expect(screen.getByLabelText('From (inclusive)')).toHaveValue(calendarRange('week').from); expect(screen.getByLabelText('To (inclusive)')).toHaveValue(calendarRange('week').to);
    await user.clear(screen.getByLabelText('From (inclusive)')); await user.type(screen.getByLabelText('From (inclusive)'), '2026-10-12');
    await user.clear(screen.getByLabelText('To (inclusive)')); await user.type(screen.getByLabelText('To (inclusive)'), '2026-10-18');
    await user.click(screen.getByRole('button', { name: 'Save report' }));
    await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
    expect((calls.find(call => call.method === 'PATCH')?.body as { config: typeof saved.config }).config.filters.dateRange).toEqual({ source: { kind: 'due_date' }, from: '2026-10-12', to: '2026-10-18' });
    await user.click(await screen.findByRole('button', { name: 'Edit report' })); await choose(user, 'Date filter', 'All time');
    expect(screen.queryByLabelText('From (inclusive)')).not.toBeInTheDocument();
    expect(calls.filter(call => call.method !== 'GET' && !call.path.endsWith('/query') && !call.path.endsWith('/field-aggregates')).every(call => call.path.startsWith(reportPath))).toBe(true);
  });
  it('does not rebind a deleted source to a new field of the same name, and retains its unavailable stable ID', async () => {
    const replacement = { ...plan, id: '90000000-0000-4000-8000-000000000099' };
    installFakeApi(routes({ [`GET ${rootPath}/fields`]: () => ok([{ ...plan, archivedAt: '2026-10-18T10:00:00.000Z' }, fact, replacement]), [`POST ${reportPath}/${REPORT_ID}/query`]: () => failure(422, 'VALIDATION_ERROR', 'Old source unavailable') }));
    const { user } = renderApp(uiPath); await edit(user);
    expect(screen.getByRole('combobox', { name: 'Value field 1' })).toHaveTextContent('Unavailable or deleted field');
    expect(screen.getByText(/This report references an unavailable or archived field/)).toBeVisible();
  });
  it('renders full-scope server totals instead of loaded rows, with a separate own-section breakdown, and withholds unsupported search totals', async () => {
    const settings = { workspaceId: alpha.id, projectId: PROJECT_ID, revision: 2, measures: definition().config.measures };
    const totals = { ...result(), reportId: null, definitionRevision: null, config: { ...definition().config, groupBy: { kind: 'section' as const }, comparison: null }, groups: [{ key: 'no_section', label: 'No section', taskCount: 63, measures: result().measures, comparison: null, initialComparison: null }] };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/projects/${PROJECT_ID}/field-aggregate-settings`]: () => ok(settings), [`POST ${rootPath}/projects/${PROJECT_ID}/field-aggregates`]: () => ok(totals) }));
    const { user } = renderApp(tablePath); await waitFor(() => expect(document.querySelector('tfoot')).toHaveTextContent('18h 51m'));
    await user.click(screen.getByText('Column totals')); await waitFor(() => expect(screen.getByText('Column totals').closest('details')).toHaveAttribute('open')); await waitFor(() => expect(screen.getByRole('region', { name: 'Full project group totals · includes linked tasks' })).toHaveTextContent('18h 51m'));
    expect(screen.getByText('By each task’s own section · includes linked tasks; independent of the table’s inherited tree')).toBeVisible();
    const requests = calls.filter(call => call.path.endsWith('/field-aggregates')); expect(requests[0]?.body).toMatchObject({ config: { projectId: PROJECT_ID, groupBy: { kind: 'section' }, filters: { dateRange: null } }, offset: 0, limit: 1 });
    await user.type(screen.getByLabelText('Search tasks'), 'hidden');
    expect(await screen.findByText('Totals are unavailable for this search, participant, individual status or archived filter. Clear these filters or use Reports to define a supported scope.')).toBeVisible();
    expect(screen.queryByText('18h 51m')).not.toBeInTheDocument();
  });
  it('does not replace an unsent total configuration when server settings refresh and preserves expected revision', async () => {
    let settings = { workspaceId: alpha.id, projectId: PROJECT_ID, revision: 2, measures: definition().config.measures };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/projects/${PROJECT_ID}/field-aggregate-settings`]: () => ok(settings), [`POST ${rootPath}/projects/${PROJECT_ID}/field-aggregates`]: () => ok(result()), [`PUT ${rootPath}/projects/${PROJECT_ID}/field-aggregate-settings`]: () => failure(409, 'REVISION_CONFLICT', 'Stale settings') }));
    const { user, queryClient } = renderApp(tablePath); await screen.findAllByText('18h 51m'); await user.click(screen.getByText('Column totals')); await user.click(screen.getByRole('button', { name: 'Configure totals' }));
    await choose(user, 'Calculation 1', 'Average'); settings = { ...settings, revision: 7 };
    act(() => queryClient.setQueryData(reportKeys.settings('11111111-1111-4111-8111-111111111111', alpha.id, PROJECT_ID), settings));
    expect(screen.getByRole('combobox', { name: 'Calculation 1' })).toHaveTextContent('Average'); await user.click(screen.getByRole('button', { name: 'Save totals' }));
    await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true)); expect(calls.find(call => call.method === 'PUT')?.body).toEqual({ expectedRevision: 2, measures: [{ key: 'budget', operation: 'avg', fieldId: plan.id }] });
    expect(screen.getByRole('combobox', { name: 'Calculation 1' })).toHaveTextContent('Average');
  });
  it.each([403, 404, 500])('preserves an explicit aggregate-settings %s as an error instead of an empty default', async status => {
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/projects/${PROJECT_ID}/field-aggregate-settings`]: () => failure(status, status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', 'Never displayed diagnostic') }));
    const { user, queryClient } = renderApp(tablePath);
    await waitFor(() => expect(queryClient.getQueryState(reportKeys.settings('11111111-1111-4111-8111-111111111111', alpha.id, PROJECT_ID))?.status).toBe('error'));
    await user.click(screen.getByText('Column totals'));
    expect(calls.filter(call => call.path.endsWith('/field-aggregate-settings'))).toHaveLength(1);
    expect(calls.some(call => call.path.endsWith('/field-aggregates'))).toBe(false);
    expect(screen.queryByText('Never displayed diagnostic')).not.toBeInTheDocument();
    expect(screen.queryByText('18h 51m')).not.toBeInTheDocument();
  });

  it('removes already loaded aggregate values when the current field catalog is denied', async () => {
    let denied = false;
    installFakeApi(routes({ [`GET ${rootPath}/fields`]: () => denied ? failure(403, 'FORBIDDEN', 'Private fields') : ok([plan, fact]), [`GET ${rootPath}/projects/${PROJECT_ID}/field-aggregate-settings`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, revision: 2, measures: definition().config.measures }), [`POST ${rootPath}/projects/${PROJECT_ID}/field-aggregates`]: () => ok(result()) }));
    const { user, queryClient } = renderApp(tablePath); await waitFor(() => expect(document.querySelector('tfoot')).toHaveTextContent('18h 51m')); await user.click(screen.getByText('Column totals'));
    denied = true; await act(async () => queryClient.invalidateQueries({ queryKey: queryKeys.fieldDefinitions('11111111-1111-4111-8111-111111111111', alpha.id, PROJECT_ID), exact: true }));
    await waitFor(() => expect(queryClient.getQueryState(queryKeys.fieldDefinitions('11111111-1111-4111-8111-111111111111', alpha.id, PROJECT_ID))?.status).toBe('error'));
    expect(screen.queryAllByText('18h 51m')).toHaveLength(0); expect(screen.queryByRole('button', { name: 'Configure totals' })).not.toBeInTheDocument();
  });

  it('shows saved inclusive date, hierarchy and comparison scope to a viewer without opening the editor', async () => {
    const saved = definition(); saved.config = { ...saved.config, hierarchy: 'root_tasks', groupBy: { kind: 'assignee' }, filters: { ...saved.config.filters, statusGroups: ['done'], dateRange: { source: { kind: 'due_date' }, from: '2026-10-12', to: '2026-10-18' } } };
    installFakeApi(routes({ [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }), [`GET ${reportPath}/${REPORT_ID}`]: () => ok(saved), [`POST ${reportPath}/${REPORT_ID}/query`]: () => ok({ ...result(), config: saved.config, hierarchy: 'root_tasks' }) }));
    renderApp(`${uiPath}?report=${REPORT_ID}`);
    const scope = await screen.findByRole('region', { name: 'Report scope' });
    expect(scope).toHaveTextContent('Due date: 2026-10-12 through 2026-10-18 (inclusive)'); expect(scope).toHaveTextContent('Root tasks only'); expect(scope).toHaveTextContent('Current grouping: Primary assignee'); expect(scope).toHaveTextContent('Comparison: Completed tasks only'); expect(scope).toHaveTextContent('Completion: Completed');
    expect(screen.getByRole('button', { name: 'Edit report' })).toBeDisabled();
  });

});
