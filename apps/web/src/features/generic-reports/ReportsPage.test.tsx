import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, created, failure, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
import { reportKeys } from './queries';
import { heldResponse } from '../fields/test/fixtures';
import { amount, definition, fact, plan, PROJECT_ID, REPORT_ID, reportPath, result, rootPath, routes, snapshot, tablePath, uiPath } from './test/fixtures';
async function choose(user: ReturnType<typeof renderApp>['user'], label: string, option: string) { await user.click(screen.getByRole('combobox', { name: label })); await user.click(within(screen.getByRole('listbox', { name: label })).getByRole('option', { name: option })); }
beforeAll(async () => { await import('../../routes/ReportsPage'); await import('../../routes/ProjectPage'); });
async function selectReport(user: ReturnType<typeof renderApp>['user']) { await screen.findByRole('button', { name: 'New report' }); await waitFor(() => expect(screen.getByRole('button', { name: 'New report' })).toBeEnabled()); await choose(user, 'Saved reports', 'Budget review'); await screen.findByRole('heading', { name: 'Results' }); }
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.method !== 'GET' && !call.path.endsWith('/query') && !call.path.endsWith('/field-aggregates'));

describe('ordinary fields and saved full-scope reports', () => {
  it('shows ordinary columns without Week, Person, native estimate or preference writes; legacy requires an explicit action', async () => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await screen.findByRole('columnheader', { name: 'Budget' });
    expect(screen.queryByRole('combobox', { name: 'Week for hours' })).not.toBeInTheDocument(); expect(screen.queryByRole('combobox', { name: 'Whose hours to show' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Hours Est' })).not.toBeInTheDocument(); expect(screen.queryByText('Loaded team budget')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', uiPath);
    expect(writes(calls)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Legacy time columns' }));
    expect(await screen.findByRole('combobox', { name: 'Week for hours' })).toBeVisible();
    expect(writes(calls)).toHaveLength(0);
  });
  it('creates a saved report with stable field IDs, All time by default and selected calculation; reload uses server definition', async () => {
    let saved = definition(); const { calls } = installFakeApi(routes({ [`GET ${reportPath}`]: () => ok([saved]), [`GET ${reportPath}/${REPORT_ID}`]: () => ok(saved), [`POST ${reportPath}`]: request => { const input = request.body as { name: string; config: typeof saved.config }; saved = { ...saved, ...input }; return created(saved); } }));
    const { user } = renderApp(uiPath); await user.click(await screen.findByRole('button', { name: 'New report' }));
    await user.type(screen.getByRole('textbox', { name: 'Report name' }), 'A / B');
    await choose(user, 'Calculation 1', 'Sum'); await choose(user, 'Value field 1', 'Budget');
    expect(screen.getByRole('combobox', { name: 'Date filter' })).toHaveTextContent('All time');
    await user.click(screen.getByRole('button', { name: 'Save report' })); await screen.findByRole('heading', { name: 'A / B' });
    expect(writes(calls)[0]?.body).toEqual({ name: 'A / B', config: { ...definition().config, measures: [{ key: 'tasks', operation: 'sum', fieldId: plan.id }], comparison: null } });
    await user.click(screen.getByRole('button', { name: 'Edit report' })); expect(screen.getByRole('textbox', { name: 'Report name' })).toHaveValue('A / B'); expect(screen.getByRole('combobox', { name: 'Value field 1' })).toHaveTextContent('Budget');
  });
  it('uses authoritative totals, exact ratio and coverage across detail pages, sending expected source version', async () => {
    const { calls } = installFakeApi(routes({ [`POST ${reportPath}/${REPORT_ID}/query`]: request => { const offset = (request.body as { offset: number }).offset; return ok({ ...result(), offset, nextOffset: offset === 0 ? 1 : null }); } }));
    const { user } = renderApp(uiPath); await selectReport(user);
    const results = screen.getByRole('region', { name: 'Results' });
    expect(within(results).getByText('18h 51m')).toBeVisible(); expect(within(results).getByText('1.172413793103')).toBeVisible(); // Exact server decimal, never a browser row sum.
    expect(within(results).getByText('60/63 filled · 2 missing · 1 cleared · 1 zero')).toBeVisible();
    expect(within(results).getByText('7 paired of 8 eligible tasks. Both comparison sums use these same complete pairs.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(calls.filter(call => call.path.endsWith('/query'))).toHaveLength(2));
    expect(calls.filter(call => call.path.endsWith('/query'))[1]?.body).toEqual({ expectedRevision: 1, snapshotId: null, offset: 1, limit: 100, expectedSourceVersion: 'a'.repeat(64) });
    expect(await screen.findByText('18h 51m')).toBeVisible();
    expect(calls.filter(call => call.path.endsWith('/query')).every(call => !call.headers.has('Idempotency-Key'))).toBe(true);
  });
  it('retains a report draft across a newer definition and retries an unknown update with identical body and key', async () => {
    const gate = heldResponse(); let attempts = 0; const saved = definition();
    const { calls } = installFakeApi(routes({ [`PATCH ${reportPath}/${REPORT_ID}`]: request => { attempts += 1; const input = request.body as { name: string; config: typeof saved.config }; return attempts === 1 ? gate.promise : ok({ ...saved, name: input.name, config: input.config, revision: 2 }); } }));
    const { user, queryClient } = renderApp(uiPath); await selectReport(user); await user.click(screen.getByRole('button', { name: 'Edit report' }));
    const name = screen.getByRole('textbox', { name: 'Report name' }); await user.clear(name); await user.type(name, 'Kept draft');
    act(() => queryClient.setQueryData(reportKeys.definition('11111111-1111-4111-8111-111111111111', alpha.id, REPORT_ID), { ...saved, name: 'Remote name', revision: 7 }));
    expect(name).toHaveValue('Kept draft'); await user.click(screen.getByRole('button', { name: 'Save report' })); await waitFor(() => expect(attempts).toBe(1));
    expect(name).toBeDisabled(); await act(async () => gate.lose());
    await user.click(await screen.findByRole('button', { name: 'Retry exact submission' })); await waitFor(() => expect(attempts).toBe(2));
    const requests = writes(calls); expect(requests[0]?.body).toEqual({ expectedRevision: 1, name: 'Kept draft', config: saved.config, archived: false }); expect(requests[1]?.body).toEqual(requests[0]?.body); expect(requests[1]?.headers.get('Idempotency-Key')).toBe(requests[0]?.headers.get('Idempotency-Key'));
  });
  it('captures only after explicit confirmation using the current source version, then separates frozen totals from retained accuracy', async () => {
    const initial = snapshot(); let captured = false;
    const { calls } = installFakeApi(routes({ [`GET ${reportPath}/${REPORT_ID}/initial-snapshots`]: () => ok(captured ? [initial] : []), [`POST ${reportPath}/${REPORT_ID}/initial-snapshots`]: () => { captured = true; return created(initial); }, [`POST ${reportPath}/${REPORT_ID}/query`]: request => ok((request.body as { snapshotId: string | null }).snapshotId ? { ...result(), initialSnapshot: initial, initialMeasures: [{ ...result().measures[0], key: 'original', value: amount(900) }], initialComparison: { ...result().comparison, plan: amount(120), fact: amount(200), difference: amount(80) }, cohorts: { initial: 60, retained: 58, added: 5, removed: 2 } } : result()) }));
    const { user } = renderApp(uiPath); await selectReport(user); await user.click(screen.getByRole('button', { name: 'Capture initial snapshot' }));
    expect(writes(calls)).toHaveLength(0); await user.type(screen.getByRole('textbox', { name: 'Snapshot name' }), 'Initial scope'); await user.click(screen.getByRole('button', { name: 'Save immutable snapshot' }));
    expect(await screen.findByText('60 originally included · 58 retained · 5 added · 2 removed from scope')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Original full-scope totals' })).toHaveTextContent('15h'); expect(screen.getByText('Original plan vs current actual · retained paired tasks')).toBeVisible();
    expect(writes(calls)[0]?.body).toEqual({ name: 'Initial scope', expectedRevision: 1, expectedSourceVersion: 'a'.repeat(64) });
  });
  it('previews ordinary fields without writes and applies only the atomic template endpoint', async () => {
    const { calls } = installFakeApi(routes({ [`POST ${rootPath}/projects/${PROJECT_ID}/plan-fact-template`]: () => created({ fields: [plan, fact], columns: { workspaceId: alpha.id, projectId: PROJECT_ID, revision: 4, columns: [plan, fact].map((field, position) => ({ fieldId: field.id, visible: true, position, width: 160 })) }, report: definition() }) }));
    const { user } = renderApp(uiPath); await user.click(await screen.findByRole('button', { name: 'Preview Plan and fact' }));
    expect(writes(calls)).toHaveLength(0); const name = screen.getByRole('textbox', { name: 'Plan column name' }); await user.clear(name); await user.type(name, 'A');
    const other = screen.getByRole('textbox', { name: 'Fact column name' }); await user.clear(other); await user.type(other, 'B'); await user.click(screen.getByRole('button', { name: 'Apply template' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1)); expect(writes(calls)[0]?.path).toBe(`${rootPath}/projects/${PROJECT_ID}/plan-fact-template`); expect(writes(calls)[0]?.body).toEqual({ planName: 'A', factName: 'B', reportName: 'Plan and fact', expectedColumnsRevision: 3 });
  });
  it('hides previously rendered results after a current report denial and offers no mutation', async () => {
    let denied = false; installFakeApi(routes({ [`POST ${reportPath}/${REPORT_ID}/query`]: () => denied ? failure(403, 'FORBIDDEN', 'Private diagnostic') : ok(result()) }));
    const { user, queryClient } = renderApp(uiPath); await selectReport(user); denied = true;
    await act(async () => queryClient.invalidateQueries({ queryKey: reportKeys.root('11111111-1111-4111-8111-111111111111', alpha.id) }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Results' })).not.toBeInTheDocument()); expect(screen.queryByText('Only loaded detail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit report' })).toBeDisabled();
  });
  it('keeps explicit report intent and draft when workspace permission is refreshing or revoked', async () => {
    const { calls } = installFakeApi(routes()); const { user, queryClient } = renderApp(uiPath); await selectReport(user); await user.click(screen.getByRole('button', { name: 'Edit report' }));
    await user.type(screen.getByRole('textbox', { name: 'Report name' }), ' local');
    act(() => queryClient.setQueryData(queryKeys.workspace('11111111-1111-4111-8111-111111111111', alpha.id), { ...alpha, role: 'viewer' }));
    expect(screen.getByRole('textbox', { name: 'Report name' })).toHaveValue('Budget review local'); expect(screen.getByRole('button', { name: 'Save report' })).toBeDisabled(); expect(writes(calls)).toHaveLength(0);
  });
  it('rejects a report from another project selected through this project URL before querying or editing it', async () => {
    const wrong = { ...definition(), projectId: 'e0000000-0000-4000-8000-000000000099', config: { ...definition().config, projectId: 'e0000000-0000-4000-8000-000000000099' } };
    const { calls } = installFakeApi(routes({ [`GET ${reportPath}/${REPORT_ID}`]: () => ok(wrong) }));
    renderApp(`${uiPath}?report=${REPORT_ID}`);
    expect(await screen.findByText('This report belongs to another project. Choose a report from this project.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit report' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Capture initial snapshot' })).not.toBeInTheDocument();
    expect(calls.some(call => call.path.endsWith('/query'))).toBe(false); expect(writes(calls)).toHaveLength(0);
  });

  it.each([null, '2026-10-18T10:00:00.000Z'])('blocks an existing active or archived column name before any template write (%s)', async archivedAt => {
    const reserved = { ...plan, archivedAt };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/fields`]: () => ok([reserved, fact]) }));
    const { user } = renderApp(uiPath); const preview = await screen.findByRole('button', { name: 'Preview Plan and fact' }); await waitFor(() => expect(preview).toBeEnabled()); await user.click(preview);
    const name = screen.getByRole('textbox', { name: 'Plan column name' }); await user.clear(name); await user.type(name, '  bUdGeT  ');
    expect(screen.getByText('A column named “Budget” already exists, including archived columns. Choose a unique name. To compare existing columns, use New report.')).toBeVisible(); expect(screen.getByRole('button', { name: 'Apply template' })).toBeDisabled(); expect(writes(calls)).toHaveLength(0);
    await user.clear(name); await user.type(name, 'Budget 2'); expect(screen.getByRole('button', { name: 'Apply template' })).toBeEnabled(); expect(writes(calls)).toHaveLength(0);
  });
  it('keeps a held template retry exact when the first attempt may already have reserved its names', async () => {
    const gate = heldResponse(); let attempts = 0;
    const madePlan = { ...plan, id: '90000000-0000-4000-8000-000000000003', name: 'A' }, madeFact = { ...fact, id: '90000000-0000-4000-8000-000000000004', name: 'B' };
    let catalog = [plan, fact];
    const response = { fields: [madePlan, madeFact], columns: { workspaceId: alpha.id, projectId: PROJECT_ID, revision: 5, columns: [plan, fact, madePlan, madeFact].map((field, position) => ({ fieldId: field.id, position, width: 160, visible: true })) }, report: definition() };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/fields`]: () => ok(catalog), [`POST ${rootPath}/projects/${PROJECT_ID}/plan-fact-template`]: () => { attempts++; catalog = [plan, fact, madePlan, madeFact]; return attempts === 1 ? gate.promise : created(response); } }));
    const { user, queryClient } = renderApp(uiPath); const preview = await screen.findByRole('button', { name: 'Preview Plan and fact' }); await waitFor(() => expect(preview).toBeEnabled()); await user.click(preview);
    for (const [label, value] of [['Plan column name', 'A'], ['Fact column name', 'B']] as const) { const input = screen.getByRole('textbox', { name: label }); await user.clear(input); await user.type(input, value); }
    await user.click(screen.getByRole('button', { name: 'Apply template' })); await waitFor(() => expect(attempts).toBe(1));
    await act(async () => queryClient.invalidateQueries({ queryKey: queryKeys.fieldDefinitions('11111111-1111-4111-8111-111111111111', alpha.id, PROJECT_ID), exact: true })); await act(async () => gate.lose());
    const retry = await screen.findByRole('button', { name: 'Retry exact submission' }); await waitFor(() => expect(retry).toBeEnabled()); await user.click(retry); await waitFor(() => expect(attempts).toBe(2));
    const requests = writes(calls); expect(requests).toHaveLength(2); expect(requests[1]?.body).toEqual(requests[0]?.body); expect(requests[1]?.headers.get('Idempotency-Key')).toBe(requests[0]?.headers.get('Idempotency-Key')); expect(requests[0]?.body).toEqual({ planName: 'A', factName: 'B', reportName: 'Plan and fact', expectedColumnsRevision: 3 });
  });

});
