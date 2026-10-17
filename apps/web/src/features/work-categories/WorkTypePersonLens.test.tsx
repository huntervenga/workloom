import type { WorkTypeReportRunDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localization } from '../../i18n';
import type * as LocalizationExports from '../../i18n';
import { alpha, alphaMembers, anna, failure, installFakeApi, json, ok, type RouteTable } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PERIOD_B, period } from '../planning/test/fixtures';
import { choosePicker } from '../planning/test/pickers';
import { WorkTypeReport } from './WorkTypeReport';
import { categoryKeys, useWorkCategoryCommands } from './queries';
import { categoryReport, categorized, MEMBER_ID, PROJECT_ID, rootPath, TYPE_RUN } from './test/fixtures';

vi.mock('../../i18n', async importOriginal => {
  const actual = await importOriginal<typeof LocalizationExports>();
  const { catalogsFromModules } = await import('../../i18n/LocalizationManager');
  const english = import.meta.glob('../../i18n/locales/en/*.json', { eager: true, import: 'default' });
  const manager = new actual.LocalizationManager(catalogsFromModules({
    ...english,
    '../../i18n/locales/fr/work-categories.json': {
      distributionFor: 'Afficher la répartition pour',
      allSelectedPeople: 'Toutes les personnes sélectionnées',
    },
  }));
  return { ...actual, localization: manager, t: manager.t, formatNumber: manager.formatNumber, useTranslation: () => actual.useTranslation(manager) };
});
afterEach(() => { act(() => localization.setLocale('en')); });

const OTHER = 'c0000000-0000-4000-8000-000000000002';
const ZERO = 'c0000000-0000-4000-8000-000000000009';
const EMPTY = 'c0000000-0000-4000-8000-000000000010';
const NEXT_RUN = 'fb000000-0000-4000-8000-000000000002';
const runPath = `${rootPath}/work-type-report-runs/${TYPE_RUN}`;
function savedReport(): WorkTypeReportRunDto {
  const base = categoryReport();
  const [first, second, uncategorized] = base.byCategory;
  if (!first || !second || !uncategorized) throw new Error('Missing category fixture');
  const analysis = { ...first, label: 'Snapshot analysis', color: '#3399aa', minutes: 120, sharePercent: 50 };
  const support = { ...second, label: 'Snapshot support', color: '#cc1100', minutes: 60, sharePercent: 25 };
  const untyped = { ...uncategorized, minutes: 60, sharePercent: 25 };
  return {
    ...base, membershipIds: [MEMBER_ID, OTHER, ZERO, EMPTY],
    totalActualMinutes: 240, categorizedMinutes: 180, uncategorizedMinutes: 60, activeSourceCount: 6,
    byCategory: [analysis, support, untyped],
    byPerson: [
      { membershipId: MEMBER_ID, memberName: 'Snapshot Anna', totalActualMinutes: 60, activeSourceCount: 2, byCategory: [{ ...analysis, minutes: 15, sharePercent: 25 }, { ...untyped, minutes: 45, sharePercent: 75 }] },
      { membershipId: OTHER, memberName: 'Snapshot Boris', totalActualMinutes: 180, activeSourceCount: 3, byCategory: [{ ...analysis, minutes: 105, sharePercent: 100 * 105 / 180 }, { ...support, sharePercent: 100 * 60 / 180 }, { ...untyped, minutes: 15, sharePercent: 100 * 15 / 180 }] },
      { membershipId: ZERO, memberName: 'Snapshot Zero', totalActualMinutes: 0, activeSourceCount: 1, byCategory: [{ ...analysis, minutes: 0, sharePercent: null }] },
      { membershipId: EMPTY, memberName: 'Snapshot Empty', totalActualMinutes: 0, activeSourceCount: 0, byCategory: [] },
    ],
  };
}
function routes(reports: WorkTypeReportRunDto[] = [savedReport()], extra: RouteTable = {}): RouteTable {
  const result: RouteTable = { [`GET ${rootPath}/work-type-report-runs`]: () => ok(reports) };
  for (const report of reports) {
    result[`GET ${rootPath}/work-type-report-runs/${report.id}`] = () => ok(report);
    result[`GET ${rootPath}/work-type-report-runs/${report.id}/rows`] = () => json(200, { data: [], meta: { requestId: 'lens-rows', nextCursor: null } });
  }
  return { ...result, ...extra };
}
function example() {
  const onDraftAction = vi.fn();
  function Example() {
    const commands = useWorkCategoryCommands(anna.id, alpha.id, PROJECT_ID);
    const [runId, setRunId] = useState(TYPE_RUN);
    return <WorkTypeReport actorId={anna.id} workspaceId={alpha.id} period={period()} members={alphaMembers.map(member => ({ ...member, displayName: 'Current renamed person' }))} runId={runId} draft={undefined} onDraftAction={onDraftAction} mutation={commands.createReport} onSelectRun={setRunId} onCalculated={vi.fn()} />;
  }
  return { ...renderFieldUi(<Example />), onDraftAction };
}
const lens = () => within(screen.getByRole('region', { name: 'Work-type distribution' }));
async function ready() { return screen.findByRole('combobox', { name: 'Show distribution for' }); }

