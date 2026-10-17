import { describe, expect, it } from 'vitest';
import { calendarAxis, calendarWindow, clipDates, dayIndex, fitLoadedWindow, shiftDay, windowCoverage, windowDays, windowOffset } from './dates';

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

describe('calendar axis cues', () => {
  it('splits months inside the window and marks ISO weekends across a DST weekend without day drift', () => {
    const window = calendarWindow('2026-10-24', 28);
    if (!window) throw new Error('Expected window');
    const axis = calendarAxis(window);
    expect(axis.days).toHaveLength(28);
    expect(axis.months).toEqual([{ month: '2026-10', first: '2026-10-24', offset: 0, days: 8 }, { month: '2026-11', first: '2026-11-01', offset: 8, days: 20 }]);
    // 2026-10-25 is the European DST change; it is still exactly one Sunday cell.
    expect(axis.days.slice(0, 3).map(day => [day.date, day.weekday, day.weekend])).toEqual([['2026-10-24', 6, true], ['2026-10-25', 7, true], ['2026-10-26', 1, false]]);
    expect(axis.days.filter(day => day.weekend)).toHaveLength(8);
    expect(windowOffset('2026-10-26', window)).toBe(2);
    expect(windowOffset('2026-10-23', window)).toBeNull();
    expect(windowOffset('2026-02-30', window)).toBeNull();
  });
  it('keeps a full-year axis bounded to 366 cells and year boundaries explicit', () => {
    const window = calendarWindow('0099-12-01', 366);
    if (!window) throw new Error('Expected window');
    const axis = calendarAxis(window);
    expect(axis.days).toHaveLength(366);
    expect(axis.months[0]).toMatchObject({ month: '0099-12', days: 31 });
    expect(axis.months[1]).toMatchObject({ month: '0100-01', offset: 31 });
    expect(calendarAxis(calendarWindow('9999-12-30', 366) ?? window).days.map(day => day.date)).toEqual(['9999-12-30', '9999-12-31']);
  });
});

describe('explicit fit to loaded dates', () => {
  it('reports nothing to fit when no loaded range has a valid date', () => {
    expect(fitLoadedWindow([])).toEqual({ kind: 'none' });
    expect(fitLoadedWindow([{ start: null, due: null }, { start: '2026-05-02', due: '2026-05-01' }, { start: '2026-02-30', due: null }])).toEqual({ kind: 'none' });
  });
  it('fits overdue past dates in the smallest 28/84/366 window with a short lead-in', () => {
    expect(fitLoadedWindow([{ start: '2026-08-03', due: '2026-08-07' }, { start: null, due: '2026-08-20' }])).toEqual({ kind: 'fit', start: '2026-08-02', days: 28, earliest: '2026-08-03', latest: '2026-08-20', span: 18, count: 2 });
    expect(fitLoadedWindow([{ start: '2026-01-01', due: '2026-02-15' }])).toMatchObject({ kind: 'fit', start: '2025-12-29', days: 84, span: 46 });
    expect(fitLoadedWindow([{ start: '2026-01-01', due: null }, { start: null, due: '2026-09-30' }])).toMatchObject({ kind: 'fit', days: 366, span: 273, count: 2 });
    // A span equal to the window leaves no room for a lead-in but still covers both endpoints.
    expect(fitLoadedWindow([{ start: '2026-03-01', due: '2026-03-28' }])).toMatchObject({ start: '2026-03-01', days: 28 });
  });
  it('starts wider spans at the earliest date and says the 366-day maximum was reached', () => {
    expect(fitLoadedWindow([{ start: '0001-01-01', due: '9999-12-31' }, { start: '2026-01-01', due: null }])).toEqual({ kind: 'wide', start: '0001-01-01', days: 366, earliest: '0001-01-01', latest: '9999-12-31', span: 3652059, count: 2 });
  });
  it('keeps both calendar bounds when the loaded dates touch 0001-01-01 or 9999-12-31', () => {
    expect(fitLoadedWindow([{ start: '0001-01-02', due: '0001-01-03' }])).toMatchObject({ kind: 'fit', start: '0001-01-01', days: 28 });
    const late = fitLoadedWindow([{ start: '9999-12-30', due: '9999-12-31' }]);
    expect(late).toMatchObject({ kind: 'fit', start: '9999-12-04', days: 28 });
    if (late.kind !== 'fit') throw new Error('Expected fit');
    expect(calendarWindow(late.start, late.days)).toMatchObject({ end: '9999-12-31', days: 28 });
  });
  it('counts valid loaded ranges inside, before and after a window', () => {
    const window = calendarWindow('2026-10-17', 28);
    if (!window) throw new Error('Expected window');
    expect(windowCoverage([{ start: '2026-09-01', due: '2026-09-05' }, { start: '2026-10-10', due: '2026-10-18' }, { start: null, due: '2026-12-01' }, { start: null, due: null }, { start: '2026-10-20', due: '2026-10-19' }], window)).toEqual({ dated: 3, inside: 1, before: 1, after: 1 });
  });
});
