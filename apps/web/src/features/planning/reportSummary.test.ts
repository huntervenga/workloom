import { describe, expect, it } from 'vitest';
import {
  baselineActualText, coverageText, inclusiveWeekEnd, knownPlanText, peopleScopeLabel, savedPeopleScope, savedTime, shareText,
  variancePercentText, varianceText, weekRangeLabel, weeklyReportBrief, weeklyRunOptionLabel, workTypeBucketLabel, workTypeReportBrief, workTypeRunOptionLabel,
} from './reportSummary';
import { AS_OF, AVERY, CASEY, CREATED_AT, NICOSIA, avery, blair, casey, devon, ellis, fiveReport, nicosiaPeriod, overall, savedSummary, workTypeRun } from './test/reportPeople';

const MISSING_PERSON = 'a7000000-0000-4000-8000-0000000000ff';
/** Expected saved times come from Intl in the period zone, not from the formatter under test. */
const inZone = (timestamp: string, timeZone: string) => new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(new Date(timestamp));
const lines = (text: string) => text.split('\n');

describe('saved weekly values', () => {
  it('keeps plan, actual, difference and coverage distinct for each saved person', () => {
    expect([knownPlanText(avery.summary), baselineActualText(avery.summary), varianceText(avery.summary), variancePercentText(avery.summary)]).toEqual(['2h', '2h 30m', '+30m', '25%']);
    expect(coverageText(avery.summary)).toBe('Plans known 1 of 1 · actuals recorded 1 of 1');

    // A recorded active zero stays 0m with a real difference; it is not "Not recorded".
    expect([knownPlanText(blair.summary), baselineActualText(blair.summary), varianceText(blair.summary), variancePercentText(blair.summary)]).toEqual(['1h', '0m', '−1h', '-100%']);

    // Missing actual hours are never shown as 0m.
    expect([knownPlanText(casey.summary), baselineActualText(casey.summary), varianceText(casey.summary), variancePercentText(casey.summary)]).toEqual(['1h 30m', 'Not recorded', 'Insufficient data', 'Percentage unavailable']);
    expect(coverageText(casey.summary)).toBe('Plans known 1 of 1 · actuals recorded 0 of 1');

    expect([knownPlanText(devon.summary), baselineActualText(devon.summary), varianceText(devon.summary), variancePercentText(devon.summary)]).toEqual(['Not known', '45m', 'Insufficient data', 'Percentage unavailable']);
    expect(coverageText(devon.summary)).toBe('Plans known 0 of 1 · actuals recorded 1 of 1');

    // No original baseline rows: no comparison at all, not a zero or a missing value.
    expect([knownPlanText(ellis.summary), baselineActualText(ellis.summary), varianceText(ellis.summary), coverageText(ellis.summary)]).toEqual(['No baseline work', 'No baseline work', 'Difference unavailable', 'No baseline work']);
    expect(variancePercentText(ellis.summary)).toBe('Percentage unavailable');
  });

  it('shows the server overall aggregate with its own incomplete coverage', () => {
    expect([knownPlanText(overall), baselineActualText(overall), varianceText(overall), variancePercentText(overall)]).toEqual(['4h 30m', '3h 15m', 'Insufficient data', 'Percentage unavailable']);
    expect(coverageText(overall)).toBe('Plans known 3 of 4 · actuals recorded 3 of 4');
  });

  it('separates a known zero plan from an unknown percentage', () => {
    const zeroPlan = savedSummary({ plan: 0, known: 1, plans: 1, actual: 30, recorded: 1, facts: 1, variance: 30, percent: null, added: 0, unplanned: 0, total: 30 });
    expect(varianceText(zeroPlan)).toBe('+30m');
    expect(variancePercentText(zeroPlan)).toBe('Percentage unavailable: the known plan is 0m');
    expect(variancePercentText(casey.summary)).not.toMatch(/0m|0%/);
  });
});

