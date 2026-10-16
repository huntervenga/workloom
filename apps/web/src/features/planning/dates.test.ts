import { describe, expect, it } from 'vitest';
import { formatPeriodCutoff, parseLocalDateTime } from './dates';

describe('local cutoff entry', () => {
  it('rejects dates and times the browser would normalize instead of silently scheduling another instant', () => {
    for (const value of ['2027-02-30T10:00', '2027-13-10T10:00', '2027-01-10T24:00', '2027-01-10T10:60', '2027-01-10', '2027-01-10T10:00Z']) {
      expect(parseLocalDateTime(value)).toBeNull();
    }
    const date = parseLocalDateTime('2027-01-12T14:35');
    expect(date?.getHours()).toBe(14);
    expect(date?.getMinutes()).toBe(35);
    expect(date?.getDate()).toBe(12);
  });
});

describe('period cutoff display', () => {
  it('uses the named period zone, including its calendar date across a UTC midnight boundary', () => {
    const timestamp = '2026-10-19T22:30:00.000Z';
    expect(formatPeriodCutoff(timestamp, 'Asia/Nicosia')).toMatch(/20.*10.*01:30/);
    expect(formatPeriodCutoff(timestamp, 'Europe/Berlin')).toMatch(/20.*10.*00:30/);
  });
});
