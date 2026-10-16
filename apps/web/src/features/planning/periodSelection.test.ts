import { describe, expect, it } from 'vitest';
import { selectPlanningPeriodId, sortPlanningPeriods } from './periodSelection';

function period(id: string, start: string, end: string, timezone = 'UTC') {
  return { id, localStart: start, localEndExclusive: end, timezone };
}

describe('weekly period selection', () => {
  it('uses each period local calendar date, even while UTC and another period are still on the preceding day', () => {
    const losAngeles = period('a', '2026-10-19', '2026-10-26', 'America/Los_Angeles');
    const kiritimati = period('z', '2026-10-19', '2026-10-26', 'Pacific/Kiritimati');
    const old = period('0', '2026-10-05', '2026-10-12');
    expect(selectPlanningPeriodId([old, losAngeles, kiritimati], null, new Date('2026-10-18T10:30:00Z'))).toBe('z');
  });

  it('selects nearest upcoming before latest past and treats the week end as exclusive', () => {
    const past = period('a', '2026-10-12', '2026-10-19');
    const recent = period('z', '2026-10-19', '2026-10-26');
    const upcoming = period('y', '2026-11-02', '2026-11-09');
    const later = period('b', '2026-11-09', '2026-11-16');
    const at = new Date('2026-10-26T00:00:00Z');
    expect(selectPlanningPeriodId([later, past, recent, upcoming], null, at)).toBe('y');
    expect(selectPlanningPeriodId([past, recent], null, at)).toBe('z');
  });

  it('orders newest weeks first and resolves overlapping current periods deterministically', () => {
    const old = period('a', '2026-10-12', '2026-10-19');
    const current = period('z', '2026-10-19', '2026-10-26');
    const overlapB = period('b', '2026-10-20', '2026-10-27');
    const overlapA = period('a2', '2026-10-20', '2026-10-27');
    const input = [old, current, overlapB, overlapA];
    expect(sortPlanningPeriods(input).map((item) => item.id)).toEqual(['a2', 'b', 'z', 'a']);
    expect(selectPlanningPeriodId(input, null, new Date('2026-10-21T12:00:00Z'))).toBe('a2');
    expect(selectPlanningPeriodId([...input].reverse(), null, new Date('2026-10-21T12:00:00Z'))).toBe('a2');
  });

  it('preserves an explicit URL choice and handles an empty collection without a fabricated week', () => {
    const current = period('current', '2026-10-19', '2026-10-26');
    expect(selectPlanningPeriodId([current], 'chosen-other-period', new Date('2026-10-21T12:00:00Z'))).toBe('chosen-other-period');
    expect(selectPlanningPeriodId([current], '', new Date('2026-10-21T12:00:00Z'))).toBe('');
    expect(selectPlanningPeriodId([], null)).toBeNull();
  });
});