describe('saved report identity', () => {
  it('shows the inclusive last day of the week, never the exclusive end', () => {
    expect(inclusiveWeekEnd('2026-05-10')).toBe('2026-05-09');
    expect(inclusiveWeekEnd('2026-03-01')).toBe('2026-02-28');
    const range = weekRangeLabel(nicosiaPeriod());
    expect(range).toMatch(/May 3/);
    expect(range).toMatch(/May 9/);
    expect(range).not.toMatch(/May 10/);
  });

  it('formats saved times in the period zone regardless of the host zone', () => {
    const period = nicosiaPeriod();
    expect(savedTime(CREATED_AT, period)).toBe(inZone(CREATED_AT, NICOSIA));
    expect(savedTime(AS_OF, period)).toBe(inZone(AS_OF, NICOSIA));
    // 21:30 UTC is already the next calendar day in Nicosia, so a UTC or host rendering would differ.
    expect(savedTime(CREATED_AT, period)).not.toBe(inZone(CREATED_AT, 'UTC'));
  });

  it('counts and names only the saved people, independently of known-only and of everyone else', () => {
    const five = savedPeopleScope(fiveReport());
    expect(five).toEqual({ count: 5, names: ['Avery', 'Blair', 'Casey', 'Devon', 'Ellis'] });
    expect(savedPeopleScope(fiveReport({ knownEstimatesOnly: true }))).toEqual(five);
    expect(peopleScopeLabel(five)).toBe('5 people in saved report');

    const two = savedPeopleScope(fiveReport({ membershipIds: [CASEY, AVERY], byPerson: [casey, avery] }));
    expect(two).toEqual({ count: 2, names: ['Avery', 'Casey'] });
    expect(peopleScopeLabel(two)).toBe('2 people in saved report');
    expect(peopleScopeLabel(two)).not.toMatch(/everyone/i);

    // A saved ID without a result row keeps a neutral label instead of borrowing a current member name.
    const withMissing = savedPeopleScope(fiveReport({ membershipIds: [AVERY, MISSING_PERSON], byPerson: [avery] }));
    expect(withMissing).toEqual({ count: 2, names: ['Avery', 'Saved person without results'] });
  });

  it('labels saved weekly runs with the zone and saved people count, unchanged by known-only', () => {
    const period = nicosiaPeriod();
    const all = weeklyRunOptionLabel(fiveReport(), period, 'Project baseline');
    const knownOnly = weeklyRunOptionLabel(fiveReport({ knownEstimatesOnly: true }), period, 'Project baseline');
    expect(all).toContain(inZone(CREATED_AT, NICOSIA));
    expect(all).toContain(NICOSIA);
    expect(all).toContain('5 people in saved report');
    expect(knownOnly).toContain('5 people in saved report');
    expect(knownOnly).not.toBe(all);
    expect(weeklyRunOptionLabel(fiveReport({ membershipIds: [CASEY, AVERY], byPerson: [casey, avery] }), period, 'Project baseline')).toContain('2 people in saved report');
  });

  it('tells apart work-type runs saved at the same time for different people', () => {
    const period = nicosiaPeriod();
    const two = workTypeRunOptionLabel(workTypeRun(), period);
    const secondPerson = workTypeRun().byPerson[1];
    if (secondPerson === undefined) throw new Error('workTypeRun fixture is missing byPerson[1]');
    const one = workTypeRunOptionLabel(workTypeRun({ membershipIds: [AVERY], byPerson: [secondPerson] }), period);
    expect(two).toContain(inZone(CREATED_AT, NICOSIA));
    expect(two).toContain(NICOSIA);
    expect(two).toContain('3h 20m');
    expect(two).toContain('2 people in saved report');
    expect(one).toContain('1 person in saved report');
    expect(one).not.toBe(two);
  });
});

