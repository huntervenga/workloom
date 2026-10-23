import { describe, expect, it } from 'vitest';
import { dueBucket, localToday } from './dueBuckets';

describe('My tasks date groups', () => {
  it('sorts a due date into overdue, today, this week, later or none', () => {
    const today = '2026-10-23';
    expect(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-29', '2026-10-30', null].map(date => dueBucket(date, today))).toEqual(['overdue', 'today', 'week', 'week', 'later', 'none']);
  });
  it('crosses month and year ends by calendar days', () => {
    expect(dueBucket('2027-01-02', '2026-12-31')).toBe('week');
    expect(dueBucket('2026-12-31', '2027-01-01')).toBe('overdue');
  });
  it('formats the local date with zero padding', () => { expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05'); });
});
