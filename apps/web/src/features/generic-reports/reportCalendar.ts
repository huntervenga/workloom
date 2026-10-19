import { Temporal } from 'temporal-polyfill';

/** Workspace calendar rules; Monday fallback is used only for older responses without weekStart. */
export interface ReportCalendarContext { readonly timezone: string; readonly weekStart: number }
export const DEFAULT_REPORT_CALENDAR: ReportCalendarContext = { timezone: 'UTC', weekStart: 1 };

/** Derive a plain workspace date from the clock; browser/host timezone never changes a report preset. */
export function reportCalendarRange(preset: 'week' | 'month', calendar: ReportCalendarContext, clock: Date = new Date()): { from: string; to: string } {
  const date = Temporal.Instant.fromEpochMilliseconds(clock.getTime()).toZonedDateTimeISO(calendar.timezone).toPlainDate();
  const start = preset === 'week' ? date.subtract({ days: (date.dayOfWeek - calendar.weekStart + 7) % 7 }) : date.with({ day: 1 });
  const end = preset === 'week' ? start.add({ days: 6 }) : start.with({ day: start.daysInMonth });
  return { from: start.toString(), to: end.toString() };
}
