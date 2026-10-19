import { describe, expect, it } from 'vitest';
import type { LeaveCalculationSource, LeaveProfileDto, LeaveRequestDto, LeaveTypeDto } from '@workloom/contracts';
import { assertLeaveSource, dateOrdinal, policyVersionForYear } from './calendar.js';
import { calculateAvailability, previewLeaveCharge } from './calculation.js';
import { assertConsistentLeaveType, calculateLeaveBalance, validateProjectedBalance, validateProjectedChange } from './accrual.js';

function required<T>(value: T | undefined): T { if (value === undefined) throw new Error('Missing fixture.'); return value; }
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = id(1); const member = id(2); const vacation = id(3); const flex = id(4); const unpaid = id(5);
function type(typeId = vacation, overrides: Partial<LeaveTypeDto> = {}): LeaveTypeDto {
  return { id: typeId, name: typeId === vacation ? 'Vacation' : typeId === flex ? 'Flexible days' : 'Own expense', color: '#00aa55', annualEntitlementMicrodays: typeId === flex ? 10_000_000 : 21_000_000, accrualMethod: 'daily', carryover: { mode: typeId === flex ? 'none' : 'unlimited', capMicrodays: null, expiresAfterMonths: null }, allowNegative: false, maxNegativeMicrodays: null, consumesBalance: true, pausesAccrual: false, capacityUnavailable: true, requiresApproval: true, archived: false, ...overrides };
}
function source(): LeaveCalculationSource {
  return {
    settings: { workspaceId: workspace, revision: 1, timezone: 'Asia/Nicosia', defaultWeeklyMinutes: [480,480,480,480,480,0,0], policyVersions: [{ effectiveYear: 2024, types: [type(),type(flex),type(unpaid, { annualEntitlementMicrodays: 0, consumesBalance: false, pausesAccrual: true })], holidays: [] }] },
    profiles: [{ workspaceId: workspace, membershipId: member, revision: 1, timezone: 'Asia/Nicosia', employmentStart: '2024-01-01', employmentEnd: null, accountingStart: '2024-01-01', openingBalances: [], schedulePeriods: [] }], requests: [], adjustments: [],
  };
}
function profile(s: LeaveCalculationSource): LeaveProfileDto { return required(s.profiles[0]); }
function request(s: LeaveCalculationSource, startDate: string, endDate: string, typeId = vacation, requestId = id(100)): LeaveRequestDto {
  const t = required(required(s.settings.policyVersions[0]).types.find((t) => t.id === typeId));
  return { id: requestId, workspaceId: workspace, membershipId: member, typeId, revision: 1, startDate, endDate, status: 'approved', note: '', createdBy: member, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', consumesBalance: t.consumesBalance, pausesAccrual: t.pausesAccrual, capacityUnavailable: t.capacityUnavailable, chargedDays: previewLeaveCharge(s, { membershipId: member, typeId, startDate, endDate }).chargedDays, negativeApproved: false };
}
const balance = (s: LeaveCalculationSource, asOf: string, typeId = vacation) => calculateLeaveBalance(s, { membershipId: member, typeId, asOf });

describe('configurable leave calendar and balances', () => {
  it('charges ten scheduled workdays for fourteen calendar days', () => {
    const result = previewLeaveCharge(source(), { membershipId: member, typeId: vacation, startDate: '2024-06-03', endDate: '2024-06-16' });
    expect(result.totalMicrodays).toBe(10_000_000); expect(result.chargedDays).toHaveLength(10); expect(result.unavailableMinutes).toBe(4800);
  });
  it('optional annual holidays exclude charges; deleting them restores ordinary days', () => {
    const s = source(); required(s.settings.policyVersions[0]).holidays = [{ id: id(8), name: 'Year end', rule: { kind: 'annual', month: 12, day: 31 } }, { id: id(9), name: 'New year', rule: { kind: 'annual', month: 1, day: 1 } }];
    const input = { membershipId: member, typeId: vacation, startDate: '2024-12-31', endDate: '2025-01-01' };
    expect(previewLeaveCharge(s,input).totalMicrodays).toBe(0); required(s.settings.policyVersions[0]).holidays = []; expect(previewLeaveCharge(s,input).totalMicrodays).toBe(2_000_000);
  });
  it('rejects impossible dates, duplicate years and invalid zones; annual Feb29 skips nonleap', () => {
    const s = source(); expect(() => dateOrdinal('2024-02-30')).toThrow(); required(s.settings.policyVersions[0]).holidays = [{ id: id(8), name: 'Leap day', rule: { kind: 'annual', month: 2, day: 29 } }]; expect(() => assertLeaveSource(s)).not.toThrow();
    expect(previewLeaveCharge(s,{membershipId: member,typeId:vacation,startDate:'2025-02-28',endDate:'2025-02-28'}).totalMicrodays).toBe(1_000_000);
    required(required(s.settings.policyVersions[0]).holidays[0]).rule = { kind: 'annual', month: 4, day: 31 }; expect(() => assertLeaveSource(s)).toThrow(); required(s.settings.policyVersions[0]).holidays = [];
    s.settings.policyVersions.push({ ...required(s.settings.policyVersions[0]) }); expect(() => assertLeaveSource(s)).toThrow(); s.settings.policyVersions.pop(); profile(s).timezone = 'No/Zone'; expect(() => assertLeaveSource(s)).toThrow();
  });
  it('uses exact actual-year daily accrual and partial employment/accounting start', () => {
    const s = source(); profile(s).employmentStart = '2024-07-01'; profile(s).accountingStart = '2024-07-01';
    expect(balance(s,'2024-12-31').earnedMicrodays).toBe(Number(21_000_000n*184n/366n));
    expect(balance(source(),'2024-12-31').earnedMicrodays).toBe(21_000_000);
  });
  it('preserves opening balances and carries vacation but expires flex', () => {
    const s = source(); profile(s).openingBalances = [{typeId: vacation,microdays:3_000_000},{typeId:flex,microdays:2_000_000}];
    expect(balance(s,'2025-01-01').availableMicrodays).toBe(24_000_000 + Math.floor(21_000_000/365));
    expect(balance(s,'2025-01-01',flex).expiredMicrodays).toBe(12_000_000); expect(balance(s,'2025-01-01',flex).availableMicrodays).toBe(Math.floor(10_000_000/365));
  });
  it('supports capped carry with an expiry without repricing prior entitlement', () => {
    const s=source(); required(required(s.settings.policyVersions[0]).types[0]).carryover={mode:'capped',capMicrodays:5_000_000,expiresAfterMonths:3};
    expect(balance(s,'2025-01-01').expiredMicrodays).toBe(16_000_000); expect(balance(s,'2025-04-01').expiredMicrodays).toBe(21_000_000);
    s.settings.policyVersions.push({effectiveYear:2025,types:[type(vacation,{annualEntitlementMicrodays:30_000_000}),type(flex),type(unpaid,{annualEntitlementMicrodays:0,consumesBalance:false,pausesAccrual:true})],holidays:[]});
    expect(required(policyVersionForYear(s.settings,2024).types[0]).annualEntitlementMicrodays).toBe(21_000_000); expect(balance(s,'2025-12-31').earnedMicrodays).toBe(51_000_000);
  });
  it('unpaid half-year pauses both pools for all calendar days including weekends', () => {
    const s=source(); s.requests=[request(s,'2024-07-01','2024-12-31',unpaid)];
    expect(balance(s,'2024-12-31').earnedMicrodays).toBe(Number(21_000_000n*182n/366n)); expect(balance(s,'2024-12-31',flex).earnedMicrodays).toBe(Number(10_000_000n*182n/366n));
    expect(balance(s,'2024-12-31',unpaid).takenMicrodays).toBe(0);
  });
  it('unions overlapping pause intervals and cancellation recredits accrued days', () => {
    const s=source(); s.requests=[request(s,'2024-07-01','2024-12-31',unpaid),request(s,'2024-08-01','2024-08-31',unpaid,id(101))];
    expect(balance(s,'2024-12-31').earnedMicrodays).toBe(Number(21_000_000n*182n/366n)); s.requests.forEach(r=>r.status='cancelled'); expect(balance(s,'2024-12-31').earnedMicrodays).toBe(21_000_000);
  });
  it('annual upfront also recalculates on unpaid pauses and does not credit twice', () => {
    const s=source(); required(required(s.settings.policyVersions[0]).types[0]).accrualMethod='annual_upfront'; expect(balance(s,'2024-01-01').earnedMicrodays).toBe(21_000_000);
    s.requests=[request(s,'2024-07-01','2024-12-31',unpaid)]; expect(balance(s,'2024-01-01').earnedMicrodays).toBe(Number(21_000_000n*182n/366n)); expect(balance(s,'2024-06-30').earnedMicrodays).toBe(balance(s,'2024-01-01').earnedMicrodays);
  });
  it('capacity is40h normally,32h after one absence; overlaps and holidays never double count', () => {
    const s=source(); const input={membershipIds:[member],startDate:'2024-06-03',endDate:'2024-06-09'};
    expect(calculateAvailability(s,input).reduce((n,d)=>n+d.availableMinutes,0)).toBe(2400); s.requests=[request(s,'2024-06-03','2024-06-03')]; expect(calculateAvailability(s,input).reduce((n,d)=>n+d.availableMinutes,0)).toBe(1920);
    s.requests.push(request(s,'2024-06-03','2024-06-03',unpaid,id(101))); expect(calculateAvailability(s,input).reduce((n,d)=>n+d.availableMinutes,0)).toBe(1920);
    required(s.settings.policyVersions[0]).holidays=[{id:id(8),name:'Holiday',rule:{kind:'date',date:'2024-06-03'}}]; expect(calculateAvailability(s,input)[0]).toMatchObject({holidayMinutes:480,absenceMinutes:0,availableMinutes:0});
  });
  it('reports overlaps for rejection and debits pinned charges once as date arrives', () => {
    const s=source(); s.requests=[request(s,'2024-06-03','2024-06-03')]; expect(previewLeaveCharge(s,{membershipId:member,typeId:vacation,startDate:'2024-06-03',endDate:'2024-06-03'}).overlappingRequestIds).toEqual([id(100)]);
    expect(balance(s,'2024-06-02').reservedFutureMicrodays).toBe(1_000_000); expect(balance(s,'2024-06-03').reservedFutureMicrodays).toBe(0); expect(balance(s,'2024-06-03').takenMicrodays).toBe(1_000_000);
    required(s.settings.policyVersions[0]).holidays=[{id:id(8),name:'New holiday',rule:{kind:'date',date:'2024-06-03'}}]; expect(balance(s,'2024-06-03').takenMicrodays).toBe(1_000_000);
  });
  it('validates every projected charge date including existing future bookings and explicit negative approval', () => {
    const s=source(); s.requests=[request(s,'2024-01-02','2024-01-02'),request(s,'2024-06-03','2024-06-03',vacation,id(101))];
    let deficits=validateProjectedBalance(s,{membershipId:member,typeId:vacation,asOf:'2024-01-01'}); expect(deficits[0]).toMatchObject({date:'2024-01-02',negativeAllowed:false,negativeApprovalRequired:true});
    required(required(s.settings.policyVersions[0]).types[0]).allowNegative=true; required(s.requests[0]).negativeApproved=true; deficits=validateProjectedBalance(s,{membershipId:member,typeId:vacation,asOf:'2024-01-01'}); expect(deficits[0]).toMatchObject({negativeAllowed:true,negativeApprovalRequired:false});
    required(required(s.settings.policyVersions[0]).types[0]).maxNegativeMicrodays=100; expect(required(validateProjectedBalance(s,{membershipId:member,typeId:vacation,asOf:'2024-01-01'})[0]).negativeAllowed).toBe(false);
  });
  it('valid future reservations do not manufacture current debt or borrow another pool', () => {
    const s = source();
    s.requests = [request(s, '2024-12-02', '2024-12-06')];
    const result = balance(s, '2024-01-01');
    expect(result.availableMicrodays).toBe(Math.floor(21_000_000 / 366));
    expect(result.reservedFutureMicrodays).toBe(5_000_000);
    expect(result.projectedAvailableMicrodays).toBeGreaterThan(0);
    expect(result.projectedThroughDate).toBe('2024-12-06');
    expect(validateProjectedBalance(s, { membershipId: member, typeId: vacation, asOf: '2024-01-01' })).toEqual([]);
    expect(balance(s, '2024-12-06', flex).takenMicrodays).toBe(0);
  });
  it('does not pause accrual for pending or rejected unpaid requests', () => {
    const s = source();
    s.requests = [request(s, '2024-01-01', '2024-12-31', unpaid)];
    required(s.requests[0]).status = 'pending';
    expect(balance(s, '2024-12-31').earnedMicrodays).toBe(21_000_000);
    required(s.requests[0]).status = 'rejected';
    expect(balance(s, '2024-12-31').earnedMicrodays).toBe(21_000_000);
  });
  it('supports cutover opening balances without re-accruing earlier employment', () => {
    const s = source();
    profile(s).accountingStart = '2024-07-01';
    profile(s).openingBalances = [{ typeId: vacation, microdays: 7_000_000 }];
    expect(balance(s, '2024-06-30').availableMicrodays).toBe(0);
    const result = balance(s, '2024-12-31');
    expect(result.openingMicrodays).toBe(7_000_000);
    expect(result.availableMicrodays).toBe(7_000_000 + Number(21_000_000n * 184n / 366n));
    profile(s).employmentStart = '2020-01-01';
    profile(s).accountingStart = '2023-01-01';
    expect(() => assertLeaveSource(s)).toThrow();
  });
  it('requires explicit split when request snapshot behavior changes across a policy boundary', () => {
    const s = source();
    s.settings.policyVersions.push({ effectiveYear: 2025, types: [type(vacation, { consumesBalance: false }), type(flex), type(unpaid, { annualEntitlementMicrodays: 0, consumesBalance: false, pausesAccrual: true })], holidays: [] });
    expect(() => assertConsistentLeaveType(s, vacation, '2024-12-30', '2025-01-03')).toThrow();
  });
  it('keeps source immutable and exact positive and negative opening adjustments', () => {
    const s = source();
    profile(s).openingBalances = [{ typeId: vacation, microdays: 1_000_000_000_000 }];
    s.adjustments = [{ id: id(500), membershipId: member, typeId: vacation, effectiveDate: '2024-01-02', deltaMicrodays: -123, reason: 'Prior correction' }];
    const before = JSON.stringify(s);
    const result = balance(s, '2024-01-02');
    expect(result.availableMicrodays).toBe(1_000_000_000_000 + Number(21_000_000n * 2n / 366n) - 123);
    expect(result.adjustmentMicrodays).toBe(-123);
    expect(JSON.stringify(s)).toBe(before);
  });
  it('attributes new deficits on existing bookings to explicit approval of the causative write', () => {
    const before = source();
    required(required(before.settings.policyVersions[0]).types[0]).allowNegative = true;
    before.requests = [request(before, '2024-03-01', '2024-03-01', vacation, id(101))];
    const after: LeaveCalculationSource = JSON.parse(JSON.stringify(before)) as LeaveCalculationSource;
    after.requests.push({ ...request(after, '2024-02-05', '2024-02-09'), negativeApproved: true });
    const deficits = validateProjectedChange(before, after, { membershipId: member, asOf: '2024-01-01', negativeApproved: true });
    expect(deficits.find((deficit) => deficit.requestId === id(101))).toMatchObject({ date: '2024-03-01', negativeAllowed: true, negativeApprovalRequired: false });
    expect(required(after.requests[0]).negativeApproved).toBe(false);
  });
  it('a retrospective unpaid correction validates new shortages across both paid pools', () => {
    const before = source();
    before.requests = [request(before, '2024-12-02', '2024-12-20'), request(before, '2024-12-23', '2024-12-31', flex, id(101))];
    const after: LeaveCalculationSource = JSON.parse(JSON.stringify(before)) as LeaveCalculationSource;
    after.requests.push(request(after, '2024-03-01', '2024-08-31', unpaid, id(102)));
    const deficits = validateProjectedChange(before, after, { membershipId: member, asOf: '2024-12-31', deficitFrom: '2024-03-01', negativeApproved: false });
    expect([...new Set(deficits.map((deficit) => deficit.typeId))].sort()).toEqual([vacation, flex].sort());
    expect(deficits.every((deficit) => !deficit.negativeAllowed && deficit.negativeApprovalRequired)).toBe(true);
  });
  it('a carry cap preserves the longest-lived balance while spending uses the earliest expiry', () => {
    const s = source();
    required(required(s.settings.policyVersions[0]).types[0]).carryover = { mode: 'capped', capMicrodays: 5_000_000, expiresAfterMonths: 18 };
    expect(balance(s, '2026-07-01').expiredMicrodays).toBe(37_000_000);
    const spend = source();
    required(required(spend.settings.policyVersions[0]).types[0]).carryover = { mode: 'capped', capMicrodays: 5_000_000, expiresAfterMonths: 3 };
    spend.requests = [request(spend, '2025-01-06', '2025-01-10')];
    expect(balance(spend, '2025-04-01').expiredMicrodays).toBe(16_000_000);
  });
  it('rejects removed and unknown types instead of silently dropping a carried balance', () => {
    const s = source();
    s.settings.policyVersions.push({ effectiveYear: 2025, types: [type()], holidays: [] });
    expect(() => assertLeaveSource(s)).toThrow('Previously configured absence types must be retained');
    expect(() => balance(source(), '2024-01-01', id(999))).toThrow('Unknown absence balance type');
    expect(() => calculateAvailability(source(), { membershipIds: [member], startDate: '2023-12-31', endDate: '2024-01-01' })).not.toThrow();
    const employedEarlier = source();
    profile(employedEarlier).employmentStart = '2020-01-01';
    expect(() => calculateAvailability(employedEarlier, { membershipIds: [member], startDate: '2023-12-29', endDate: '2024-01-01' })).toThrow('No leave policy covers');
  });
  it('inactive history preserves its shape without constraining corrected employment or accounting dates', () => {
    for (const status of ['cancelled', 'rejected'] as const) {
      const s = source();
      const historical = request(s, '2024-06-03', '2024-06-07');
      historical.status = status;
      s.requests = [historical];
      profile(s).employmentEnd = '2024-05-31';
      expect(() => assertLeaveSource(s)).not.toThrow();
      profile(s).employmentEnd = null;
      profile(s).accountingStart = '2024-07-01';
      expect(() => assertLeaveSource(s)).not.toThrow();
      historical.chargedDays[0] = { date: '2024-06-02', microdays: 1_000_000, scheduledMinutes: 480 };
      expect(() => assertLeaveSource(s)).toThrow('Approved charge allocation must match');
    }
  });
  it('active pending and approved requests still constrain corrected employment and accounting dates', () => {
    for (const status of ['pending', 'approved'] as const) {
      const s = source();
      const active = request(s, '2024-06-03', '2024-06-07');
      active.status = status;
      s.requests = [active];
      profile(s).employmentEnd = '2024-05-31';
      expect(() => assertLeaveSource(s)).toThrow('Absence must fall within');
      profile(s).employmentEnd = null;
      profile(s).accountingStart = '2024-07-01';
      expect(() => assertLeaveSource(s)).toThrow('Absence must fall within');
    }
  });
  it('compares opaque type IDs case-insensitively at the pure domain boundary', () => {
    const s = source();
    const typeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    required(required(s.settings.policyVersions[0]).types[0]).id = typeId;
    expect(previewLeaveCharge(s, { membershipId: member, typeId: typeId.toUpperCase(), startDate: '2024-06-03', endDate: '2024-06-03' }).totalMicrodays).toBe(1_000_000);
    expect(balance(s, '2024-12-31', typeId.toUpperCase()).earnedMicrodays).toBe(21_000_000);
  });
  it('honors effective part-time schedules and employment clipping independently of charge history', () => {
    const s=source(); profile(s).schedulePeriods=[{effectiveFrom:'2024-06-01',weeklyMinutes:[240,240,240,240,240,0,0]}]; profile(s).employmentEnd='2024-06-04';
    const result=calculateAvailability(s,{membershipIds:[member],startDate:'2024-06-03',endDate:'2024-06-05'}); expect(result.map(d=>d.availableMinutes)).toEqual([240,240,0]);
    expect(previewLeaveCharge(s,{membershipId:member,typeId:vacation,startDate:'2024-06-03',endDate:'2024-06-04'}).totalMicrodays).toBe(2_000_000);
  });
});
