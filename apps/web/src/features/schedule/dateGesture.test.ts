import { describe, expect, it } from 'vitest';
import { dateMoveAtPixels, dateMoveSource, moveDateRange, snappedDayDelta, type DateMoveSource } from './dateGesture';
import { scheduleContext, scheduledTask, PROJECT_ID, STAMP } from './test/fixtures';

const source = (startDate: string | null, dueDate: string | null): DateMoveSource =>
  ({ taskId: 'task', title: 'Task', expectedRevision: 3, startDate, dueDate });

describe('calendar-only date moves', () => {
  it('snaps half-day ties symmetrically at each existing zoom width', () => {
    for (const width of [36, 20, 12]) {
      expect(snappedDayDelta(width / 2, width)).toBe(1);
      expect(snappedDayDelta(-width / 2, width)).toBe(-1);
      expect(snappedDayDelta(width / 2 - 0.01, width)).toBe(0);
      expect(snappedDayDelta(-width / 2 + 0.01, width)).toBe(0);
      expect(snappedDayDelta(width * 1.5, width)).toBe(2);
      expect(snappedDayDelta(-width * 1.5, width)).toBe(-2);
    }
    expect(snappedDayDelta(Infinity, 12)).toBeNull();
    expect(snappedDayDelta(24, 0)).toBeNull();
    expect(snappedDayDelta(24, NaN)).toBeNull();
  });

  it('moves inclusive ranges from the immutable original rather than cumulative frames', () => {
    const original = Object.freeze(source('2026-10-24', '2026-10-26'));
    expect(dateMoveAtPixels(original, 72, 36)).toMatchObject({ startDate: '2026-10-26', dueDate: '2026-10-28', dayDelta: 2 });
    expect(dateMoveAtPixels(original, -36, 36)).toMatchObject({ startDate: '2026-10-23', dueDate: '2026-10-25', dayDelta: -1 });
    expect(original).toMatchObject({ startDate: '2026-10-24', dueDate: '2026-10-26' });
    expect(moveDateRange(source('2026-10-25', '2026-10-25'), 1)).toMatchObject({ startDate: '2026-10-26', dueDate: '2026-10-26' });
  });

  it('preserves the absent endpoint and never derives dates from effort or timestamps', () => {
    expect(moveDateRange(source(null, '2026-03-29'), 1)).toMatchObject({ startDate: null, dueDate: '2026-03-30' });
    expect(moveDateRange(source('2026-03-29', null), -1)).toMatchObject({ startDate: '2026-03-28', dueDate: null });
  });

  it('handles leap, DST, early years and both calendar bounds without changing duration', () => {
    expect(moveDateRange(source('2000-02-28', '2000-02-29'), 1)).toMatchObject({ startDate: '2000-02-29', dueDate: '2000-03-01' });
    expect(moveDateRange(source('1900-02-28', null), 1)).toMatchObject({ startDate: '1900-03-01' });
    expect(moveDateRange(source('0099-12-31', null), 1)).toMatchObject({ startDate: '0100-01-01' });
    expect(moveDateRange(source('0001-01-02', '0001-01-04'), -99)).toMatchObject({ startDate: '0001-01-01', dueDate: '0001-01-03', dayDelta: -1, limited: true });
    expect(moveDateRange(source('9999-12-28', '9999-12-30'), 99)).toMatchObject({ startDate: '9999-12-29', dueDate: '9999-12-31', dayDelta: 1, limited: true });
    expect(moveDateRange(source('0001-01-01', '9999-12-31'), 1)).toMatchObject({ dayDelta: 0, limited: true });
    expect(moveDateRange(source(null, '9999-12-31'), 1)).toMatchObject({ startDate: null, dueDate: '9999-12-31', dayDelta: 0, limited: true });
  });

  it('rejects invalid ranges and noninteger deltas', () => {
    for (const dates of [[null, null], ['2026-02-30', null], ['0000-01-01', null], ['2026-10-26', '2026-10-25']] as const)
      expect(moveDateRange(source(dates[0], dates[1]), 1)).toBeNull();
    expect(moveDateRange(source('2026-10-25', null), 0.5)).toBeNull();
    expect(moveDateRange(source('2026-10-25', null), Number.MAX_VALUE)).toBeNull();
  });
});

describe('authorized move source', () => {
  it('copies dates and revision from the authorized schedule context', () => {
    const task = scheduledTask(1, '2026-10-25', '2026-10-26');
    const row = scheduleContext([task]).rows[0];
    const value = dateMoveSource(task, { ...row, taskRevision: 8 }, { projectId: PROJECT_ID, writable: true, ready: true });
    expect(value).toEqual({ taskId: task.id, title: task.title, expectedRevision: 8, startDate: '2026-10-25', dueDate: '2026-10-26' });
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('rejects missing, denied/read-only, meeting, archived, baseline, undated and held sources', () => {
    const task = scheduledTask(1, '2026-10-25', '2026-10-26');
    const row = scheduleContext([task]).rows[0];
    const options = { projectId: PROJECT_ID, writable: true, ready: true };
    expect(dateMoveSource(undefined, row, options)).toBeNull();
    expect(dateMoveSource(task, undefined, options)).toBeNull();
    expect(dateMoveSource(task, row, { ...options, writable: false })).toBeNull();
    expect(dateMoveSource(task, row, { ...options, ready: false })).toBeNull();
    expect(dateMoveSource(task, row, { ...options, baseline: true })).toBeNull();
    expect(dateMoveSource(task, row, { ...options, blocked: true })).toBeNull();
    expect(dateMoveSource(task, row, { ...options, projectId: 'other' })).toBeNull();
    expect(dateMoveSource(task, { ...row, taskId: 'other' }, options)).toBeNull();
    expect(dateMoveSource({ ...task, meetingId: task.id }, row, options)).toBeNull();
    expect(dateMoveSource(task, { ...row, meetingId: task.id }, options)).toBeNull();
    expect(dateMoveSource({ ...task, archivedAt: STAMP }, row, options)).toBeNull();
    expect(dateMoveSource(task, { ...row, editableDates: false }, options)).toBeNull();
    expect(dateMoveSource(task, { ...row, current: { startDate: null, dueDate: null } }, options)).toBeNull();
  });
});
