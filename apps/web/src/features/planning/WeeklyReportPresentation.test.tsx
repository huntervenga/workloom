import type { WeeklyPlanFactReportRunDto } from '@workloom/contracts';
import { screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { BASELINE_ID, PERIOD_A, RUN_ID, baseline, period, rootPath, routes, weekPath } from './test/fixtures';
import { blair, ellis, fiveReport } from './test/reportPeople';

beforeAll(async () => { await import('../../routes/WeeklyPage'); });

const CAPTION = 'Bars compare known planned hours with recorded actual hours for original baseline work only. Where data is incomplete, a bar shows only the known or recorded part; the coverage in the table below shows what is missing.';

/** The saved run is served with an empty first rows page: every total must still be the server's. */
function savedRoutes(run: WeeklyPlanFactReportRunDto) {
  return {
    ...routes(),
    [`GET ${rootPath}/periods/${PERIOD_A}`]: () => ok({ ...period(), projectBaselineId: BASELINE_ID }),
    [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]),
    [`GET ${rootPath}/report-runs`]: () => ok([run]),
    [`GET ${rootPath}/report-runs/${RUN_ID}`]: () => ok(run),
    [`GET ${rootPath}/report-runs/${RUN_ID}/rows`]: () => ok([]),
  } as ReturnType<typeof routes>;
}
const metric = (region: HTMLElement, label: string) => within(region).getByText(label, { selector: 'dt' }).nextElementSibling;

describe('saved weekly report presentation', () => {
  it('shows server totals, incomplete-coverage notes and an always-visible chart caption', async () => {
    const { calls } = installFakeApi(savedRoutes(fiveReport()));
    renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${RUN_ID}`);
    const saved = await screen.findByRole('region', { name: 'Saved report' });
    expect(metric(saved, 'All recorded hours')).toHaveTextContent('3h 45m');
    expect(metric(saved, 'Added work')).toHaveTextContent('20m');
    expect(metric(saved, 'Unplanned work')).toHaveTextContent('10m');
    expect(within(saved).getByText('4h 30m')).toBeVisible();
    expect(within(saved).getByText('3h 15m')).toBeVisible();
    expect(within(saved).getByText('Includes known plans only; the plans not known yet are not counted as zero.')).toBeVisible();
    expect(within(saved).getByText('Includes recorded actual hours only; missing entries are not counted as zero.')).toBeVisible();
    const coverage = await screen.findByRole('region', { name: 'Baseline work without actual hours' });
    expect(within(coverage).getByText(/^As of .+, 1 of 4 baseline items had no actual-hours entry\. Missing is not zero\.$/)).toBeVisible();

    expect(screen.getByText(CAPTION)).toBeVisible();

    const people = screen.getByRole('table', { name: /Saved baseline, added and unplanned hours/ });
    expect(within(people).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['Avery', 'Blair', 'Casey', 'Devon', 'Ellis']);
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('says a report without original baseline work has no comparison instead of missing or zero values', async () => {
    installFakeApi(savedRoutes(fiveReport({ membershipIds: [ellis.membershipId], byPerson: [ellis], summary: ellis.summary, cohort: { selectedItemCount: 0, originalItemCount: 0 }, rowCount: 0 })));
    renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${RUN_ID}`);
    const saved = await screen.findByRole('region', { name: 'Saved report' });
    expect(within(saved).getAllByText('No baseline work', { selector: 'dd' })).toHaveLength(2);
    expect(within(saved).getByText('Difference unavailable', { selector: 'dd' })).toBeVisible();
    expect(within(saved).getByText('This report has no original baseline work to compare. Added and unplanned hours are shown below.')).toBeVisible();
    expect(within(saved).queryByText('Not recorded', { selector: 'dd' })).not.toBeInTheDocument();
    expect(within(saved).queryByText('Insufficient data', { selector: 'dd' })).not.toBeInTheDocument();
    expect(metric(saved, 'All recorded hours')).toHaveTextContent('30m');
    expect(screen.queryByText(CAPTION)).not.toBeInTheDocument();
    // An empty baseline has nothing to cover: never claim every baseline item had actual hours.
    const coverage = await screen.findByRole('region', { name: 'Baseline work without actual hours' });
    expect(within(coverage).getByText('No baseline work')).toBeVisible();
    expect(within(coverage).queryByText(/Every baseline item had actual hours/)).not.toBeInTheDocument();
  });

  it('treats an explicitly recorded zero as full actual-hours coverage, not as missing or empty baseline', async () => {
    const { calls } = installFakeApi(savedRoutes(fiveReport({ membershipIds: [blair.membershipId], byPerson: [blair], summary: blair.summary, cohort: { selectedItemCount: 1, originalItemCount: 1 }, rowCount: 1 })));
    renderApp(`${weekPath}?period=${PERIOD_A}&view=report&run=${RUN_ID}`);
    const saved = await screen.findByRole('region', { name: 'Saved report' });
    expect(metric(saved, 'Actual hours for baseline work')).toHaveTextContent('0m');
    const coverage = await screen.findByRole('region', { name: 'Baseline work without actual hours' });
    expect(within(coverage).getByText(/^Every baseline item had actual hours as of .+\.$/)).toBeVisible();
    expect(within(coverage).queryByText('No baseline work')).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });
});
