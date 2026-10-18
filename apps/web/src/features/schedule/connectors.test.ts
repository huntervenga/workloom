import type { ScheduleDependencyComparisonDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { context, taskAt } from '../dependencies/test/fixtures';
import { arrowHead, connectorPath, planConnectors, POINT_RADIUS, skippedCounts, type ConnectorRow } from './connectors';
import { calendarWindow } from './dates';

const A = taskAt(1), B = taskAt(2), C = taskAt(3), D = taskAt(4);
function comparison(predecessor: string | null, successor: string | null, state: 'compatible' | 'conflict' = 'compatible', index = 1, from = A, to = B): ScheduleDependencyComparisonDto {
  return { dependencyId: `d1000000-0000-4000-8000-${String(index).padStart(12, '0')}`, predecessorTaskId: from.id, successorTaskId: to.id, predecessorDueDate: predecessor, successorStartDate: successor, predecessorContext: context(from), successorContext: context(to), state };
}
const unknown = (reason: 'meeting_calendar' | 'missing_date'): ScheduleDependencyComparisonDto => ({ ...comparison(null, null), state: 'unknown', reason });
function windowOf(start: string, days: number) { const value = calendarWindow(start, days); if (!value) throw new Error('Expected window'); return value; }
const rows = (entries: [string, ConnectorRow][]) => new Map(entries);
const w28 = windowOf('2026-03-01', 28);

describe('finish-to-start connector plan', () => {
  it('anchors range bars at the end of the inclusive due day and the start of the successor day', () => {
    const plan = planConnectors([comparison('2026-03-05', '2026-03-09')], rows([[A.id, { start: '2026-03-02', due: '2026-03-05', meeting: false }], [B.id, { start: '2026-03-09', due: '2026-03-12', meeting: false }]]), w28, 36);
    expect(plan.skipped).toEqual([]);
    expect(plan.drawn).toEqual([{ dependencyId: comparison(null, null).dependencyId, state: 'compatible', from: { taskId: A.id, x: 5 * 36, kind: 'edge' }, to: { taskId: B.id, x: 8 * 36, kind: 'edge' } }]);
  });
  it('attaches to the side of single-date diamonds and keeps the authoritative conflict state', () => {
    const plan = planConnectors([comparison('2026-03-10', '2026-03-10', 'conflict')], rows([[A.id, { start: null, due: '2026-03-10', meeting: false }], [B.id, { start: '2026-03-10', due: null, meeting: false }]]), w28, 36);
    expect(plan.drawn[0]).toMatchObject({ state: 'conflict', from: { x: 9.5 * 36 + POINT_RADIUS, kind: 'point' }, to: { x: 9.5 * 36 - POINT_RADIUS, kind: 'point' } });
  });
  it.each([12, 20, 36])('uses the rotated diamond bounds at %ipx per day, including calendar-window edges', dayWidth => {
    const loaded = rows([[A.id, { start: null, due: '2026-03-28', meeting: false }], [B.id, { start: '2026-03-01', due: null, meeting: false }]]);
    const plan = planConnectors([comparison('2026-03-28', '2026-03-01', 'conflict')], loaded, w28, dayWidth);
    // A 16px square rotated 45° spans 16√2px horizontally. Its sides may extend beyond
    // the track on narrow days; clamping the arrow to the date cell would put it inside the diamond.
    const rotatedHalfWidth = 16 * Math.SQRT1_2;
    expect(plan.drawn[0]?.from.x).toBeCloseTo(27.5 * dayWidth + rotatedHalfWidth, 10);
    expect(plan.drawn[0]?.to.x).toBeCloseTo(0.5 * dayWidth - rotatedHalfWidth, 10);
    expect(plan.skipped).toEqual([]);
  });
  it('turns undecided, meeting, unloaded, stale and missing endpoints into counted reasons without coordinates', () => {
    const loaded = rows([[A.id, { start: '2026-03-02', due: '2026-03-05', meeting: false }], [B.id, { start: '2026-03-09', due: '2026-03-12', meeting: false }], [C.id, { start: '2026-03-09', due: '2026-03-09', meeting: true }], [D.id, { start: null, due: null, meeting: false }]]);
    const plan = planConnectors([
      unknown('meeting_calendar'),
      { ...comparison('2026-03-05', null, 'compatible', 2, A, D), state: 'unknown', reason: 'missing_date' },
      comparison('2026-03-05', '2026-03-09', 'compatible', 3, A, C),
      comparison('2026-03-05', '2026-03-09', 'compatible', 4, A, taskAt(9)),
      comparison('2026-03-06', '2026-03-09', 'conflict', 5),
      comparison('2026-03-05', null, 'compatible', 6),
    ], loaded, w28, 36);
    expect(plan.drawn).toEqual([]);
    expect(plan.skipped.map(item => item.reason)).toEqual(['meeting', 'missing_date', 'meeting', 'not_loaded', 'not_current', 'missing_date']);
    expect(skippedCounts(plan)).toEqual({ meeting: 2, missing_date: 2, not_loaded: 1, outside_window: 0, not_current: 1 });
  });
  it('treats a comparison date that the loaded row no longer shows as not current', () => {
    const plan = planConnectors([comparison('2026-03-05', '2026-03-09')], rows([[A.id, { start: '2026-03-02', due: null, meeting: false }], [B.id, { start: '2026-03-09', due: null, meeting: false }]]), w28, 36);
    expect(plan.skipped).toEqual([{ dependencyId: comparison(null, null).dependencyId, reason: 'not_current' }]);
  });
  it('skips links whose compared endpoint is outside the window, even when the bars cross it', () => {
    const loaded = rows([[A.id, { start: '2026-01-01', due: '2026-02-27', meeting: false }], [B.id, { start: '2026-03-05', due: '2026-12-31', meeting: false }]]);
    expect(planConnectors([comparison('2026-02-27', '2026-03-05')], loaded, w28, 36).skipped[0]?.reason).toBe('outside_window');
    const after = rows([[A.id, { start: '2026-03-01', due: '2026-03-10', meeting: false }], [B.id, { start: '2026-03-29', due: '2026-04-02', meeting: false }]]);
    expect(planConnectors([comparison('2026-03-10', '2026-03-29')], after, w28, 36).skipped[0]?.reason).toBe('outside_window');
  });
  it('keeps calendar extremes inside the bounded track for 28 and 366-day windows', () => {
    const end = windowOf('9999-12-04', 28);
    const late = planConnectors([comparison('9999-12-31', '9999-12-31', 'conflict')], rows([[A.id, { start: '0001-01-01', due: '9999-12-31', meeting: false }], [B.id, { start: '9999-12-31', due: '9999-12-31', meeting: false }]]), end, 36);
    expect(late.drawn[0]).toMatchObject({ from: { x: 28 * 36 }, to: { x: 27 * 36 } });
    const year = windowOf('0001-01-01', 366);
    const early = planConnectors([comparison('0001-01-01', '0001-12-31')], rows([[A.id, { start: '0001-01-01', due: '0001-01-01', meeting: false }], [B.id, { start: '0001-12-31', due: '9999-12-31', meeting: false }]]), year, 12);
    expect(early.drawn[0]).toMatchObject({ from: { x: 12 }, to: { x: 364 * 12 } });
    for (const item of [...late.drawn, ...early.drawn]) for (const end of [item.from, item.to]) expect(end.x).toBeGreaterThanOrEqual(0);
    expect(early.drawn[0]?.to.x).toBeLessThanOrEqual(366 * 12);
  });
  it('rejects malformed dates instead of computing a position', () => {
    const plan = planConnectors([comparison('2026-02-30', '2026-03-09')], rows([[A.id, { start: null, due: '2026-02-30', meeting: false }], [B.id, { start: '2026-03-09', due: null, meeting: false }]]), w28, 36);
    expect(plan.skipped[0]?.reason).toBe('missing_date');
  });
});

describe('connector path', () => {
  it('routes forward links straight down into the successor and overlapping links through the row gap', () => {
    expect(connectorPath(100, 20, 200, 70)).toBe('M100,20H106V70H200');
    expect(connectorPath(200, 20, 100, 70)).toBe('M200,20H206V45H94V70H100');
    expect(connectorPath(100, 70, 200, 20)).toBe('M100,70H106V20H200');
    expect(arrowHead(200, 70)).toBe('M200,70L195,66.5L195,73.5Z');
  });
});
