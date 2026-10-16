import { formatDate } from '../../i18n';
/** Browser-local datetime input. No guessed offset for another IANA zone. */
export function localDateTimeInput(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Reject invalid calendars and DST gaps that Date would silently normalize. */
export function parseLocalDateTime(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) && localDateTimeInput(date) === raw ? date : null;
}

/** The period card uses its own labelled IANA zone, independently of the browser/input zone. */
export function formatPeriodCutoff(timestamp: string, timezone: string): string {
  return formatDate(new Date(timestamp), {
    dateStyle: 'short', timeStyle: 'short', timeZone: timezone,
  });
}
