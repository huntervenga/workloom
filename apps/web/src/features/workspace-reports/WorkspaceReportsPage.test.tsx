import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { WorkspaceReportQueryInput } from '@workloom/contracts';
import { alpha, deferred, failure, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { routes } from '../generic-reports/test/fixtures';
import { dashboardResult, discovery } from './test/fixtures';
import { dashboardSearch, defaultDashboardInput } from './state';
const path = `/api/v1/workspaces/${alpha.id}/workspace-reports`;
const ui = `/w/${alpha.id}/reports`;
function selectedPath() { const input = defaultDashboardInput(discovery()); if (!input) throw new Error('fixture'); return `${ui}?${dashboardSearch(new URLSearchParams(), input)}`; }

describe('workspace Reports page', () => {
  it.each(['owner', 'member'] as const)('guides %s to configure unknown capacity without inventing working hours', async role => {
    const data = dashboardResult(); data.capacity.settingsConfigured = false;
    installFakeApi(routes({ [`GET /api/v1/workspaces/${alpha.id}`]: () => ok({ ...alpha, role }), [`GET ${path}/sources`]: () => ok(discovery()), [`POST ${path}/query`]: () => ok(data) }));
    renderApp(selectedPath()); const card = await screen.findByRole('article', { name: 'Available capacity' });
    expect(card).toHaveTextContent('—');
    if (role === 'owner') expect(within(card).getByRole('link', { name: 'Set up working schedules' })).toHaveAttribute('href', `/w/${alpha.id}/time-off`);
    else { expect(card).toHaveTextContent('Ask a workspace administrator'); expect(within(card).queryByRole('link', { name: 'Set up working schedules' })).not.toBeInTheDocument(); }
  });
  it('opens from workspace navigation, builds one dashboard and changes people/range/buckets by read-only requests', async () => {
    const requested: WorkspaceReportQueryInput[] = [];
    const { calls } = installFakeApi(routes({ [`GET ${path}/sources`]: () => ok(discovery()), [`POST ${path}/query`]: request => { const input = request.body as WorkspaceReportQueryInput; requested.push(input); return ok({ ...dashboardResult(), range: input.range, bucket: input.bucket }); } }));
    const { user } = renderApp(selectedPath());
    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeVisible();
    expect(await screen.findByRole('region', { name: 'Workspace overview' })).toBeVisible();
    expect(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: 'Reports' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('combobox', { name: 'Chart interval' })); await user.click(screen.getByRole('option', { name: 'Monthly' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('region', { name: 'Monthly trend' })).toBeVisible();
    expect(requested.at(-1)?.bucket).toBe('month'); expect(requested.at(-1)?.sources).toEqual(defaultDashboardInput(discovery())?.sources);
    const person = discovery().members[0]; if (!person) throw new Error('fixture');
    await user.click(screen.getByRole('button', { name: person.displayName }));
    await waitFor(() => expect(requested.at(-1)?.people).toEqual({ kind: 'selected', membershipIds: [person.membershipId] }));
    expect(calls.filter(call => call.method !== 'GET').every(call => call.method === 'POST' && call.path === `${path}/query`)).toBe(true);
  });
  it('does not query or broaden an invalid explicit URL and provides an explicit reset', async () => {
    const { calls } = installFakeApi(routes({ [`GET ${path}/sources`]: () => ok(discovery()), [`POST ${path}/query`]: () => ok(dashboardResult()) }));
    const { user } = renderApp(`${ui}?dashboard=broken`);
    expect(await screen.findByRole('alert')).toHaveTextContent('This dashboard link has invalid settings');
    expect(calls.filter(call => call.path === `${path}/query`)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Reset view' })); expect(await screen.findByRole('region', { name: 'Workspace overview' })).toBeVisible();
  });
  it('hides previously rendered charts when report access is denied on a refresh', async () => {
    let denied = false;
    installFakeApi(routes({ [`GET ${path}/sources`]: () => ok(discovery()), [`POST ${path}/query`]: () => denied ? failure(403, 'FORBIDDEN', 'Private server details') : ok(dashboardResult()) }));
    const { user } = renderApp(selectedPath()); expect(await screen.findByRole('region', { name: 'Workspace overview' })).toBeVisible();
    denied = true; await user.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
    expect(await screen.findByRole('alert')).toBeVisible(); expect(screen.queryByRole('region', { name: 'Workspace overview' })).not.toBeInTheDocument(); expect(screen.queryByText('Private server details')).not.toBeInTheDocument();
  });
  it('recovers a stale report revision only after explicit reload, keeping the same selected report identity', async () => {
    let revision = 1; const requested: WorkspaceReportQueryInput[] = [];
    const original = discovery(); const report = original.sources[0]; if (!report) throw new Error('fixture');
    installFakeApi(routes({ [`GET ${path}/sources`]: () => ok({ ...original, sources: [{ ...report, report: { ...report.report, revision } }] }), [`POST ${path}/query`]: request => { const input = request.body as WorkspaceReportQueryInput; requested.push(input); return input.sources[0]?.expectedRevision === revision ? ok(dashboardResult()) : failure(409, 'REVISION_CONFLICT', 'Changed'); } }));
    const { user } = renderApp(selectedPath()); expect(await screen.findByRole('region', { name: 'Workspace overview' })).toBeVisible();
    revision = 2; await user.click(screen.getByRole('button', { name: 'Refresh dashboard' })); expect(await screen.findByRole('alert')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload source mappings' }));
    expect(await screen.findByRole('region', { name: 'Workspace overview' })).toBeVisible();
    expect(requested.at(-1)?.sources).toEqual([{ reportId: report.report.id, expectedRevision: 2 }]);
  });
  it.each(['revision', 'missing'] as const)('does not overwrite a newer dashboard URL when an older source reload finishes late: %s', async outcome => {
    let revision = 1, reads = 0; const requested: WorkspaceReportQueryInput[] = [];
    const original = discovery(), pending = deferred<Response>();
    const report = original.sources[0]; if (!report) throw new Error('fixture');
    installFakeApi(routes({ [`GET ${path}/sources`]: () => ++reads === 2 ? pending.promise : ok({ ...original, sources: [{ ...report, report: { ...report.report, revision } }] }), [`POST ${path}/query`]: request => { const input = request.body as WorkspaceReportQueryInput; requested.push(input); return input.sources[0]?.expectedRevision === revision ? ok({ ...dashboardResult(), bucket: input.bucket }) : failure(409, 'REVISION_CONFLICT', 'Changed'); } }));
    const { user } = renderApp(selectedPath()); expect(await screen.findByRole('region', { name: 'Workspace overview' })).toBeVisible();
    revision = 2; await user.click(screen.getByRole('button', { name: 'Refresh dashboard' })); expect(await screen.findByRole('alert')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload source mappings' }));
    await user.click(screen.getByRole('combobox', { name: 'Chart interval' })); await user.click(screen.getByRole('option', { name: 'Monthly' })); await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(requested.at(-1)?.bucket).toBe('month'));
    pending.resolve(ok({ ...original, sources: outcome === 'missing' ? [] : [{ ...report, report: { ...report.report, revision: 2 } }] }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload source mappings' })).toBeEnabled());
    expect(requested.at(-1)?.sources[0]?.expectedRevision).toBe(1);
    expect(screen.queryByText(/A selected report is no longer available/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload source mappings' }));
    expect(await screen.findByRole('region', { name: 'Monthly trend' })).toBeVisible();
    expect(requested.at(-1)?.sources[0]?.expectedRevision).toBe(2); expect(requested.at(-1)?.bucket).toBe('month');
  });
  it('removes an unavailable source and chooses its replacement without resetting the selected person or dates', async () => {
    let missing = false; const requested: WorkspaceReportQueryInput[] = []; const original = discovery();
    const source = original.sources[0], person = original.members[0]; if (!source || !person) throw new Error('fixture');
    const replacementId = 'ed000000-0000-4000-8000-000000000099';
    const replacement = { ...source, report: { ...source.report, id: replacementId, name: 'New field mapping' } };
    installFakeApi(routes({ [`GET ${path}/sources`]: () => ok({ ...original, sources: missing ? [replacement] : original.sources }), [`POST ${path}/query`]: request => { const input = request.body as WorkspaceReportQueryInput; requested.push(input); return missing && input.sources.some(binding => binding.reportId === source.report.id) ? failure(404, 'NOT_FOUND', 'Missing') : ok(dashboardResult()); } }));
    const base = defaultDashboardInput(original); if (!base) throw new Error('fixture');
    const initial = { ...base, range: { from: '2026-02-01', to: '2026-05-31' }, people: { kind: 'selected' as const, membershipIds: [person.membershipId] } };
    const { user } = renderApp(`${ui}?${dashboardSearch(new URLSearchParams(), initial)}`); expect(await screen.findByRole('region', { name: 'Workspace overview' })).toBeVisible();
    missing = true; await user.click(screen.getByRole('button', { name: 'Refresh dashboard' })); expect(await screen.findByRole('alert')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload source mappings' }));
    await user.click(await screen.findByRole('button', { name: `Remove unavailable source ${source.report.id}` }));
    await user.click(screen.getByRole('checkbox', { name: 'Include Delivery' })); await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('region', { name: 'Workspace overview' })).toBeVisible();
    expect(requested.at(-1)?.sources).toEqual([{ reportId: replacementId, expectedRevision: 1 }]);
    expect(requested.at(-1)?.range).toEqual(initial.range); expect(requested.at(-1)?.people).toEqual(initial.people);
  });
  it('never replaces an archived selected report with another discovered report during recovery', async () => {
    let missing = false; const original = discovery();
    installFakeApi(routes({ [`GET ${path}/sources`]: () => ok(missing ? { ...original, sources: [] } : original), [`POST ${path}/query`]: () => missing ? failure(404, 'NOT_FOUND', 'Missing') : ok(dashboardResult()) }));
    const { user } = renderApp(selectedPath()); expect(await screen.findByRole('region', { name: 'Workspace overview' })).toBeVisible();
    missing = true; await user.click(screen.getByRole('button', { name: 'Refresh dashboard' })); expect(await screen.findByRole('alert')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload source mappings' }));
    expect(await screen.findByText(/A selected report is no longer available/)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Workspace overview' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset view' })); expect(await screen.findByText('Connect your project reports')).toBeVisible();
  });
});
