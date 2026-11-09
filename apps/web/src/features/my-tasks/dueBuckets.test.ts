import { describe, expect, it } from 'vitest';
import { dueBucket } from './dueBuckets';

describe('My tasks date groups', () => {
  it('sorts a due date into overdue, today, tomorrow, later or none', () => {
    const today = '2026-10-23';
    expect(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-29', '2026-10-30', null].map(date => dueBucket(date, today))).toEqual(['overdue', 'today', 'tomorrow', 'later', 'later', 'none']);
  });
  it('crosses month and year ends by calendar days', () => {
    expect(dueBucket('2027-01-02', '2026-12-31')).toBe('later');
    expect(dueBucket('2026-12-31', '2027-01-01')).toBe('overdue');
  });

});
