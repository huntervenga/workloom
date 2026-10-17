import { Temporal } from 'temporal-polyfill';

const FIRST = Temporal.PlainDate.from('0001-01-01');
export const MIN_DAY = '0001-01-01';
export const MAX_DAY = '9999-12-31';
const LAST_INDEX = Temporal.PlainDate.from(MAX_DAY).since(FIRST, { largestUnit: 'days' }).days;

/** Gregorian calendar days, never timezone instants or midnight milliseconds. */
export function dayIndex(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < MIN_DAY || value > MAX_DAY) return null;
  try { return Temporal.PlainDate.from(value).since(FIRST, { largestUnit: 'days' }).days; }
  catch { return null; }
}
export function shiftDay(value: string, amount: number): string | null {
  const index = dayIndex(value);
  if (index === null || !Number.isInteger(amount) || index + amount < 0 || index + amount > LAST_INDEX) return null;
  return FIRST.add({ days: index + amount }).toString();
}
export function todayIn(timezone: string): string { return Temporal.Now.plainDateISO(timezone).toString(); }
export interface CalendarWindow { start: string; end: string; startIndex: number; endIndex: number; days: number }
export function calendarWindow(start: string, requestedDays: number): CalendarWindow | null {
  const startIndex = dayIndex(start);
  if (startIndex === null || !Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 366) return null;
  const days = Math.min(requestedDays, LAST_INDEX - startIndex + 1);
  return { start, end: FIRST.add({ days: startIndex + days - 1 }).toString(), startIndex, endIndex: startIndex + days - 1, days };
}
export function windowDays(window: CalendarWindow): string[] {
  return Array.from({ length: window.days }, (_, index) => FIRST.add({ days: window.startIndex + index }).toString());
}
/** Weekday is ISO (Monday 1 … Sunday 7) from the calendar date alone; Saturday/Sunday are shaded as weekend. */
export interface AxisDay { date: string; day: number; weekday: number; weekend: boolean; offset: number }
export interface AxisMonth { month: string; first: string; offset: number; days: number }
/** At most 366 cells; month segments are the runs of equal YYYY-MM inside the explicit window. */
export function calendarAxis(window: CalendarWindow): { days: AxisDay[]; months: AxisMonth[] } {
  const days = windowDays(window).map((date, offset) => {
    const weekday = Temporal.PlainDate.from(date).dayOfWeek;
    return { date, day: Number(date.slice(8)), weekday, weekend: weekday >= 6, offset };
  });
  const months: AxisMonth[] = [];
  for (const day of days) {
    const last = months.at(-1);
    if (last?.month === day.date.slice(0, 7)) last.days++;
    else months.push({ month: day.date.slice(0, 7), first: day.date, offset: day.offset, days: 1 });
  }
  return { days, months };
}
/** Offset of one calendar day inside the window, or null when the day is outside it. */
export function windowOffset(value: string, window: CalendarWindow): number | null {
  const index = dayIndex(value);
  return index === null || index < window.startIndex || index > window.endIndex ? null : index - window.startIndex;
}
export const FIT_WINDOW_SIZES = [28, 84, 366] as const;
export interface DatedRange { start: string | null; due: string | null }
export type LoadedFit =
  | { kind: 'none' }
  | { kind: 'fit' | 'wide'; start: string; days: number; earliest: string; latest: string; span: number; count: number };
function validIndexes({ start, due }: DatedRange): [number, number] | null {
  const a = start === null ? null : dayIndex(start), b = due === null ? null : dayIndex(due);
  if (start !== null && a === null || due !== null && b === null || a !== null && b !== null && a > b) return null;
  const first = a ?? b, last = b ?? a;
  return first === null || last === null ? null : [first, last];
}
/**
 * Explicit "fit" for loaded current dates only: the smallest 28/84/366-day window that covers them,
 * with a short lead-in and both calendar bounds respected. Wider spans start at the earliest date and
 * say so; nothing here reads unloaded tasks, baselines or proposes new dates.
 */
export function fitLoadedWindow(ranges: readonly DatedRange[]): LoadedFit {
  let min = Infinity, max = -Infinity, count = 0;
  for (const range of ranges) {
    const indexes = validIndexes(range);
    if (!indexes) continue;
    count++; min = Math.min(min, indexes[0]); max = Math.max(max, indexes[1]);
  }
  if (!count) return { kind: 'none' };
  const span = max - min + 1;
  const earliest = FIRST.add({ days: min }).toString(), latest = FIRST.add({ days: max }).toString();
  const days = FIT_WINDOW_SIZES.find(size => size >= span);
  if (days === undefined) return { kind: 'wide', start: earliest, days: 366, earliest, latest, span, count };
  const lead = Math.min(Math.floor((days - span) / 2), Math.ceil(days / 28));
  let start = Math.max(0, min - lead);
  if (start + days - 1 > LAST_INDEX) start = Math.max(0, LAST_INDEX - days + 1);
  return { kind: 'fit', start: FIRST.add({ days: start }).toString(), days, earliest, latest, span, count };
}
/** How many valid loaded ranges touch, precede or follow the window; invalid ranges are not counted. */
export function windowCoverage(ranges: readonly DatedRange[], window: CalendarWindow): { dated: number; inside: number; before: number; after: number } {
  const result = { dated: 0, inside: 0, before: 0, after: 0 };
  for (const range of ranges) {
    const indexes = validIndexes(range);
    if (!indexes) continue;
    result.dated++;
    if (indexes[1] < window.startIndex) result.before++;
    else if (indexes[0] > window.endIndex) result.after++;
    else result.inside++;
  }
  return result;
}
export type ClippedDates =
  | { kind: 'none' | 'invalid' }
  | { kind: 'outside'; endpoint: string }
  | { kind: 'point'; left: number; endpoint: 'start' | 'due' }
  | { kind: 'range'; left: number; width: number; continuesBefore: boolean; continuesAfter: boolean };
/** Intersect before geometry; even a 9999-year range occupies at most the explicit window. */
export function clipDates(start: string | null, due: string | null, window: CalendarWindow): ClippedDates {
  if (start === null && due === null) return { kind: 'none' };
  const a = start === null ? null : dayIndex(start);
  const b = due === null ? null : dayIndex(due);
  if (start !== null && a === null || due !== null && b === null || a !== null && b !== null && a > b) return { kind: 'invalid' };
  if (a === null || b === null) {
    const index = a ?? b;
    const endpoint = start ?? due;
    if (index === null || endpoint === null) return { kind: 'invalid' };
    if (index < window.startIndex || index > window.endIndex) return { kind: 'outside', endpoint };
    return { kind: 'point', left: (index - window.startIndex + 0.5) / window.days * 100, endpoint: a === null ? 'due' : 'start' };
  }
  if (b < window.startIndex || a > window.endIndex) return { kind: 'outside', endpoint: b < window.startIndex ? due ?? start ?? MIN_DAY : start ?? due ?? MIN_DAY };
  const first = Math.max(a, window.startIndex), last = Math.min(b, window.endIndex);
  return { kind: 'range', left: (first - window.startIndex) / window.days * 100, width: (last - first + 1) / window.days * 100, continuesBefore: a < window.startIndex, continuesAfter: b > window.endIndex };
}
