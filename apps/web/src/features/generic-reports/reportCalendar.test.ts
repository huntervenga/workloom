import { describe, expect, it } from 'vitest';
import { reportCalendarRange } from './reportCalendar';
import { reportPeriodConfig, reportScopeCapacityConfig } from './ReportQuickFilters';
import { definition } from './test/fixtures';

const mondayUtc = { timezone: 'UTC', weekStart: 1 }, mondayPacific = { timezone: 'America/Los_Angeles', weekStart: 1 };

describe('workspace calendar report presets', () => {
  it('uses the workspace Sunday/Monday boundary instead of the browser clock date', () => {
    const clock = new Date('2026-10-19T00:30:00.000Z');
    expect(reportCalendarRange('week', mondayUtc, clock)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(reportCalendarRange('week', mondayPacific, clock)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
  });
  it('uses the workspace month when the same instant crosses a UTC month boundary', () => {
    const clock = new Date('2026-11-01T00:30:00.000Z');
    expect(reportCalendarRange('month', mondayUtc, clock)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(reportCalendarRange('month', mondayPacific, clock)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });
  it('honors persisted Sunday and Wednesday week starts using seven inclusive plain dates', () => {
    const clock = new Date('2026-10-19T12:00:00.000Z');
    expect(reportCalendarRange('week', { timezone: 'UTC', weekStart: 7 }, clock)).toEqual({ from: '2026-10-18', to: '2026-10-24' });
    expect(reportCalendarRange('week', { timezone: 'UTC', weekStart: 3 }, clock)).toEqual({ from: '2026-10-14', to: '2026-10-20' });
  });
  it('preserves calendar-day boundaries across the Nicosia daylight saving transition', () => {
    const clock = new Date('2026-10-24T22:30:00.000Z');
    expect(reportCalendarRange('week', { timezone: 'Asia/Nicosia', weekStart: 7 }, clock)).toEqual({ from: '2026-10-25', to: '2026-10-31' });
  });
  it('applies the same workspace interval to task dates and capacity, including the choose-period action', () => {
    const config = definition().config, clock = new Date('2026-10-19T00:30:00.000Z');
    const next = reportPeriodConfig(config, 'week', mondayPacific, clock);
    expect(next.filters.dateRange).toEqual({ source: { kind: 'due_date' }, from: '2026-10-12', to: '2026-10-18' });
    expect(next.capacity).toEqual({ startDate: '2026-10-12', endDate: '2026-10-18', people: { kind: 'all_active' } });
    expect(reportScopeCapacityConfig(config, mondayPacific, clock)).toEqual(next);
    expect(config.filters.dateRange).toBeNull(); expect(config.capacity).toBeUndefined();
  });
  it('aligns an explicit task interval unchanged instead of reinterpreting plain dates in another timezone', () => {
    const base = definition().config, config = { ...base, filters: { ...base.filters, dateRange: { source: { kind: 'due_date' as const }, from: '2026-10-01', to: '2026-10-31' } } };
    expect(reportScopeCapacityConfig(config, mondayPacific, new Date('2026-11-01T00:30:00.000Z')).capacity).toEqual({ startDate: '2026-10-01', endDate: '2026-10-31', people: { kind: 'all_active' } });
  });
});
