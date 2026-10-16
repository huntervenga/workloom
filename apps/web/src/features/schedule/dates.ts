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
