import { describe, expect, it } from 'vitest';
import type { WorkspaceReportBucketDto } from '@workloom/contracts';
import { accuracyRows, band, trendOf, type AccuracyPoint } from './estimationAccuracy';

const point = (ratio: number | null, paired = 1): AccuracyPoint => ({ start: '2026-01-01', end: '2026-01-07', ratio, paired });
const ratio = (value: number | null) => (value === null ? null : { numerator: String(Math.round(value * 100)), denominator: '100', decimal: String(value) });
const comparison = (value: number | null, paired: number) => ({ eligibleTasks: paired, pairedTasks: paired, plan: null, fact: null, difference: null, ratio: ratio(value), unavailableReason: null, planCoverage: {}, factCoverage: {} });
const bucket = (start: string, team: number | null, people: Record<string, [number | null, number]>) => ({
  startDate: start, endDate: start, comparison: comparison(team, 3),
  people: Object.entries(people).map(([membershipId, [value, paired]]) => ({ membershipId, displayName: membershipId, comparison: comparison(value, paired) })),
}) as unknown as WorkspaceReportBucketDto;

describe('estimation accuracy trend', () => {
  it('bands the distance from a perfect estimate', () => {
    expect(band(1.05)).toBe('good'); expect(band(0.9)).toBe('good'); expect(band(1.2)).toBe('fair'); expect(band(2)).toBe('poor'); expect(band(null)).toBe('none');
  });
  it('calls a shrinking miss improving and a growing one worsening, with enough weeks', () => {
    expect(trendOf([point(1.8), point(1.5), point(1.2), point(1.05)]).trend).toBe('improving');
    expect(trendOf([point(1.05), point(1.1), point(1.5), point(2)]).trend).toBe('worsening');
    expect(trendOf([point(1.1), point(0.9), point(1.1), point(0.9)]).trend).toBe('steady');
  });
  it('under- and over-estimating count the same distance from 100%', () => {
    expect(trendOf([point(0.5), point(0.6), point(0.95), point(1.0)]).trend).toBe('improving');
  });
  it('refuses to guess from fewer than four measured weeks, ignoring weeks without paired tasks', () => {
    expect(trendOf([point(1.8), point(1.0), point(1.0)]).trend).toBe('notEnough');
    expect(trendOf([point(1.8), point(null, 0), point(1.5), point(null, 0), point(1.1)]).trend).toBe('notEnough');
  });
  it('builds a team row and one row per person in calendar order, with empty weeks for absent people', () => {
    const result = {
      summary: {},
      people: [{ membershipId: 'ann', displayName: 'Ann' }, { membershipId: null, displayName: 'x' }],
      buckets: [bucket('2026-01-12', 1.1, { ann: [1.0, 2] }), bucket('2026-01-05', 1.4, { ann: [1.4, 2] })],
    } as unknown as Parameters<typeof accuracyRows>[0];
    const rows = accuracyRows(result, 'Team', 'Unassigned');
    expect(rows.map(row => row.name)).toEqual(['Team', 'Ann', 'Unassigned']);
    expect(rows[0]?.points.map(p => p.start)).toEqual(['2026-01-05', '2026-01-12']);
    expect(rows[1]?.points.map(p => p.ratio)).toEqual([1.4, 1]);
    expect(rows[2]?.points.map(p => p.paired)).toEqual([0, 0]);
  });
});
