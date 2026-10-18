import type { ScheduleDependencyComparisonDto } from '@workloom/contracts';
import { dayIndex, type CalendarWindow } from './dates';
import { POINT_RADIUS } from './barGeometry';
export { POINT_RADIUS } from './barGeometry';

/** A loaded, rendered timeline row and the current dates its bar was drawn from. */
export interface ConnectorRow { start: string | null; due: string | null; meeting: boolean }
export type ConnectorSkipReason = 'meeting' | 'missing_date' | 'not_loaded' | 'outside_window' | 'not_current';
export interface ConnectorEnd { taskId: string; x: number; kind: 'edge' | 'point' }
/** `neutral`: the server could not decide finish-to-start (a date is missing); the arrow only links the visible points. */
export interface PlannedConnector { dependencyId: string; state: 'compatible' | 'conflict' | 'neutral'; from: ConnectorEnd; to: ConnectorEnd }
export interface ConnectorPlan { drawn: PlannedConnector[]; skipped: { dependencyId: string; reason: ConnectorSkipReason }[] }
const STUB = 6;

function endpointReason(row: ConnectorRow | undefined, date: string | null, expected: string | null): ConnectorSkipReason | null {
  if (!row) return 'not_loaded';
  if (row.meeting) return 'meeting';
  if (expected === null) return 'missing_date';
  // The bar and the comparison came from different reads; never attach an arrow to the other date.
  if (date !== expected) return 'not_current';
  return dayIndex(date) === null ? 'missing_date' : null;
}
/**
 * Finish-to-start arrows only where the server comparison is decided and both endpoints are loaded
 * ordinary rows whose current bar shows exactly the compared date inside the window. Everything else
 * is a counted, reasoned skip: no coordinate is invented and nothing is derived from the arrows.
 */
export function planConnectors(comparisons: readonly ScheduleDependencyComparisonDto[], rows: ReadonlyMap<string, ConnectorRow>, window: CalendarWindow, dayWidth: number): ConnectorPlan {
  const plan: ConnectorPlan = { drawn: [], skipped: [] };
  for (const item of comparisons) {
    const skip = (reason: ConnectorSkipReason) => { plan.skipped.push({ dependencyId: item.dependencyId, reason }); };
    if (item.state === 'unknown') {
      if (item.reason === 'meeting_calendar') { skip('meeting'); continue; }
      const neutral = planNeutral(item, rows, window, dayWidth);
      if ('reason' in neutral) skip(neutral.reason); else plan.drawn.push(neutral);
      continue;
    }
    const predecessor = rows.get(item.predecessorTaskId), successor = rows.get(item.successorTaskId);
    const reason = endpointReason(predecessor, predecessor?.due ?? null, item.predecessorDueDate) ?? endpointReason(successor, successor?.start ?? null, item.successorStartDate);
    if (reason || !predecessor || !successor) { skip(reason ?? 'not_loaded'); continue; }
    const due = dayIndex(item.predecessorDueDate ?? ''), start = dayIndex(item.successorStartDate ?? '');
    if (due === null || start === null) { skip('missing_date'); continue; }
    if (due < window.startIndex || due > window.endIndex || start < window.startIndex || start > window.endIndex) { skip('outside_window'); continue; }
    const dueOffset = due - window.startIndex, startOffset = start - window.startIndex;
    // A start+due row is a bar whose right edge is the end of its inclusive due day; a lone date is a diamond.
    const from: ConnectorEnd = predecessor.start !== null ? { taskId: item.predecessorTaskId, x: (dueOffset + 1) * dayWidth, kind: 'edge' } : { taskId: item.predecessorTaskId, x: (dueOffset + 0.5) * dayWidth + POINT_RADIUS, kind: 'point' };
    const to: ConnectorEnd = successor.due !== null ? { taskId: item.successorTaskId, x: startOffset * dayWidth, kind: 'edge' } : { taskId: item.successorTaskId, x: (startOffset + 0.5) * dayWidth - POINT_RADIUS, kind: 'point' };
    plan.drawn.push({ dependencyId: item.dependencyId, state: item.state, from, to });
  }
  return plan;
}
/**
 * An undecided (missing-date) comparison still links what is actually drawn: the predecessor's due date, or its
 * start when it has no due date, to the successor's start date, or its due when it has no start. The compared
 * dates must equal the bar's own (both null included), so a stale read never attaches to another date; no date
 * is invented and the comparison itself stays unknown.
 */
function planNeutral(item: ScheduleDependencyComparisonDto, rows: ReadonlyMap<string, ConnectorRow>, window: CalendarWindow, dayWidth: number): PlannedConnector | { reason: ConnectorSkipReason } {
  const predecessor = rows.get(item.predecessorTaskId), successor = rows.get(item.successorTaskId);
  if (!predecessor || !successor) return { reason: 'not_loaded' };
  if (predecessor.meeting || successor.meeting) return { reason: 'meeting' };
  if (predecessor.due !== item.predecessorDueDate || successor.start !== item.successorStartDate) return { reason: 'not_current' };
  const fromDate = predecessor.due ?? predecessor.start, toDate = successor.start ?? successor.due;
  const fromDay = fromDate === null ? null : dayIndex(fromDate), toDay = toDate === null ? null : dayIndex(toDate);
  if (fromDay === null || toDay === null) return { reason: 'missing_date' };
  if (fromDay < window.startIndex || fromDay > window.endIndex || toDay < window.startIndex || toDay > window.endIndex) return { reason: 'outside_window' };
  const fromOffset = fromDay - window.startIndex, toOffset = toDay - window.startIndex;
  const from: ConnectorEnd = predecessor.start !== null && predecessor.due !== null ? { taskId: item.predecessorTaskId, x: (fromOffset + 1) * dayWidth, kind: 'edge' } : { taskId: item.predecessorTaskId, x: (fromOffset + 0.5) * dayWidth + POINT_RADIUS, kind: 'point' };
  const to: ConnectorEnd = successor.start !== null && successor.due !== null ? { taskId: item.successorTaskId, x: toOffset * dayWidth, kind: 'edge' } : { taskId: item.successorTaskId, x: (toOffset + 0.5) * dayWidth - POINT_RADIUS, kind: 'point' };
  return { dependencyId: item.dependencyId, state: 'neutral', from, to };
}
export function skippedCounts(plan: ConnectorPlan): Record<ConnectorSkipReason, number> {
  const counts: Record<ConnectorSkipReason, number> = { meeting: 0, missing_date: 0, not_loaded: 0, outside_window: 0, not_current: 0 };
  for (const item of plan.skipped) counts[item.reason]++;
  return counts;
}
const round = (value: number) => Math.round(value * 10) / 10;
/**
 * Orthogonal finish-to-start route in host pixels. Forward links leave the predecessor, drop to the
 * successor row and enter from the left; overlapping links detour through the gap between the rows.
 */
export function connectorPath(fromX: number, fromY: number, toX: number, toY: number): string {
  const out = round(fromX + STUB), into = round(toX - STUB);
  if (into >= out) return `M${round(fromX)},${round(fromY)}H${out}V${round(toY)}H${round(toX)}`;
  const middle = round((fromY + toY) / 2);
  return `M${round(fromX)},${round(fromY)}H${out}V${middle}H${into}V${round(toY)}H${round(toX)}`;
}
export function arrowHead(toX: number, toY: number): string {
  return `M${round(toX)},${round(toY)}L${round(toX - 5)},${round(toY - 3.5)}L${round(toX - 5)},${round(toY + 3.5)}Z`;
}