describe('plain-text briefs', () => {
  const period = nicosiaPeriod();

  it('copies server values, saved names in name order and the missing-is-not-zero disclaimer', () => {
    const brief = weeklyReportBrief({ projectName: 'Pilot', period, report: fiveReport(), scopeLabel: 'Project baseline' });
    const text = lines(brief);
    expect(text).toContain('Project: Pilot');
    expect(text).toContain(`Week: Week 19, ${weekRangeLabel(period)} (Asia/Nicosia)`);
    expect(text).toContain(`Calculated: ${inZone(CREATED_AT, NICOSIA)} · Actual hours included through: ${inZone(AS_OF, NICOSIA)} (Asia/Nicosia)`);
    expect(text).toContain('People: 5 people in saved report — Avery, Blair, Casey, Devon, Ellis');
    expect(text).toContain('Comparison: Known plans only: off');
    expect(text).toContain('Known baseline plan: 4h 30m');
    expect(text).toContain('Actual hours for baseline work: 3h 15m');
    expect(text).toContain('Baseline difference: Insufficient data (Percentage unavailable)');
    expect(text).toContain('Baseline coverage: Plans known 3 of 4 · actuals recorded 3 of 4 (original baseline rows only)');
    expect(text).toContain('Added work: 20m');
    expect(text).toContain('Unplanned work: 10m');
    expect(text).toContain('All recorded hours: 3h 45m');
    expect(text).toContain('- Blair: plan 1h; actual 0m; difference −1h; added 0m; unplanned 0m; all recorded 0m');
    expect(text).toContain('- Casey: plan 1h 30m; actual Not recorded; difference Insufficient data; added 0m; unplanned 0m; all recorded 0m');
    expect(text).toContain('- Devon: plan Not known; actual 45m; difference Insufficient data; added 0m; unplanned 0m; all recorded 45m');
    expect(text).toContain('- Ellis: plan No baseline work; actual No baseline work; difference Difference unavailable; added 20m; unplanned 10m; all recorded 30m');
    const order = ['Avery', 'Blair', 'Casey', 'Devon', 'Ellis'].map((name) => text.findIndex((line) => line.startsWith(`- ${name}:`)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index > 0)).toBe(true);
    expect(text.at(-1)).toBe('A missing plan or missing actual hours is not a confirmed zero. Totals come from the saved server calculation.');
  });

  it('never sums the people rows into the overall totals', () => {
    // The server total stays 3h 45m even when only one person row is present.
    const text = lines(weeklyReportBrief({ period, report: fiveReport({ byPerson: [avery] }), scopeLabel: 'Project baseline' }));
    expect(text).toContain('All recorded hours: 3h 45m');
    expect(text).toContain('Known baseline plan: 4h 30m');
    expect(text).not.toContain('All recorded hours: 2h 30m');
    expect(text.some((line) => line.startsWith('Project:'))).toBe(false);
  });

  it('uses the server share denominator including uncategorized and never invents 0%', () => {
    const run = workTypeRun();
    const uncategorized = run.byCategory[1];
    if (uncategorized === undefined) throw new Error('workTypeRun fixture is missing byCategory[1]');
    expect(workTypeBucketLabel(uncategorized)).toBe('Uncategorized');
    const text = lines(workTypeReportBrief({ projectName: 'Pilot', period, report: run }));
    expect(text).toContain('Recorded: 3h 20m from 4 active entries · categorized 2h 30m · uncategorized 50m');
    expect(text).toContain('- Development: 2h 30m · 75%');
    expect(text).toContain('- Uncategorized: 50m · 25%');
    expect(text.join('\n')).not.toContain('stored label is not shown');
    expect(text).toContain('- Avery: 3h 20m from 4 active entries');
    expect(text).toContain('- Casey: 0m from 0 active entries');
    expect(text.indexOf('- Avery: 3h 20m from 4 active entries')).toBeLessThan(text.indexOf('- Casey: 0m from 0 active entries'));

    expect(shareText(null)).toBe('Share undefined');
    expect(shareText(0)).toBe('0%');
    const development = run.byCategory[0];
    if (development === undefined) throw new Error('workTypeRun fixture is missing byCategory[0]');
    const empty = workTypeRun({ totalActualMinutes: 0, activeSourceCount: 0, categorizedMinutes: 0, uncategorizedMinutes: 0, byCategory: [{ ...development, minutes: 0, sharePercent: null }] });
    const emptyText = lines(workTypeReportBrief({ period, report: empty }));
    expect(emptyText).toContain('- Development: 0m · Share undefined');
    expect(emptyText.join('\n')).not.toContain('0%');
  });
});
