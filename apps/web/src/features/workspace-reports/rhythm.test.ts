import type { WorkspaceReportResultDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { loadBand, loadRows, unfinishedWork } from './rhythm';

const num = (value: number) => ({ numerator: String(value), denominator: '1', decimal: String(value) });
const person = (id: string | null, name: string, worked: number | null, capacity: { scheduled: number; away: number; holiday?: number; known?: boolean } | null) => ({
  membershipId: id, displayName: name, taskCount: 1, fact: { key: 'fact', operation: 'sum', fieldId: null, unit: 'minutes', value: worked === null ? null : num(worked), coverage: { tasks: 1, filled: 1, missing: 0, null: 0, zero: 0 } },
  capacity: capacity && { membershipId: id ?? '', displayName: name, scheduleKnown: capacity.known ?? true, scheduledMinutes: capacity.scheduled, holidayMinutes: capacity.holiday ?? 0, absenceMinutes: capacity.away, availableMinutes: capacity.scheduled - capacity.away - (capacity.holiday ?? 0) },
});
const bucket = (start: string, end: string, people: unknown[]) => {
  const rows = people as ReturnType<typeof person>[];
  const capacities = rows.map(row => row.capacity);
  const unknown = capacities.filter(value => !value?.scheduleKnown).length;
  const total = (key: 'scheduledMinutes' | 'holidayMinutes' | 'absenceMinutes' | 'availableMinutes') => unknown > 0 ? null : capacities.reduce((sum, value) => sum + (value?.[key] ?? 0), 0);
  const fact = { key: 'fact', operation: 'sum', fieldId: null, unit: 'minutes', value: rows.some(row => row.fact.value === null) ? null : num(rows.reduce((sum, row) => sum + Number(row.fact.value?.numerator ?? 0), 0)) };
  return { startDate: start, endDate: end, people, fact, capacity: { scheduledMinutes: total('scheduledMinutes'), holidayMinutes: total('holidayMinutes'), absenceMinutes: total('absenceMinutes'), availableMinutes: total('availableMinutes'), unconfiguredMembers: unknown } };
};
const result = (buckets: unknown[], people: unknown[], rows: unknown[] = []) => ({ buckets, people, rows, sources: [{ projectId: 'p1', projectName: 'Week 42' }] }) as unknown as WorkspaceReportResultDto;

describe('hours worked against available hours', () => {

  it('keeps missing or non-duration facts distinct from an explicit zero', () => {
    const missing = person('a', 'Ann', null, { scheduled: 2400, away: 0 });
    const zero = person('b', 'Bo', 0, { scheduled: 2400, away: 0 });
    const numberFact = person('c', 'Cy', 3, { scheduled: 2400, away: 0 });
    numberFact.fact.unit = 'number';
    const rows = loadRows(result([bucket('2026-10-12', '2026-10-18', [missing, zero, numberFact])], [missing, zero, numberFact]), 'Team', 'Unassigned');
    expect(rows.find(row => row.key === 'a')?.cells[0]).toMatchObject({ ratio: null, workedMinutes: null, missing: 'fact' });
    expect(rows.find(row => row.key === 'b')?.cells[0]).toMatchObject({ ratio: 0, workedMinutes: 0, missing: null });
    expect(rows.find(row => row.key === 'c')?.cells[0]).toMatchObject({ ratio: null, workedMinutes: null, missing: 'fact' });
  });
  it('includes recorded work during zero-capacity time in the authoritative team numerator', () => {
    const a = person('a', 'Ann', 2400, { scheduled: 2400, away: 0 });
    const b = person('b', 'Bo', 480, { scheduled: 2400, away: 2400 });
    const rows = loadRows(result([bucket('2026-10-12', '2026-10-18', [a, b])], [a, b]), 'Team', 'Unassigned');
    expect(rows[0]?.cells[0]).toMatchObject({ ratio: 1.2, workedMinutes: 2880, availableMinutes: 2400 });
  });

  it('bands: under 90% is low, 90–95% fair, 95% and more good, nothing is none', () => {
    expect([0.5, 0.89, 0.9, 0.94, 0.95, 1.2, null].map(loadBand)).toEqual(['low', 'low', 'fair', 'fair', 'good', 'good', 'none']);
  });
  it('measures against the available hours, marks part weeks, and gives a dash for a week away or an unknown schedule', () => {
    const weeks = [
      bucket('2026-10-12', '2026-10-18', [person('a', 'Ann', 2280, { scheduled: 2400, away: 0 }), person('b', 'Bo', 1200, { scheduled: 2400, away: 1200 }), person('c', 'Cy', 0, { scheduled: 2400, away: 2400 }), person('d', 'Di', 900, { scheduled: 0, away: 0, known: false })]),
    ];
    const rows = loadRows(result(weeks, [person('a', 'Ann', 0, null), person('b', 'Bo', 0, null), person('c', 'Cy', 0, null), person('d', 'Di', 0, null)]), 'Team', 'Unassigned');
    const [team, ann, bo, cy, di] = rows;
    expect(ann?.cells[0]).toMatchObject({ ratio: 0.95, partial: false, missing: null });
    expect(bo?.cells[0]).toMatchObject({ ratio: 1, partial: true, awayMinutes: 1200 });
    expect(cy?.cells[0]).toMatchObject({ ratio: null, missing: 'away' });
    expect(di?.cells[0]).toMatchObject({ ratio: null, missing: 'unknown' });
    // An unknown schedule means the whole-team denominator is unknown, not a configured subset.
    expect(team?.cells[0]).toMatchObject({ ratio: null, missing: 'unknown' });
  });
});

describe('unfinished work', () => {
  it('counts open dated tasks per person and week, and lists those whose week is over, oldest first', () => {
    const task = (id: string, who: string | null, date: string | null, status: string, title = id) => ({ taskId: id, homeProjectId: 'p1', title, primaryAssigneeId: who, date, statusGroup: status, planMinutes: 60, factMinutes: null });
    const r = result([bucket('2026-10-12', '2026-10-18', []), bucket('2026-10-19', '2026-10-25', [])], [person('a', 'Ann', 0, null), person(null, 'Unassigned', 0, null)], [
      task('t1', 'a', '2026-10-16', 'todo'), task('t2', 'a', '2026-10-14', 'in_progress'), task('t3', 'a', '2026-10-15', 'done'), task('t4', 'a', '2026-10-24', 'todo'), task('t5', null, '2026-10-13', 'todo'), task('t6', 'a', null, 'todo'),
    ]);
    const out = unfinishedWork(r, '2026-10-23', 'Unassigned');
    expect(out.weeks.map(week => week.over)).toEqual([true, false]);
    const ann = out.people.find(p => p.membershipId === 'a');
    expect(ann?.perWeek).toEqual([2, 1]);
    expect(ann?.pastDue.map(task => task.taskId)).toEqual(['t2', 't1']);
    expect(out.people.find(p => p.membershipId === null)?.pastDue).toHaveLength(1);
  });
});
