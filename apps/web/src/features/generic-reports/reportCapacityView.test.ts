import { describe, expect, it } from 'vitest';
import { definition } from './test/fixtures';
import { reportCapacityView, validCapacityRange } from './reportCapacityView';
const dates = { from: '2026-10-19', to: '2026-10-25' };
const member = '90000000-0000-4000-8000-000000000099';
describe('read-only report capacity source', () => {
 it('uses existing project dates without filtering or changing saved All-time task totals', () => {
  const original = definition().config, before = structuredClone(original), view = reportCapacityView(original, dates, null);
  expect(view).toMatchObject({ source: 'project_dates', range: dates, derived: true, reason: null });
  expect(view.config.capacity).toEqual({ startDate: dates.from, endDate: dates.to, people: { kind: 'all_active' } });
  expect(view.config.filters).toEqual(original.filters); expect(view.config.filters.dateRange).toBeNull(); expect(view.config.measures).toEqual(original.measures); expect(original).toEqual(before); expect(original.capacity).toBeUndefined();
 });
 it('keeps saved explicit capacity, including its own dates and people, as the default', () => {
  const base = { ...definition().config, capacity: { startDate: '2026-09-01', endDate: '2026-09-02', people: { kind: 'selected' as const, membershipIds: [member] } } };
  const view = reportCapacityView(base, dates, null); expect(view.config).toBe(base); expect(view.source).toBe('saved'); expect(view.derived).toBe(false); expect(view.range).toEqual({ from: base.capacity.startDate, to: base.capacity.endDate });
 });
 it('does not invent a current week or any period if project and saved periods are absent', () => {
  const base = definition().config, view = reportCapacityView(base, null, null);
  expect(view.config).toBe(base); expect(view.config.capacity).toBeUndefined(); expect(view).toMatchObject({ source: 'none', range: null, reason: 'no_period', derived: false });
 });
 it('can explicitly turn inherited capacity off without changing the saved definition', () => {
  const base = definition().config, view = reportCapacityView(base, dates, { kind: 'none' });
  expect(view.config).toBe(base); expect(view.reason).toBeNull(); expect(view.range).toBeNull();
 });
 it('can turn saved capacity off as a transient read without mutating its stored input', () => {
  const capacity = { startDate: dates.from, endDate: dates.to, people: { kind: 'all_active' as const } }, base = { ...definition().config, capacity };
  const view = reportCapacityView(base, dates, { kind: 'none' }); expect(view.derived).toBe(true); expect(view.config.capacity).toBeUndefined(); expect(base.capacity).toBe(capacity);
 });
 it('can explicitly use a custom range or task dates with the actual selected person', () => {
  const base = definition().config, selected = { ...base, filters: { ...base.filters, assignee: { kind: 'member' as const, membershipId: member }, dateRange: { source: { kind: 'due_date' as const }, from: '2026-08-01', to: '2026-08-07' } } };
  expect(reportCapacityView(selected, dates, { kind: 'task_dates' }).config.capacity).toEqual({ startDate: '2026-08-01', endDate: '2026-08-07', people: { kind: 'selected', membershipIds: [member] } });
  expect(reportCapacityView(selected, dates, { kind: 'custom', from: '2026-09-01', to: '2026-09-30' }).config.capacity).toEqual({ startDate: '2026-09-01', endDate: '2026-09-30', people: { kind: 'selected', membershipIds: [member] } });
  expect(selected.filters.dateRange.from).toBe('2026-08-01');
 });
 it('explains missing project/task dates, invalid ranges and unassigned tasks without sending bad capacity', () => {
  const base = definition().config;
  expect(reportCapacityView(base, null, { kind: 'project_dates' }).reason).toBe('project_dates_missing');
  expect(reportCapacityView(base, dates, { kind: 'task_dates' }).reason).toBe('task_dates_missing');
  for (const range of [{ from: '', to: '' }, { from: dates.to, to: dates.from }, { from: '2026-01-01', to: '2027-01-02' }]) { const view = reportCapacityView(base, range, null); expect(view.reason).toBe('invalid_range'); expect(view.config.capacity).toBeUndefined(); }
  const view = reportCapacityView({ ...base, filters: { ...base.filters, assignee: { kind: 'unassigned' } } }, dates, null); expect(view.reason).toBe('unassigned'); expect(view.config.capacity).toBeUndefined();
 });
 it('accepts inclusive leap-year and short custom periods and respects the 366-day bound', () => {
  expect(validCapacityRange({ from: '2024-01-01', to: '2024-12-31' })).toBe(true);
  expect(validCapacityRange({ from: '2024-01-01', to: '2025-01-01' })).toBe(false);
  expect(validCapacityRange({ from: dates.from, to: dates.from })).toBe(true);
 });
});
