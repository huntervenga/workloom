import { describe, expect, it } from 'vitest';
import { isLeaveHistoricalAbsenceCorrection, type LeaveRequestDto } from './leave.js';

const id = (n: number) => `88000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const today = '2026-10-19';

function approvedRequest(start = '2026-10-01', end = '2026-10-10'): LeaveRequestDto {
  return {
    id: id(1),
    workspaceId: id(2),
    membershipId: id(3),
    typeId: id(4),
    revision: 2,
    startDate: start,
    endDate: end,
    status: 'approved',
    note: '',
    createdBy: id(5),
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    consumesBalance: true,
    pausesAccrual: false,
    capacityUnavailable: true,
    chargedDays: [],
    negativeApproved: false,
  };
}

describe('bounded historical absence correction eligibility', () => {
  it('recognizes eligible fully-elapsed approved date correction with manager and reason', () => {
    const before = approvedRequest('2026-10-01', '2026-10-10');
    const proposed = { ...before, startDate: '2026-10-02', endDate: '2026-10-08' };
    expect(isLeaveHistoricalAbsenceCorrection(before, proposed, {
      canManage: true,
      today,
      reason: 'Correcting actual dates from payroll',
    })).toBe(true);
  });

  it('requires canManage authority', () => {
    const before = approvedRequest('2026-10-01', '2026-10-10');
    const proposed = { ...before, startDate: '2026-10-02' };
    expect(isLeaveHistoricalAbsenceCorrection(before, proposed, {
      canManage: false,
      today,
      reason: 'Employee cannot do this',
    })).toBe(false);
  });

  it('requires nonempty reason (trims whitespace)', () => {
    const before = approvedRequest('2026-10-01', '2026-10-10');
    const proposed = { ...before, startDate: '2026-10-02' };
    expect(isLeaveHistoricalAbsenceCorrection(before, proposed, {
      canManage: true,
      today,
      reason: '',
    })).toBe(false);
    expect(isLeaveHistoricalAbsenceCorrection(before, proposed, {
      canManage: true,
      today,
      reason: '   ',
    })).toBe(false);
  });

  it('requires existing before record', () => {
    const proposed = approvedRequest('2026-10-01', '2026-10-10');
    expect(isLeaveHistoricalAbsenceCorrection(undefined, proposed, {
      canManage: true,
      today,
      reason: 'Creating new is not correction',
    })).toBe(false);
  });

  it('requires both statuses approved', () => {
    const before = approvedRequest();
    const pendingBefore = { ...before, status: 'pending' as const };
    const proposed = { ...before, startDate: '2026-10-02' };
    expect(isLeaveHistoricalAbsenceCorrection(pendingBefore, proposed, {
      canManage: true,
      today,
      reason: 'Pending is not eligible',
    })).toBe(false);
    expect(isLeaveHistoricalAbsenceCorrection(before, { ...proposed, status: 'cancelled' as const }, {
      canManage: true,
      today,
      reason: 'Cancelled is not eligible',
    })).toBe(false);
  });

  it('requires same membershipId and typeId', () => {
    const before = approvedRequest();
    expect(isLeaveHistoricalAbsenceCorrection(before, { ...before, membershipId: id(99), startDate: '2026-10-02' }, {
      canManage: true,
      today,
      reason: 'Different person',
    })).toBe(false);
    expect(isLeaveHistoricalAbsenceCorrection(before, { ...before, typeId: id(99), startDate: '2026-10-02' }, {
      canManage: true,
      today,
      reason: 'Different type',
    })).toBe(false);
  });

  it('requires actual date change', () => {
    const before = approvedRequest();
    expect(isLeaveHistoricalAbsenceCorrection(before, before, {
      canManage: true,
      today,
      reason: 'No change means no correction',
    })).toBe(false);
  });

  it('requires both old and new endDate strictly before today', () => {
    // New end on today - not eligible
    const before = approvedRequest('2026-10-01', '2026-10-10');
    expect(isLeaveHistoricalAbsenceCorrection(before, { ...before, endDate: today }, {
      canManage: true,
      today,
      reason: 'Same-day end is not historical',
    })).toBe(false);

    // New end in future - not eligible
    expect(isLeaveHistoricalAbsenceCorrection(before, { ...before, endDate: '2026-10-25' }, {
      canManage: true,
      today,
      reason: 'Future end is not historical',
    })).toBe(false);

    // Old end on today - not eligible (ongoing absence)
    const ongoingBefore = approvedRequest('2026-10-01', today);
    expect(isLeaveHistoricalAbsenceCorrection(ongoingBefore, { ...ongoingBefore, endDate: '2026-10-18' }, {
      canManage: true,
      today,
      reason: 'Ongoing cannot be corrected this way',
    })).toBe(false);

    // Old end in future - not eligible (booked future)
    const futureBefore = approvedRequest('2026-10-01', '2026-10-25');
    expect(isLeaveHistoricalAbsenceCorrection(futureBefore, { ...futureBefore, endDate: '2026-10-18' }, {
      canManage: true,
      today,
      reason: 'Future booking is not historical',
    })).toBe(false);
  });

  it('uses authoritative today boundary precisely', () => {
    const before = approvedRequest('2026-10-01', '2026-10-18');
    const proposed = { ...before, startDate: '2026-10-02' };
    // With today='2026-10-19', endDate='2026-10-18' is strictly before - eligible
    expect(isLeaveHistoricalAbsenceCorrection(before, proposed, {
      canManage: true,
      today: '2026-10-19',
      reason: 'Day before today is eligible',
    })).toBe(true);
    // With today='2026-10-18', endDate='2026-10-18' is NOT strictly before - ineligible
    expect(isLeaveHistoricalAbsenceCorrection(before, proposed, {
      canManage: true,
      today: '2026-10-18',
      reason: 'Same day not strictly before',
    })).toBe(false);
  });

  it('does not accept any bypass flag or API field (derives from trusted values only)', () => {
    // The helper signature only accepts before, proposed subset, and context.
    // No bypass/approveHistorical/exemptNegative field exists.
    const before = approvedRequest();
    const proposed = { ...before, startDate: '2026-10-02' };
    const context = { canManage: true, today, reason: 'Legitimate correction' };
    // Adding arbitrary fields to proposed or context does not change behavior
    const extendedProposed = { ...proposed, bypassChecks: true } as typeof proposed;
    expect(isLeaveHistoricalAbsenceCorrection(before, extendedProposed, context)).toBe(true);
  });
});
