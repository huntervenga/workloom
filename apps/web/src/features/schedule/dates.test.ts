import { describe, expect, it } from 'vitest';
import { calendarWindow, clipDates, dayIndex, shiftDay, windowDays } from './dates';

describe('bounded date-only Gantt geometry', () => {
  it('clips a full SQL calendar range before calculating 28/84/366-day geometry', () => {
    for (const days of [28, 84, 366]) {
      const window = calendarWindow('2026-03-20', days);
      if (!window) throw new Error('Expected calendar window');
      expect(windowDays(window)).toHaveLength(days);
      expect(clipDates('0001-01-01', '9999-12-31', window)).toEqual({ kind: 'range', left: 0, width: 100, continuesBefore: true, continuesAfter: true });
    }
    expect(calendarWindow('2026-01-01', 367)).toBeNull();
  });
  it('keeps one-day ranges, lone endpoints and absent dates distinct', () => {
    const window = calendarWindow('2026-03-28', 28);
    if (!window) throw new Error('Expected window');
    const sameDay = clipDates('2026-03-29', '2026-03-29', window);
    expect(sameDay.kind).toBe('range');
    if (sameDay.kind === 'range') expect(sameDay.width).toBeCloseTo(100 / 28);
    expect(clipDates(null, '2026-03-29', window)).toMatchObject({ kind: 'point', endpoint: 'due' });
    expect(clipDates(null, null, window)).toEqual({ kind: 'none' });
    expect(clipDates('9999-12-31', null, window)).toEqual({ kind: 'outside', endpoint: '9999-12-31' });
  });
  it('uses real Gregorian years without year0/99 remapping or DST-sized day steps', () => {
    expect(dayIndex('0000-01-01')).toBeNull();
    expect(dayIndex('2026-02-29')).toBeNull();
    expect(shiftDay('0099-12-31', 1)).toBe('0100-01-01');
    expect(shiftDay('2000-02-28', 1)).toBe('2000-02-29');
    expect(shiftDay('1900-02-28', 1)).toBe('1900-03-01');
    expect(shiftDay('2026-03-28', 2)).toBe('2026-03-30');
    expect(shiftDay('0001-01-01', -1)).toBeNull();
    expect(shiftDay('9999-12-31', 1)).toBeNull();
    expect(calendarWindow('9999-12-31', 366)).toMatchObject({ end: '9999-12-31', days: 1 });
  });
});
