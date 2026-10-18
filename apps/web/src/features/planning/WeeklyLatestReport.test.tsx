import type { WeeklyPlanFactReportRunDto, WeeklyPlanFactRowDto, WorkTypeReportRunDto } from '@workloom/contracts';
import { categoryReport, TYPE_RUN } from '../work-categories/test/fixtures';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, installFakeApi, json, ok, project, renderApp, singleActorRoutes } from '../../test/fakeApi';
import { BASELINE_ID, MEMBER_ID, PACKAGE_ID, PERIOD_A, PERIOD_B, PERSONAL_BASELINE_ID, PROJECT_ID, RUN_ID, baseline, log, lostResponse, period, report, rootPath, routes, summary, weekPath } from './test/fixtures';
import { choosePeriod, choosePicker, periodPicker, periodLabel } from './test/pickers';
import type { UserEvent } from '@testing-library/user-event';
import { formatPeriodCutoff } from './dates';

beforeAll(async () => { await import('../../routes/WeeklyPage'); });

const OLDER = 'f5000000-0000-4000-8000-000000000002';
const PERSONAL_RUN = 'f5000000-0000-4000-8000-000000000003';
const NEW_RUN = 'f5000000-0000-4000-8000-000000000004';
const newest = report();
const older: WeeklyPlanFactReportRunDto = { ...report(), id: OLDER, createdAt: '2026-10-18T09:00:00.000Z' };
// The newest run overall is personal; the fallback must still choose the project baseline's newest run.
const personal: WeeklyPlanFactReportRunDto = { ...report(), id: PERSONAL_RUN, baselineId: PERSONAL_BASELINE_ID, createdAt: '2026-10-20T09:00:00.000Z' };

