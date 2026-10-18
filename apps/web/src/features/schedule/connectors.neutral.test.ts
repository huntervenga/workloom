import type { ScheduleDependencyComparisonDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { POINT_RADIUS, planConnectors, skippedCounts, type ConnectorRow } from './connectors';
import { calendarWindow } from './dates';

const A = 'a0000000-0000-4000-8000-000000000001', B = 'a0000000-0000-4000-8000-000000000002', C = 'a0000000-0000-4000-8000-000000000003';
const WIDTH = 36;
const window = calendarWindow('2026-10-01', 28);
if (!window) throw new Error('Expected window');
// planConnectors reads only the identity, state and compared dates; task contexts are irrelevant to geometry.
function comparison(dependencyId: string, predecessorTaskId: string, successorTaskId: string, predecessorDueDate: string | null, successorStartDate: string | null, state: 'unknown' | 'compatible' | 'conflict' = 'unknown', reason: 'missing_date' | 'meeting_calendar' = 'missing_date'): ScheduleDependencyComparisonDto {
  return { dependencyId, predecessorTaskId, successorTaskId, predecessorDueDate, successorStartDate, state, ...(state === 'unknown' ? { reason } : {}) } as unknown as ScheduleDependencyComparisonDto;
}
const row = (start: string | null, due: string | null, meeting = false): ConnectorRow => ({ start, due, meeting });
const D1 = 'd0000000-0000-4000-8000-000000000001', D2 = 'd0000000-0000-4000-8000-000000000002', D3 = 'd0000000-0000-4000-8000-000000000003';

describe('neutral connectors for undecided comparisons', () => {
  it('links a start-only predecessor diamond to a successor bar on the dates actually drawn', () => {
    const plan = planConnectors([comparison(D1, A, B, null, '2026-10-08')], new Map([[A, row('2026-10-03', null)], [B, row('2026-10-08', '2026-10-09')]]), window, WIDTH);
    expect(plan.skipped).toEqual([]);
    expect(plan.drawn).toEqual([{ dependencyId: D1, state: 'neutral', from: { taskId: A, x: 2.5 * WIDTH + POINT_RADIUS, kind: 'point' }, to: { taskId: B, x: 7 * WIDTH, kind: 'edge' } }]);
  });

  it('links due-only diamonds without inventing a successor start date', () => {
    const plan = planConnectors([comparison(D1, A, B, '2026-10-05', null)], new Map([[A, row(null, '2026-10-05')], [B, row(null, '2026-10-10')]]), window, WIDTH);
    expect(plan.drawn).toEqual([{ dependencyId: D1, state: 'neutral', from: { taskId: A, x: 4.5 * WIDTH + POINT_RADIUS, kind: 'point' }, to: { taskId: B, x: 9.5 * WIDTH - POINT_RADIUS, kind: 'point' } }]);
  });

  it('skips stale, undated, unloaded, meeting and outside-window endpoints with counted reasons', () => {
    const rows = new Map([[A, row('2026-10-03', '2026-10-04')], [B, row(null, null)], [C, row(null, '2026-10-06', true)]]);
    const plan = planConnectors([
      // A meeting endpoint is never linked, even when its date is visible.
      comparison(D1, A, C, '2026-10-04', null),
      comparison(D2, A, B, '2026-10-04', null),
      comparison(D3, A, 'a0000000-0000-4000-8000-000000000009', '2026-10-04', null),
      comparison('d0000000-0000-4000-8000-000000000004', C, A, '2026-10-06', '2026-10-03'),
      comparison('d0000000-0000-4000-8000-000000000005', A, B, '2026-10-04', null, 'unknown', 'meeting_calendar'),
    ], rows, window, WIDTH);
    expect(plan.drawn).toEqual([]);
    expect(plan.skipped.map(item => item.reason)).toEqual(['meeting', 'missing_date', 'not_loaded', 'meeting', 'meeting']);
    const stale = planConnectors([comparison(D1, A, B, null, null)], new Map([[A, row('2026-10-03', '2026-10-04')], [B, row(null, '2026-10-09')]]), window, WIDTH);
    expect(stale.skipped).toEqual([{ dependencyId: D1, reason: 'not_current' }]);
    const outside = planConnectors([comparison(D1, A, B, '2026-12-05', null)], new Map([[A, row(null, '2026-12-05')], [B, row(null, '2026-10-10')]]), window, WIDTH);
    expect(skippedCounts(outside).outside_window).toBe(1);
  });

  it('leaves decided comparisons and their states unchanged', () => {
    const rows = new Map([[A, row('2026-10-03', '2026-10-04')], [B, row('2026-10-06', '2026-10-07')]]);
    const plan = planConnectors([comparison(D1, A, B, '2026-10-04', '2026-10-06', 'compatible'), comparison(D2, A, B, '2026-10-04', '2026-10-06', 'conflict')], rows, window, WIDTH);
    expect(plan.drawn.map(item => [item.state, item.from.x, item.to.x])).toEqual([['compatible', 4 * WIDTH, 5 * WIDTH], ['conflict', 4 * WIDTH, 5 * WIDTH]]);
  });
});
