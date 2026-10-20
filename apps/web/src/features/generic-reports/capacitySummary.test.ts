import type { LeaveAvailabilityDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { capacitySummary } from './capacitySummary';

type Member = LeaveAvailabilityDto['members'][number];
const ANNA = 'a1000000-0000-4000-8000-000000000001', BORIS = 'a1000000-0000-4000-8000-000000000002', CHEN = 'a1000000-0000-4000-8000-000000000003';

const known = (membershipId: string, scheduledMinutes: number, absenceMinutes = 0): Member => ({ membershipId, displayName: membershipId, scheduleKnown: true, scheduledMinutes, holidayMinutes: 0, absenceMinutes, availableMinutes: scheduledMinutes - absenceMinutes });
const unknown = (membershipId: string): Member => ({ membershipId, displayName: membershipId, scheduleKnown: false, scheduledMinutes: null, holidayMinutes: null, absenceMinutes: null, availableMinutes: null });
const capacity = (members: Member[], availableMinutes: number, unconfiguredMembers: number, settingsConfigured = true): LeaveAvailabilityDto => ({ startDate: '2026-10-05', endDate: '2026-10-09', settingsConfigured, sourceVersion: 'c'.repeat(64), days: [], intervals: [], companyHolidays: [], inputVersions: { settingsRevision: 1, profiles: [], requests: [] }, members, totals: { scheduledMinutes: availableMinutes, holidayMinutes: 0, absenceMinutes: 0, availableMinutes, unconfiguredMembers } });
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value as object).forEach(freeze); Object.freeze(value); }
  return value;
};

describe('capacitySummary', () => {
  it('returns unknown capacity with no members when the DTO is not included', () => {
    expect(capacitySummary(undefined)).toEqual({ availableMinutes: null, knownMembers: 0, totalMembers: 0, unknownMembers: 0, partial: false, complete: false });
  });

  it('keeps the known 1920 subtotal beside an unknown peer but marks it partial, not complete', () => {
    const summary = capacitySummary(capacity([known(ANNA, 2400, 480), unknown(BORIS)], 1920, 1));
    expect(summary).toEqual({ availableMinutes: 1920, knownMembers: 1, totalMembers: 2, unknownMembers: 1, partial: true, complete: false });
  });

  it('returns null instead of a fake 0 when every schedule is unknown', () => {
    expect(capacitySummary(capacity([unknown(ANNA), unknown(BORIS)], 0, 2))).toEqual({ availableMinutes: null, knownMembers: 0, totalMembers: 2, unknownMembers: 2, partial: false, complete: false });
  });

  it('treats every member as unknown when settings are unconfigured, ignoring server minutes and flags', () => {
    expect(capacitySummary(capacity([known(ANNA, 2400), unknown(BORIS)], 2400, 1, false))).toEqual({ availableMinutes: null, knownMembers: 0, totalMembers: 2, unknownMembers: 2, partial: false, complete: false });
  });

  it('preserves a known zero schedule as 0, complete alone and partial beside an unknown peer', () => {
    expect(capacitySummary(capacity([known(ANNA, 0)], 0, 0))).toEqual({ availableMinutes: 0, knownMembers: 1, totalMembers: 1, unknownMembers: 0, partial: false, complete: true });
    expect(capacitySummary(capacity([known(ANNA, 0), unknown(BORIS)], 0, 1))).toMatchObject({ availableMinutes: 0, partial: true, complete: false });
  });

  it('reports a configured scope with no members as a complete 0', () => {
    expect(capacitySummary(capacity([], 0, 0))).toEqual({ availableMinutes: 0, knownMembers: 0, totalMembers: 0, unknownMembers: 0, partial: false, complete: true });
  });

  it('treats legacy totals with unconfigured members but no member rows as unknown', () => {
    expect(capacitySummary(capacity([], 0, 3))).toEqual({ availableMinutes: null, knownMembers: 0, totalMembers: 3, unknownMembers: 3, partial: false, complete: false });
  });

  it('uses the server aggregate minutes rather than summing member rows', () => {
    expect(capacitySummary(capacity([known(ANNA, 600), known(BORIS, 600)], 1920, 0)).availableMinutes).toBe(1920);
  });

  it('counts unknown members as the larger of server count and member flags, never their sum', () => {
    expect(capacitySummary(capacity([known(ANNA, 2400), unknown(BORIS)], 2400, 2))).toMatchObject({ knownMembers: 1, unknownMembers: 2, totalMembers: 3 });
    expect(capacitySummary(capacity([known(ANNA, 2400), unknown(BORIS), unknown(CHEN)], 2400, 0))).toMatchObject({ knownMembers: 1, unknownMembers: 2, totalMembers: 3 });
    expect(capacitySummary(capacity([known(ANNA, 2400), unknown(BORIS)], 2400, 1))).toMatchObject({ unknownMembers: 1, totalMembers: 2 });
  });

  it('does not mutate the input DTO', () => {
    const input = freeze(capacity([known(ANNA, 2400, 480), unknown(BORIS)], 1920, 1));
    const before = structuredClone(input);
    capacitySummary(input);
    expect(input).toEqual(before);
  });
});
