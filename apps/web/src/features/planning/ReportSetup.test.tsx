import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alphaMembers, anna, created, deferred, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { categoryReport, TYPE_RUN } from '../work-categories/test/fixtures';
import { BASELINE_ID, PERIOD_A, PERIOD_B, RUN_ID, baseline, lostResponse, period, report, rootPath, routes, weekPath } from './test/fixtures';
import { choosePeriod, choosePicker, periodPicker, periodLabel } from './test/pickers';

beforeAll(async () => { await import('../../routes/WeeklyPage'); });

function reportRoutes() {
  return {
    ...routes(),
    [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]),
    [`GET ${rootPath}/report-runs`]: () => ok([report()]),
    [`GET ${rootPath}/report-runs/${RUN_ID}`]: () => ok(report()),
    [`GET ${rootPath}/report-runs/${RUN_ID}/rows`]: () => ok([]),
    [`GET ${rootPath}/work-type-report-runs`]: () => ok([categoryReport()]),
    [`GET ${rootPath}/work-type-report-runs/${TYPE_RUN}`]: () => ok(categoryReport()),
    [`GET ${rootPath}/work-type-report-runs/${TYPE_RUN}/rows`]: () => ok([]),
  };
}

describe('results-first saved reports', () => {
  it.each([
    { view: 'report', parameter: `run=${RUN_ID}`, result: 'Saved report' },
    { view: 'work-types', parameter: `typeRun=${TYPE_RUN}`, result: 'Saved breakdown' },
  ])('keeps $view results visible and setup collapsed until an explicit action, without calculating', async ({ view, parameter, result }) => {
    const savedRun = deferred<Response>();
    const readPath = view === 'report' ? `${rootPath}/report-runs/${RUN_ID}` : `${rootPath}/work-type-report-runs/${TYPE_RUN}`;
    const { calls } = installFakeApi({ ...reportRoutes(), [`GET ${readPath}`]: () => savedRun.promise });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=${view}&${parameter}`);
    // Wait for the weekly route before testing the independently loaded pinned result.
    const button = await screen.findByRole('button', { name: 'Set up new report' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'New report settings' })).not.toBeInTheDocument();
    expect(screen.getByText(view === 'report' ? 'Loading saved report…' : 'Loading saved breakdown…')).toBeInTheDocument();
    expect(calls.filter(call => call.path === readPath && call.method === 'GET')).toHaveLength(1);
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    await act(async () => savedRun.resolve(ok(view === 'report' ? report() : categoryReport())));
    expect(await screen.findByRole('region', { name: result })).toBeInTheDocument();
    await user.click(button);
    expect(screen.getByRole('region', { name: 'New report settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide report setup' }));
    expect(screen.queryByRole('region', { name: 'New report settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: result })).toBeInTheDocument();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it.each([false, true])('retains page-owned open/dirty state through an actual period-loading unmount (dirty=%s)', async dirty => {
    const gate = deferred<Response>();
    const { calls } = installFakeApi({ ...reportRoutes(), [`GET ${rootPath}/periods/${PERIOD_B}`]: () => gate.promise });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${RUN_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Set up new report' }));
    if (dirty) await user.click(screen.getByRole('checkbox', { name: /Compare only known personal plans/ }));
    const setup = screen.getByRole('region', { name: 'New report settings' });
    expect(within(setup).getByRole('checkbox', { name: /Compare only known personal plans/ })).toHaveProperty('checked', dirty);
    await choosePeriod(user, PERIOD_B);
    expect(await screen.findByText('Loading selected week…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Weekly report' })).not.toBeInTheDocument();
    await act(async () => gate.resolve(ok(period(PERIOD_B))));
    await screen.findByText('Save a personal or project baseline before calculating a comparison.');
    await choosePeriod(user, PERIOD_A);
    await screen.findByRole('combobox', { name: /^Saved report$/ });
    await choosePicker(user, /^Saved report$/, /· Project plan · all selected people$/);
    const restored = screen.getByRole('region', { name: 'New report settings' });
    expect(within(restored).getByRole('checkbox', { name: /Compare only known personal plans/ })).toHaveProperty('checked', dirty);
    if (dirty) {
      expect(within(restored).getByText('Report settings have unsaved changes.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Hide report setup' })).toBeDisabled();
    } else expect(screen.getByRole('button', { name: 'Hide report setup' })).toBeEnabled();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('retains an unsent work-type cohort and open setup through the period-loading unmount', async () => {
    const colleague = alphaMembers[1]; if (!colleague) throw new Error('Missing colleague');
    const gate = deferred<Response>();
    const { calls } = installFakeApi({ ...reportRoutes(), [`GET ${rootPath}/periods/${PERIOD_B}`]: () => gate.promise });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=work-types&typeRun=${TYPE_RUN}`);
    await user.click(await screen.findByRole('button', { name: 'Set up new report' }));
    await user.click(within(screen.getByRole('region', { name: 'New report settings' })).getByRole('checkbox', { name: colleague.displayName }));
    await choosePeriod(user, PERIOD_B);
    expect(await screen.findByText('Loading selected week…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Recorded hours breakdown' })).not.toBeInTheDocument();
    await act(async () => gate.resolve(ok(period(PERIOD_B))));
    await screen.findByRole('button', { name: 'Calculate hours breakdown' });
    await choosePeriod(user, PERIOD_A);
    await screen.findByRole('combobox', { name: /^Saved breakdown$/ });
    await choosePicker(user, /^Saved breakdown$/, /· 2h$/);
    const setup = screen.getByRole('region', { name: 'New report settings' });
    expect(within(setup).getByRole('checkbox', { name: colleague.displayName })).toBeChecked();
    expect(within(setup).getByText('Report settings have unsaved changes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide report setup' })).toBeDisabled();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('keeps the plan view when a report calculation finishes after an explicit tab change', async () => {
    const gate = deferred<Response>();
    installFakeApi({ ...reportRoutes(), [`POST ${rootPath}/report-runs`]: () => gate.promise });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${RUN_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Set up new report' }));
    await user.click(screen.getByRole('button', { name: 'Calculate new report' }));
    await user.click(screen.getByRole('button', { name: 'Plan and hours' }));
    await act(async () => gate.resolve(created(report())));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open original save' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Plan and hours' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('region', { name: 'Saved report' })).not.toBeInTheDocument();
  });

  it('does not replace another explicitly selected saved breakdown with a late calculation result', async () => {
    const gate = deferred<Response>();
    // A distinct saved total keeps the two picker options distinguishable by their visible text.
    const other = { ...categoryReport(), id: 'fb000000-0000-4000-8000-000000000002', totalActualMinutes: 60 };
    installFakeApi({ ...reportRoutes(), [`GET ${rootPath}/work-type-report-runs`]: () => ok([categoryReport(), other]), [`GET ${rootPath}/work-type-report-runs/${other.id}`]: () => ok(other), [`GET ${rootPath}/work-type-report-runs/${other.id}/rows`]: () => ok([]), [`POST ${rootPath}/work-type-report-runs`]: () => gate.promise });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=work-types&typeRun=${TYPE_RUN}`);
    await user.click(await screen.findByRole('button', { name: 'Set up new report' }));
    await user.click(screen.getByRole('button', { name: 'Calculate hours breakdown' }));
    await choosePicker(user, /^Saved breakdown$/, /· 1h$/);
    await screen.findByRole('region', { name: 'Saved breakdown' });
    await act(async () => gate.resolve(created(categoryReport())));
    await waitFor(() => expect(screen.queryByText('These settings stay visible until the calculation is confirmed.')).not.toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: /^Saved breakdown$/ })).toHaveTextContent(/· 1h$/);
  });

  it.each([
    { view: 'report', parameter: `run=${RUN_ID}`, endpoint: 'report-runs', calculate: 'Calculate new report', response: report },
    { view: 'work-types', parameter: `typeRun=${TYPE_RUN}`, endpoint: 'work-type-report-runs', calculate: 'Calculate hours breakdown', response: categoryReport },
  ])('keeps the chosen next period when a pending $view calculation confirms the previous period', async ({ view, parameter, endpoint, calculate, response }) => {
    const gate = deferred<Response>();
    const { calls } = installFakeApi({ ...reportRoutes(), [`POST ${rootPath}/${endpoint}`]: () => gate.promise });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=${view}&${parameter}`);
    await user.click(await screen.findByRole('button', { name: 'Set up new report' }));
    await user.click(within(screen.getByRole('region', { name: 'New report settings' })).getByRole('button', { name: calculate }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toHaveLength(1));
    await choosePeriod(user, PERIOD_B);
    await waitFor(() => expect(periodPicker()).toHaveTextContent(periodLabel(PERIOD_B)));
    await screen.findByRole('region', { name: 'New report settings' });
    await act(async () => gate.resolve(created(response())));
    await waitFor(() => expect(screen.queryByText('These settings stay visible until the calculation is confirmed.')).not.toBeInTheDocument());
    expect(periodPicker()).toHaveTextContent(periodLabel(PERIOD_B));
    expect(screen.getByRole('button', { name: view === 'report' ? /^Report$/ : /^Work types$/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('region', { name: view === 'report' ? 'Saved report' : 'Saved breakdown' })).not.toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it.each([
    { view: 'report', parameter: `run=${RUN_ID}`, endpoint: 'report-runs', calculate: 'Calculate new report', result: 'Saved report', response: report },
    { view: 'work-types', parameter: `typeRun=${TYPE_RUN}`, endpoint: 'work-type-report-runs', calculate: 'Calculate hours breakdown', result: 'Saved breakdown', response: categoryReport },
  ])('keeps unresolved $view setup visible and retries the exact original request after a period switch', async ({ view, parameter, endpoint, calculate, result, response }) => {
    const colleague = alphaMembers[1]; if (!colleague) throw new Error('Missing colleague');
    const gate = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi({ ...reportRoutes(), [`POST ${rootPath}/${endpoint}`]: () => ++attempts === 1 ? gate.promise : created(response()) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=${view}&${parameter}`);
    await user.click(await screen.findByRole('button', { name: 'Set up new report' }));
    let setup = screen.getByRole('region', { name: 'New report settings' });
    await user.click(within(setup).getByRole('checkbox', { name: colleague.displayName }));
    await user.click(within(setup).getByRole('button', { name: calculate }));
    await waitFor(() => expect(attempts).toBe(1));
    expect(screen.getByRole('button', { name: 'Hide report setup' })).toBeDisabled();
    expect(within(setup).getByRole('checkbox', { name: colleague.displayName })).toBeDisabled();
    await choosePeriod(user, PERIOD_B);
    await act(async () => gate.lose());
    await user.click(await screen.findByRole('button', { name: 'Open original save' }));
    setup = await screen.findByRole('region', { name: 'New report settings' });
    expect(periodPicker()).toHaveTextContent(periodLabel(PERIOD_A));
    expect(within(setup).getByRole('checkbox', { name: colleague.displayName })).toBeChecked();
    await user.click(within(setup).getByRole('button', { name: 'Retry original save' }));
    await waitFor(() => expect(attempts).toBe(2));
    await screen.findByRole('region', { name: result });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New report settings' })).not.toBeInTheDocument());
    const writes = calls.filter(call => call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[1]?.path).toBe(writes[0]?.path);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    expect(writes[0]?.body).toEqual(endpoint === 'report-runs' ? { baselineId: BASELINE_ID, knownEstimatesOnly: false, membershipIds: [colleague.id] } : { periodId: PERIOD_A, membershipIds: [colleague.id] });
    await user.click(screen.getByRole('button', { name: 'Set up new report' }));
    expect(screen.getByRole('checkbox', { name: colleague.displayName })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: anna.displayName })).not.toBeChecked();
  });
});
