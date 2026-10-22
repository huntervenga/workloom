import { describe, it, expect } from 'vitest';
import { isLeaveHistoricalAbsenceCreation, isLeaveHistoricalAbsenceCorrection, isLeaveHistoricalAbsenceRecording, leaveRequestSchema } from './leave.js';

describe('isLeaveHistoricalAbsenceCreation', () => {
  const today = '2026-03-15';

  it('returns true for manager with endDate strictly before today', () => {
    expect(isLeaveHistoricalAbsenceCreation(
      { endDate: '2026-03-14' },
      { canManage: true, today }
    )).toBe(true);
  });

  it('returns false when endDate equals today (not strictly past)', () => {
    expect(isLeaveHistoricalAbsenceCreation(
      { endDate: '2026-03-15' },
      { canManage: true, today }
    )).toBe(false);
  });

  it('returns false when endDate is after today', () => {
    expect(isLeaveHistoricalAbsenceCreation(
      { endDate: '2026-03-16' },
      { canManage: true, today }
    )).toBe(false);
  });

  it('returns false for non-manager even with past endDate', () => {
    expect(isLeaveHistoricalAbsenceCreation(
      { endDate: '2026-03-14' },
      { canManage: false, today }
    )).toBe(false);
  });

  it('handles boundary at year start', () => {
    expect(isLeaveHistoricalAbsenceCreation(
      { endDate: '2025-12-31' },
      { canManage: true, today: '2026-01-01' }
    )).toBe(true);
  });

  it('handles long historical range (335 days)', () => {
    expect(isLeaveHistoricalAbsenceCreation(
      { endDate: '2025-04-15' },
      { canManage: true, today }
    )).toBe(true);
  });
});

describe('isLeaveHistoricalAbsenceCorrection boundary with creation', () => {
  const today = '2026-03-15';
  const context = { canManage: true, today, reason: 'Correcting dates' };

  it('correction requires existing before record', () => {
    // Creation has no before, so correction is false
    expect(isLeaveHistoricalAbsenceCorrection(
      undefined,
      { membershipId: 'm1', typeId: 't1', startDate: '2026-03-01', endDate: '2026-03-10', status: 'approved' },
      context
    )).toBe(false);
  });

  it('correction with before record returns true when both ends strictly before today', () => {
    expect(isLeaveHistoricalAbsenceCorrection(
      { id: 'r1', workspaceId: 'w1', membershipId: 'm1', typeId: 't1', revision: 1, startDate: '2026-03-01', endDate: '2026-03-10', status: 'approved', note: '', createdBy: 'm1', createdAt: '', updatedAt: '', consumesBalance: true, pausesAccrual: false, capacityUnavailable: true, chargedDays: [], negativeApproved: false },
      { membershipId: 'm1', typeId: 't1', startDate: '2026-03-02', endDate: '2026-03-12', status: 'approved' },
      context
    )).toBe(true);
  });

  it('correction fails when new endDate equals today', () => {
    expect(isLeaveHistoricalAbsenceCorrection(
      { id: 'r1', workspaceId: 'w1', membershipId: 'm1', typeId: 't1', revision: 1, startDate: '2026-03-01', endDate: '2026-03-10', status: 'approved', note: '', createdBy: 'm1', createdAt: '', updatedAt: '', consumesBalance: true, pausesAccrual: false, capacityUnavailable: true, chargedDays: [], negativeApproved: false },
      { membershipId: 'm1', typeId: 't1', startDate: '2026-03-02', endDate: '2026-03-15', status: 'approved' },
      context
    )).toBe(false);
  });

  it('correction requires nonempty reason', () => {
    expect(isLeaveHistoricalAbsenceCorrection(
      { id: 'r1', workspaceId: 'w1', membershipId: 'm1', typeId: 't1', revision: 1, startDate: '2026-03-01', endDate: '2026-03-10', status: 'approved', note: '', createdBy: 'm1', createdAt: '', updatedAt: '', consumesBalance: true, pausesAccrual: false, capacityUnavailable: true, chargedDays: [], negativeApproved: false },
      { membershipId: 'm1', typeId: 't1', startDate: '2026-03-02', endDate: '2026-03-12', status: 'approved' },
      { canManage: true, today, reason: '' }
    )).toBe(false);
  });

  it('creation and correction are mutually exclusive paths', () => {
    // For a NEW record: use isLeaveHistoricalAbsenceCreation
    const isCreation = isLeaveHistoricalAbsenceCreation(
      { endDate: '2026-03-10' },
      { canManage: true, today }
    );
    expect(isCreation).toBe(true);

    // For an UPDATE: use isLeaveHistoricalAbsenceCorrection (which requires before)
    const isCorrection = isLeaveHistoricalAbsenceCorrection(
      undefined, // no before means it's a creation
      { membershipId: 'm1', typeId: 't1', startDate: '2026-03-01', endDate: '2026-03-10', status: 'approved' },
      { canManage: true, today, reason: 'test' }
    );
    expect(isCorrection).toBe(false);
  });
});


describe('historical first admission',()=>{
 const id=(n:number)=>`88000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const before=leaveRequestSchema.parse({id:id(1),workspaceId:id(2),membershipId:id(3),typeId:id(4),revision:1,startDate:'2026-02-01',endDate:'2026-02-10',status:'pending',note:'',createdBy:id(3),createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',consumesBalance:true,pausesAccrual:false,capacityUnavailable:true,chargedDays:[],negativeApproved:false});
 const proposed={...before,status:'approved' as const},context={canManage:true,today:'2026-03-15',reason:'Record actual absence'};
 it('requires approved fully-past manager admission with a reason',()=>{expect(isLeaveHistoricalAbsenceRecording(undefined,proposed,context)).toBe(true);for(const reason of ['','   '])expect(isLeaveHistoricalAbsenceRecording(undefined,proposed,{...context,reason})).toBe(false);expect(isLeaveHistoricalAbsenceRecording(undefined,proposed,{...context,canManage:false})).toBe(false);expect(isLeaveHistoricalAbsenceRecording(undefined,{...proposed,status:'pending'},context)).toBe(false);expect(isLeaveHistoricalAbsenceRecording(undefined,{...proposed,endDate:context.today},context)).toBe(false);});
 it('permits only an unchanged fully-past pending request as first existing admission',()=>{expect(isLeaveHistoricalAbsenceRecording(before,proposed,context)).toBe(true);expect(isLeaveHistoricalAbsenceRecording({...before,status:'approved'},proposed,context)).toBe(false);expect(isLeaveHistoricalAbsenceRecording(before,{...proposed,membershipId:id(8)},context)).toBe(false);expect(isLeaveHistoricalAbsenceRecording(before,{...proposed,typeId:id(8)},context)).toBe(false);expect(isLeaveHistoricalAbsenceRecording(before,{...proposed,endDate:'2026-02-11'},context)).toBe(false);expect(isLeaveHistoricalAbsenceRecording({...before,endDate:context.today},proposed,context)).toBe(false);});
});