// Assertions scope to the lens; the saved report totals and source rows deliberately remain report-wide.
describe('saved work-type team/person distribution lens', () => {
  it('switches chart, table, denominator and count together using pinned data without new requests or report edits', async () => {
    const { calls } = installFakeApi(routes());
    const ui = example();
    const selector = await ready();
    const cached = ui.client.getQueryData<WorkTypeReportRunDto>(categoryKeys.run(anna.id, alpha.id, TYPE_RUN));
    const original = structuredClone(cached);
    expect(selector).toHaveTextContent('All selected people');
    expect(lens().getByText(/Share denominator: 4h recorded · 6 active entries/)).toBeVisible();
    expect(lens().getByRole('img', { name: 'Snapshot analysis: 2h, 50%' })).toBeVisible();
    const readCount = calls.length;

    await choosePicker(ui.user, 'Show distribution for', 'Snapshot Anna');

    expect(lens().getByText('Recorded hours · Snapshot Anna')).toBeVisible();
    expect(lens().getByText(/Share denominator: 1h recorded · 2 active entries/)).toBeVisible();
    expect(lens().getByRole('img', { name: 'Snapshot analysis: 15m, 25%' })).toBeVisible();
    expect(lens().getByRole('img', { name: 'Uncategorized: 45m, 75%' })).toBeVisible();
    expect(lens().queryByText('Snapshot support')).not.toBeInTheDocument();
    const table = within(lens().getByRole('table', { name: 'Share of recorded hours' }));
    expect(table.getByRole('row', { name: 'Snapshot analysis 15m 25%' })).toBeVisible();
    expect(table.getByRole('row', { name: 'Uncategorized 45m 75%' })).toBeVisible();
    expect(screen.getByText('Saved report totals · all selected people')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Saved breakdown' })).toHaveTextContent('4h');
    expect(calls).toHaveLength(readCount);
    expect(ui.onDraftAction).not.toHaveBeenCalled();
    expect(ui.client.getQueryData(categoryKeys.run(anna.id, alpha.id, TYPE_RUN))).toEqual(original);

    await choosePicker(ui.user, 'Show distribution for', 'All selected people');
    expect(lens().getByRole('img', { name: 'Snapshot support: 1h, 25%' })).toBeVisible();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('keeps active zero-hour entries, undefined shares and absent active entries distinct', async () => {
    installFakeApi(routes());
    const ui = example();
    await ready();
    await choosePicker(ui.user, 'Show distribution for', 'Snapshot Zero');
    expect(lens().getByText(/0m recorded · 1 active entry\./)).toBeVisible();
    expect(lens().getByText('The total is 0. Percentages are undefined, even when zero-hour entries exist.')).toBeVisible();
    expect(lens().queryByText('This selection has no active entries.')).not.toBeInTheDocument();
    const zeroBar = lens().getByRole('img', { name: 'Snapshot analysis: 0m, Share undefined' });
    expect(zeroBar.querySelectorAll('rect')).toHaveLength(1);
    expect(lens().getByRole('row', { name: 'Snapshot analysis 0m Share undefined' })).toBeVisible();

    await choosePicker(ui.user, 'Show distribution for', 'Snapshot Empty');
    expect(lens().getByText(/0m recorded · 0 active entries/)).toBeVisible();
    expect(lens().getByText('This selection has no active entries.')).toBeVisible();
    expect(lens().getByText('No category totals are recorded for this selection.')).toBeVisible();
    expect(lens().queryByText('The total is 0. Percentages are undefined, even when zero-hour entries exist.')).not.toBeInTheDocument();
    expect(lens().queryAllByRole('img')).toHaveLength(0);
  });

  it('does not invent a percentage for a positive-minute bucket with a saved null share', async () => {
    const report = savedReport();
    const person = report.byPerson[0];
    if (!person?.byCategory[0]) throw new Error('Missing person bucket');
    person.byCategory[0].sharePercent = null;
    installFakeApi(routes([report]));
    const ui = example();
    await ready(); await choosePicker(ui.user, 'Show distribution for', 'Snapshot Anna');
    const bar = lens().getByRole('img', { name: 'Snapshot analysis: 15m, Share undefined' });
    expect(bar.querySelectorAll('rect')).toHaveLength(1);
    expect(lens().getByRole('row', { name: 'Snapshot analysis 15m Share undefined' })).toBeVisible();
    expect(lens().getByRole('img', { name: 'Uncategorized: 45m, 75%' })).toBeVisible();
  });

  it('preserves snapshot names, colors and distinct stable buckets even when labels match', async () => {
    const report = savedReport();
    report.byCategory = report.byCategory.map((bucket, index) => index < 2 ? { ...bucket, label: 'Same saved label' } : bucket);
    installFakeApi(routes([report]));
    const ui = example();
    await ui.user.click(await ready());
    const choices = within(screen.getByRole('listbox', { name: 'Show distribution for' }));
    expect(choices.getByRole('option', { name: 'Snapshot Anna' })).toBeInTheDocument();
    expect(choices.queryByRole('option', { name: 'Current renamed person' })).not.toBeInTheDocument();
    await ui.user.keyboard('{Escape}');
    const first = lens().getByRole('img', { name: 'Same saved label: 2h, 50%' });
    const second = lens().getByRole('img', { name: 'Same saved label: 1h, 25%' });
    expect(first.querySelector('rect:last-of-type')).toHaveAttribute('fill', '#3399aa');
    expect(second.querySelector('rect:last-of-type')).toHaveAttribute('fill', '#cc1100');
    expect(lens().getAllByRole('row', { name: /Same saved label/ })).toHaveLength(2);
    expect(document.body.textContent).not.toContain(report.byCategory[0]?.key);
  });

  it('resets to all selected people on a saved-run change even when the same person exists in both runs', async () => {
    const original = savedReport();
    const doubleMinutes = (bucket: WorkTypeReportRunDto['byCategory'][number]) => ({ ...bucket, minutes: bucket.minutes * 2 });
    const second = {
      ...original, id: NEXT_RUN, totalActualMinutes: 480, categorizedMinutes: 360, uncategorizedMinutes: 120,
      byCategory: original.byCategory.map(doubleMinutes),
      byPerson: original.byPerson.map(person => ({ ...person, totalActualMinutes: person.totalActualMinutes * 2, byCategory: person.byCategory.map(doubleMinutes) })),
    };
    installFakeApi(routes([savedReport(), second]));
    const ui = example();
    await ready(); await choosePicker(ui.user, 'Show distribution for', 'Snapshot Anna');
    await choosePicker(ui.user, 'Saved breakdown', /· 8h$/);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Show distribution for' })).toHaveTextContent('All selected people'));
    expect(lens().getByText(/Share denominator: 8h recorded · 6 active entries/)).toBeVisible();
    expect(ui.onDraftAction).not.toHaveBeenCalled();
  });

  it('falls back safely when the selected saved person is unavailable and does not resurrect it on later data', async () => {
    installFakeApi(routes());
    const ui = example();
    await ready(); await choosePicker(ui.user, 'Show distribution for', 'Snapshot Anna');
    const key = categoryKeys.run(anna.id, alpha.id, TYPE_RUN);
    act(() => { ui.client.setQueryData(key, { ...savedReport(), byPerson: savedReport().byPerson.filter(person => person.membershipId !== MEMBER_ID) }); });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Show distribution for' })).toHaveTextContent('All selected people'));
    expect(lens().getByRole('status')).toHaveTextContent('The selected person is not in this saved report. Showing all selected people.');
    act(() => { ui.client.setQueryData(key, savedReport()); });
    await ui.user.click(screen.getByRole('combobox', { name: 'Show distribution for' }));
    expect(within(await screen.findByRole('listbox', { name: 'Show distribution for' })).getByRole('option', { name: 'Snapshot Anna' })).toBeInTheDocument();
    await ui.user.keyboard('{Escape}');
    expect(screen.getByRole('combobox', { name: 'Show distribution for' })).toHaveTextContent('All selected people');
    expect(lens().getByText(/4h recorded · 6 active entries/)).toBeVisible();
  });

  it('retains the selected saved identity through locale changes', async () => {
    const { calls } = installFakeApi(routes());
    const ui = example();
    await ready(); await choosePicker(ui.user, 'Show distribution for', 'Snapshot Anna');
    const count = calls.length;
    act(() => localization.setLocale('fr'));
    expect(screen.getByRole('combobox', { name: 'Afficher la répartition pour' })).toHaveTextContent('Snapshot Anna');
    expect(lens().getByText('Recorded hours · Snapshot Anna')).toBeVisible();
    expect(calls).toHaveLength(count);
  });

  it('keeps source details report-wide and pagination explicit while showing one person', async () => {
    const first = { id: 'fd000000-0000-4000-8000-000000000001', workLog: { ...categorized(), membershipId: OTHER }, taskTitle: 'Source for another saved person', memberName: 'Snapshot Boris', excluded: false };
    const second = { ...first, id: 'fd000000-0000-4000-8000-000000000002', taskTitle: 'Second report-wide source' };
    const report = { ...savedReport(), rowCount: 2 };
    const { calls } = installFakeApi(routes([report], {
      [`GET ${runPath}/rows`]: request => json(200, { data: request.searchParams.has('cursor') ? [second] : [first], meta: { requestId: 'lens-sources', nextCursor: request.searchParams.has('cursor') ? null : 'next-page' } }),
    }));
    const ui = example();
    await ready(); await choosePicker(ui.user, 'Show distribution for', 'Snapshot Anna');
    const sources = within(screen.getByRole('region', { name: 'Breakdown sources' }));
    expect(sources.getByText('These source details cover all selected people in this saved report. The chart selection does not filter them.')).toBeVisible();
    expect(sources.getByText('Source for another saved person')).toBeVisible();
    const reads = calls.filter(call => call.path === `${runPath}/rows`).length;
    expect(reads).toBe(1);
    await ui.user.click(sources.getByRole('button', { name: 'Load more source entries' }));
    await sources.findByText('Second report-wide source');
    expect(calls.filter(call => call.path === `${runPath}/rows`)).toHaveLength(2);
    expect(lens().getByRole('img', { name: 'Uncategorized: 45m, 75%' })).toBeVisible();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it.each(['run', 'rows'] as const)('preserves the current %s access-denial gate before the lens', async target => {
    let denied = false;
    installFakeApi(routes(undefined, {
      [`GET ${target === 'run' ? runPath : `${runPath}/rows`}`]: () => denied ? failure(403, 'FORBIDDEN', 'private source body') : target === 'run' ? ok(savedReport()) : json(200, { data: [], meta: { requestId: 'lens-empty', nextCursor: null } }),
    }));
    const ui = example();
    await ready(); await choosePicker(ui.user, 'Show distribution for', 'Snapshot Anna');
    denied = true;
    await act(async () => { await ui.client.invalidateQueries({ queryKey: target === 'run' ? categoryKeys.run(anna.id, alpha.id, TYPE_RUN) : categoryKeys.rows(anna.id, alpha.id, TYPE_RUN), exact: true }); });
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Show distribution for' })).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain('Snapshot Anna');
    expect(document.body.textContent).not.toContain('private source body');
  });

  it('preserves the wrong-period gate and handles an empty saved cohort without a person fallback', async () => {
    const { unmount } = (() => { installFakeApi(routes([{ ...savedReport(), periodId: PERIOD_B }])); return example(); })();
    await screen.findByText('This report belongs to another week');
    expect(screen.queryByRole('combobox', { name: 'Show distribution for' })).not.toBeInTheDocument();
    unmount();
    const empty = { ...categoryReport(), membershipIds: [], byPerson: [], byCategory: [], totalActualMinutes: 0, categorizedMinutes: 0, uncategorizedMinutes: 0, activeSourceCount: 0 };
    const { calls } = installFakeApi(routes([empty]));
    const ui = example();
    expect(await ready()).toHaveTextContent('All selected people');
    await ui.user.click(await ready());
    expect(within(screen.getByRole('listbox', { name: 'Show distribution for' })).getAllByRole('option')).toHaveLength(1);
    await ui.user.keyboard('{Escape}');
    expect(lens().getByText('This selection has no active entries.')).toBeVisible();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });
});