function reportRoutes(runs: WeeklyPlanFactReportRunDto[] = [older, newest, personal]) {
  const table = { ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}`]: () => ok({ ...period(), projectBaselineId: BASELINE_ID }), [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline(true), baseline()]), [`GET ${rootPath}/report-runs`]: () => ok(runs) } as ReturnType<typeof routes>;
  for (const run of [older, newest, personal]) {
    table[`GET ${rootPath}/report-runs/${run.id}`] = () => ok(run);
    table[`GET ${rootPath}/report-runs/${run.id}/rows`] = () => ok([]);
  }
  return table;
}
const runReads = (calls: { method: string; path: string }[], id: string) => calls.filter(call => call.method === 'GET' && call.path === `${rootPath}/report-runs/${id}`).length;
const writes = <T extends { method: string }>(calls: T[]) => calls.filter(call => call.method !== 'GET');
// Picker labels name the period zone and the saved people count (both fixtures save one person); the scope, known-only and total segments are unchanged.
const runText = (run: WeeklyPlanFactReportRunDto) => `${formatPeriodCutoff(run.createdAt, period().timezone)} ${period().timezone} · 1 person in saved report · Project plan · all selected people`;
const typeText = (run: WorkTypeReportRunDto) => `${formatPeriodCutoff(run.createdAt, period().timezone)} ${period().timezone} · 1 person in saved report · 2h`;
const reportPicker = () => screen.getByRole('combobox', { name: /^Saved report$/ });
/** The latest/selected explanation lives in the saved result's About disclosure; open it and require it visible. */
async function expectAbout(user: UserEvent, region: string, text: string) {
  const saved = await screen.findByRole('region', { name: region });
  const summary = await within(saved).findByText('About this saved report', { selector: 'summary' });
  if (!summary.parentElement?.hasAttribute('open')) await user.click(summary);
  expect(await within(saved).findByText(text)).toBeVisible();
}

describe('latest saved weekly report', () => {
  it('shows the newest project-baseline report without a URL run, setup collapsed and no write', async () => {
    const { calls } = installFakeApi(reportRoutes());
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report`);
    const saved = await screen.findByRole('region', { name: 'Saved report' });
    expect(within(saved).getByText('Latest project report')).toBeVisible();
    expect(within(saved).getByText(/^As of /)).toBeVisible();
    expect(within(saved).getByText('Project plan')).toBeVisible();
    expect(within(saved).getByText('About this saved report', { selector: 'summary' }).parentElement).not.toHaveAttribute('open');
    await expectAbout(user, 'Saved report', 'Showing the newest saved report for the project baseline. Choose a saved report to pin a different one.');
    expect(reportPicker()).toHaveTextContent('Latest project report');
    expect(screen.getByRole('button', { name: 'Set up new report' })).toHaveAttribute('aria-expanded', 'false');
    expect(runReads(calls, RUN_ID)).toBe(1);
    expect(runReads(calls, OLDER) + runReads(calls, PERSONAL_RUN)).toBe(0);
    expect(writes(calls)).toHaveLength(0);
  });

  it('always shows an explicitly selected run, and returns to the newest only by an explicit choice', async () => {
    const { calls } = installFakeApi(reportRoutes());
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${OLDER}`);
    const saved = await screen.findByRole('region', { name: 'Saved report' });
    await expectAbout(user, 'Saved report', 'Showing the selected saved report.');
    expect(within(saved).queryByText('Latest project report')).not.toBeInTheDocument();
    expect(reportPicker()).toHaveTextContent(runText(older));
    expect(runReads(calls, OLDER)).toBe(1);
    expect(runReads(calls, RUN_ID)).toBe(0);
    await choosePicker(user, /^Saved report$/, 'Latest project report');
    await within(await screen.findByRole('region', { name: 'Saved report' })).findByText('Latest project report');
    expect(runReads(calls, RUN_ID)).toBe(1);
    expect(writes(calls)).toHaveLength(0);
  });

  it('reads the latest report only after the report view is opened', async () => {
    const { calls } = installFakeApi(reportRoutes());
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    await screen.findByRole('button', { name: 'Add to plan' });
    await waitFor(() => expect(calls.some(call => call.path === `${rootPath}/report-runs`)).toBe(true));
    expect(calls.some(call => call.path.startsWith(`${rootPath}/report-runs/`))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Report' }));
    await within(await screen.findByRole('region', { name: 'Saved report' })).findByText('Latest project report');
    expect(runReads(calls, RUN_ID)).toBe(1);
    expect(writes(calls)).toHaveLength(0);
  });

  it('offers no latest fallback or one-click report without a project baseline', async () => {
    const { calls } = installFakeApi({ ...reportRoutes([personal]), [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline(true)]), [`GET ${rootPath}/periods/${PERIOD_A}`]: () => ok(period()) });
    renderApp(`${weekPath}?period=${PERIOD_A}&view=report`);
    await screen.findByRole('region', { name: 'New report settings' });
    expect(screen.queryByRole('region', { name: 'Saved report' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Calculate current report' })).not.toBeInTheDocument();
    expect(reportPicker()).toHaveTextContent('Choose a report');
    expect(calls.some(call => call.path.startsWith(`${rootPath}/report-runs/`))).toBe(false);
    expect(writes(calls)).toHaveLength(0);
  });

  it('calculates the current report in one click with the project baseline and everyone', async () => {
    const fresh = { ...report(), id: NEW_RUN, createdAt: '2026-10-21T09:00:00.000Z' };
    const runs: WeeklyPlanFactReportRunDto[] = [];
    const { calls } = installFakeApi({ ...reportRoutes(runs), [`POST ${rootPath}/report-runs`]: () => { runs.push(fresh); return created(fresh); }, [`GET ${rootPath}/report-runs/${NEW_RUN}`]: () => ok(fresh), [`GET ${rootPath}/report-runs/${NEW_RUN}/rows`]: () => ok([]) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report`);
    await user.click(await screen.findByRole('button', { name: 'Calculate current report' }));
    // The confirmed result is pinned in the URL by the existing completion guard, not left as a fallback.
    await waitFor(() => expect(reportPicker()).toHaveTextContent(runText(fresh)));
    await expectAbout(user, 'Saved report', 'Showing the selected saved report.');
    const sent = calls.filter(call => call.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`${rootPath}/report-runs`);
    expect(sent[0]?.body).toEqual({ baselineId: BASELINE_ID, knownEstimatesOnly: false, membershipIds: [] });
    expect(sent[0]?.headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('keeps an explicitly chosen run when the one-click calculation confirms later', async () => {
    const gate = deferred<Response>();
    const { calls } = installFakeApi({ ...reportRoutes(), [`POST ${rootPath}/report-runs`]: () => gate.promise });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report`);
    await within(await screen.findByRole('region', { name: 'Saved report' })).findByText('Latest project report');
    await user.click(screen.getByRole('button', { name: 'Calculate current report' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Calculate current report' })).toBeDisabled();
    await choosePicker(user, /^Saved report$/, runText(older));
    await act(async () => gate.resolve(created({ ...report(), id: NEW_RUN })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Calculate current report' })).toBeEnabled());
    expect(reportPicker()).toHaveTextContent(runText(older));
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('hides the latest fallback for an unknown result, resumes without a run and retries the exact request', async () => {
    const gate = lostResponse(); let attempts = 0;
    const fresh = { ...report(), id: NEW_RUN, createdAt: '2026-10-22T09:00:00.000Z' };
    const runs = [older, newest, personal];
    const { calls } = installFakeApi({ ...reportRoutes(runs), [`POST ${rootPath}/report-runs`]: () => { if (++attempts === 1) return gate.promise; runs.push(fresh); return created(fresh); }, [`GET ${rootPath}/report-runs/${NEW_RUN}`]: () => ok(fresh), [`GET ${rootPath}/report-runs/${NEW_RUN}/rows`]: () => ok([]) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report`);
    await within(await screen.findByRole('region', { name: 'Saved report' })).findByText('Latest project report');
    await user.click(screen.getByRole('button', { name: 'Calculate current report' }));
    await waitFor(() => expect(attempts).toBe(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Saved report' })).not.toBeInTheDocument());
    await choosePeriod(user, PERIOD_B);
    await act(async () => gate.lose());
    await user.click(await screen.findByRole('button', { name: 'Open original save' }));
    const setup = await screen.findByRole('region', { name: 'New report settings' });
    expect(periodPicker()).toHaveTextContent(periodLabel(PERIOD_A));
    expect(within(setup).getByRole('combobox', { name: 'Saved baseline' })).toHaveTextContent(/^Project plan/);
    expect(screen.queryByRole('region', { name: 'Saved report' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calculate current report' })).toBeDisabled();
    await user.click(within(setup).getByRole('button', { name: 'Retry original save' }));
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(reportPicker()).toHaveTextContent(runText(fresh)));
    await expectAbout(user, 'Saved report', 'Showing the selected saved report.');
    const sent = calls.filter(call => call.method === 'POST');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[0]?.body).toEqual({ baselineId: BASELINE_ID, knownEstimatesOnly: false, membershipIds: [] });
    expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  });
});

describe('latest saved work-type breakdown', () => {
  const OLDER_TYPE = 'fb000000-0000-4000-8000-000000000002';
  const NEW_TYPE = 'fb000000-0000-4000-8000-000000000003';
  const olderType = { ...categoryReport(), id: OLDER_TYPE, createdAt: '2026-09-30T09:00:00.000Z' };
  const otherWeek = { ...categoryReport(), id: 'fb000000-0000-4000-8000-000000000004', periodId: PERIOD_B, createdAt: '2027-01-01T09:00:00.000Z' };
  function typeRoutes(runs: WorkTypeReportRunDto[]) {
    const table = { ...routes(), [`GET ${rootPath}/work-type-report-runs`]: () => ok(runs) } as ReturnType<typeof routes>;
    for (const run of [categoryReport(), olderType, otherWeek, { ...categoryReport(), id: NEW_TYPE }]) {
      table[`GET ${rootPath}/work-type-report-runs/${run.id}`] = () => ok(run);
      table[`GET ${rootPath}/work-type-report-runs/${run.id}/rows`] = () => ok([]);
    }
    return table;
  }

  it('shows the newest breakdown of this week, lets an explicit run win and calculates for everyone in one click', async () => {
    const runs = [olderType, categoryReport(), otherWeek];
    const fresh = { ...categoryReport(), id: NEW_TYPE, createdAt: '2026-10-02T09:00:00.000Z' };
    const { calls } = installFakeApi({ ...typeRoutes(runs), [`GET ${rootPath}/work-type-report-runs/${NEW_TYPE}`]: () => ok(fresh), [`POST ${rootPath}/work-type-report-runs`]: () => { runs.push(fresh); return created(fresh); } });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=work-types`);
    const saved = await screen.findByRole('region', { name: 'Saved breakdown' });
    expect(within(saved).getByText('Latest saved breakdown')).toBeVisible();
    expect(within(saved).getByText('1 person')).toBeVisible();
    await expectAbout(user, 'Saved breakdown', 'Showing the newest saved breakdown. Choose a saved breakdown to pin a different one.');
    expect(calls.filter(call => call.path === `${rootPath}/work-type-report-runs/${TYPE_RUN}`)).toHaveLength(1);
    expect(calls.some(call => call.path.endsWith(otherWeek.id) || call.path.endsWith(OLDER_TYPE))).toBe(false);
    await choosePicker(user, /^Saved breakdown$/, typeText(olderType));
    await expectAbout(user, 'Saved breakdown', 'Showing the selected saved breakdown.');
    expect(writes(calls)).toHaveLength(0);
    const listReads = () => calls.filter(call => call.path === `${rootPath}/work-type-report-runs`).length;
    const before = listReads();
    await user.click(screen.getByRole('button', { name: 'Calculate current breakdown' }));
    // The URL still shows the run selected at submission, so the existing guard pins the confirmed result.
    await waitFor(() => expect(listReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole('combobox', { name: /^Saved breakdown$/ })).toHaveTextContent(typeText(fresh)));
    await expectAbout(user, 'Saved breakdown', 'Showing the selected saved breakdown.');
    const sent = writes(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ periodId: PERIOD_A, membershipIds: [] });
    expect(sent[0]?.headers.get('Idempotency-Key')).toBeTruthy();
  });
});

function row(id: string, overrides: Partial<WeeklyPlanFactRowDto>): WeeklyPlanFactRowDto {
  return { id, scope: 'original', commitmentId: null, workPackageId: PACKAGE_ID, membershipId: MEMBER_ID, title: `Строка ${id.slice(-1)}`, memberName: anna.displayName, plannedMinutes: 360, actualMinutes: 300, factRecorded: true, varianceMinutes: -60, packageEstimateMinutes: 1200, packageBaselineId: null, taskIds: [], workLogs: [], ...overrides };
}

describe('missing actual hours lens', () => {
  const coverage = { ...summary(), actualMinutes: 300, factCoverage: { recordedItemCount: 1, totalItemCount: 3, ratio: 1 / 3, complete: false }, totalVarianceMinutes: null, totalVariancePercent: null };
  const pinned: WeeklyPlanFactReportRunDto = { ...report(), summary: coverage, byPerson: [{ membershipId: MEMBER_ID, memberName: anna.displayName, summary: coverage }], rowCount: 3 };
  const rows = [row('f9000000-0000-4000-8000-000000000001', {}), row('f9000000-0000-4000-8000-000000000002', { plannedMinutes: 0, actualMinutes: 0, factRecorded: false, varianceMinutes: null }), row('f9000000-0000-4000-8000-000000000003', { plannedMinutes: null, actualMinutes: 0, factRecorded: false, varianceMinutes: null })];

  it.each([false, true])('filters loaded rows by missing actuals without changing server totals (more pages: %s)', async morePages => {
    const { calls } = installFakeApi({ ...reportRoutes(), [`GET ${rootPath}/report-runs/${RUN_ID}`]: () => ok(pinned), [`GET ${rootPath}/report-runs/${RUN_ID}/rows`]: () => json(200, { data: rows, meta: { requestId: 'req_rows', nextCursor: morePages ? 'next' : null } }) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${RUN_ID}`);
    const lens = await screen.findByRole('region', { name: 'Baseline work without actual hours' });
    expect(within(lens).getByText(/^As of .*, 2 of 3 baseline items had no actual-hours entry\. Missing is not zero\.$/)).toBeVisible();
    expect(within(within(lens).getByRole('list', { name: 'Missing actual hours by person' })).getByText(`${anna.displayName}: 2`)).toBeVisible();
    const table = await screen.findByRole('table', { name: 'Saved planned and actual hours' });
    await within(table).findByText('Строка 1');
    const metrics = screen.getByRole('region', { name: 'Saved report' }).textContent;
    expect(metrics).toContain('Insufficient data');
    await user.click(within(lens).getByRole('checkbox', { name: 'Show only rows without actual hours' }));
    expect(within(table).queryByText('Строка 1')).not.toBeInTheDocument();
    const cells = (name: string) => [...(within(table).getByText(name).closest('tr')?.querySelectorAll('td') ?? [])].map(cell => cell.textContent);
    // Planned zero and unknown stay distinct; the missing actual is never displayed as 0m.
    expect(cells('Строка 2').slice(1, 4)).toEqual(['0m', 'Not recorded', 'Difference unavailable: actual hours not recorded']);
    expect(cells('Строка 3').slice(1, 4)).toEqual(['Not set', 'Not recorded', 'Difference unavailable: plan not set']);
    expect(within(lens).getByText(morePages ? 'Filters the loaded rows of this saved report. Load more rows to check the rest. Totals above are unchanged.' : 'Filters the rows of this saved report. Totals above are unchanged.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Saved report' }).textContent).toBe(metrics);
    expect(screen.queryByRole('button', { name: 'Load more report rows' }) !== null).toBe(morePages);
    expect(writes(calls)).toHaveLength(0);
  });

  it('states complete coverage without offering a filter', async () => {
    installFakeApi({ ...reportRoutes(), [`GET ${rootPath}/report-runs/${RUN_ID}/rows`]: () => ok([row('f9000000-0000-4000-8000-000000000001', {})]) });
    renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${RUN_ID}`);
    const lens = await screen.findByRole('region', { name: 'Baseline work without actual hours' });
    expect(within(lens).getByText(/^Every baseline item had actual hours as of /)).toBeVisible();
    expect(within(lens).queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('my baseline and compact weekly hours', () => {
  it('offers Save my baseline outside the help disclosure and only previews before confirmation', async () => {
    const { calls } = installFakeApi({ ...routes(), [`POST ${rootPath}/periods/${PERIOD_A}/freeze-preview`]: () => ok({ periodId: PERIOD_A, scope: 'self', membershipId: MEMBER_ID, previewHash: 'c'.repeat(64), snapshot: baseline(true).snapshot, existingBaselineId: null }) });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    const mine = await screen.findByRole('region', { name: 'My baseline' });
    expect(within(mine).getByText('Not saved yet')).toBeVisible();
    await user.click(within(mine).getByRole('button', { name: 'Save my baseline' }));
    await within(await screen.findByRole('dialog', { name: 'Save my baseline' })).findByRole('button', { name: 'Confirm baseline' });
    const sent = calls.filter(call => call.method !== 'GET');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`${rootPath}/periods/${PERIOD_A}/freeze-preview`);
    expect(sent[0]?.body).toEqual({ scope: 'self' });
    expect(sent[0]?.headers.has('Idempotency-Key')).toBe(false);
  });

  it('shows my saved baseline instead of the action and ignores a colleague baseline', async () => {
    const colleague = alphaMembers[1]; if (!colleague) throw new Error('Missing colleague');
    const theirs = { ...baseline(true), id: 'f4000000-0000-4000-8000-000000000003', membershipId: colleague.id };
    installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([theirs]) });
    const first = renderApp(`${weekPath}?period=${PERIOD_A}`);
    expect(within(await screen.findByRole('region', { name: 'My baseline' })).getByRole('button', { name: 'Save my baseline' })).toBeVisible();
    first.unmount();
    installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([theirs, baseline(true)]) });
    renderApp(`${weekPath}?period=${PERIOD_A}`);
    const mine = await screen.findByRole('region', { name: 'My baseline' });
    expect(within(mine).getByText(/^Saved /)).toBeVisible();
    expect(within(mine).queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([
    { name: 'viewer', extra: singleActorRoutes(anna, [{ ...alpha, role: 'viewer' }], { [alpha.id]: alphaMembers }) },
    { name: 'archived project', extra: { [`GET ${rootPath}/projects/${PROJECT_ID}`]: () => ok({ ...project(alpha.id, PROJECT_ID, 'Недельный пилот'), archivedAt: '2026-10-19T09:00:00.000Z' }) } },
  ])('shows my baseline state without an action for a $name', async ({ extra }) => {
    const { calls } = installFakeApi({ ...routes(), ...extra });
    renderApp(`${weekPath}?period=${PERIOD_A}`);
    const mine = await screen.findByRole('region', { name: 'My baseline' });
    expect(within(mine).getByText('Not saved yet')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save my baseline' })).not.toBeInTheDocument();
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('marks only corrected actual-hour entries and omits first-entry revision noise', async () => {
    const second = { ...log(60, 2), id: 'f7000000-0000-4000-8000-000000000002', taskId: 'f2000000-0000-4000-8000-000000000002' };
    installFakeApi({ ...routes(), [`GET ${rootPath}/recorded-work`]: () => ok([log(0, 1), second]) });
    renderApp(`${weekPath}?period=${PERIOD_A}`);
    const section = await screen.findByRole('region', { name: 'Weekly actual hours' });
    await within(section).findAllByRole('button', { name: 'Edit actual hours' });
    expect(within(section).getAllByText(/^Corrected · revision /)).toHaveLength(1);
    expect(within(section).getByText('Corrected · revision 2')).toBeVisible();
    expect(section).not.toHaveTextContent('revision 1');
    expect(section).toHaveTextContent('0m');
  });
});
