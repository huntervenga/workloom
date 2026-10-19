import type { LeaveAvailabilityDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { windowOffset, type CalendarWindow } from '../schedule/dates';

/** Matches the public leave-calendar contract; task dates retain their wider 0001–9999 domain. */
export function supportedAvailabilityWindow(window: CalendarWindow): { startDate: string; endDate: string; complete: boolean } | null {
  const startDate = window.start < '1900-01-01' ? '1900-01-01' : window.start;
  const endDate = window.end > '2200-12-31' ? '2200-12-31' : window.end;
  return startDate > endDate ? null : { startDate, endDate, complete: startDate === window.start && endDate === window.end };
}

/** Only authoritative daily rows for the chosen assignee count; raw intervals and company holiday lists never imply a personal claim. */
export function unavailableDates(availability: LeaveAvailabilityDto, membershipId: string | null, window: CalendarWindow): Set<string> {
  const dates = new Set<string>();
  if (!availability.settingsConfigured || !membershipId || availability.members.find(member => member.membershipId === membershipId)?.scheduleKnown !== true) return dates;
  for (const day of availability.days) {
    if (day.membershipId !== membershipId || day.date < window.start || day.date > window.end) continue;
    if (day.absenceMinutes > 0 || day.holidayMinutes > 0) dates.add(day.date);
  }
  return dates;
}

/** Unavailable dates and minutes inside an inclusive task interval; null when the assignee's availability is unknown. */
export function availabilitySummary(availability: LeaveAvailabilityDto | undefined, membershipId: string | null, startDate: string | null, endDate: string | null): { dates: string[]; minutes: number } | null {
  if (!availability?.settingsConfigured || !membershipId) return null;
  if (availability.members.find(member => member.membershipId === membershipId)?.scheduleKnown !== true) return null;
  const first = startDate ?? endDate; const last = endDate ?? startDate;
  if (!first || !last) return null;
  const from = first < last ? first : last; const to = first < last ? last : first;
  if (to < availability.startDate || from > availability.endDate) return null;
  const unavailable = new Map<string, number>();
  for (const day of availability.days) {
    if (day.membershipId !== membershipId || day.date < from || day.date > to || unavailable.has(day.date)) continue;
    const minutes = day.absenceMinutes + day.holidayMinutes;
    if (minutes > 0) unavailable.set(day.date, minutes);
  }
  return { dates: [...unavailable.keys()].sort(), minutes: [...unavailable.values()].reduce((sum, minutes) => sum + minutes, 0) };
}

/** Decorative bands never catch a pointer intended for a Gantt move bar. */
export function GanttAvailabilityBands({ dates, window, width }: { dates: ReadonlySet<string>; window: CalendarWindow; width: number }) {
  return <div aria-hidden="true" data-gantt-availability="" className="pointer-events-none absolute inset-0 z-[1]">{[...dates].map(date => { const offset = windowOffset(date, window); return offset === null ? null : <span key={date} data-unavailable-date={date} className="pointer-events-none absolute inset-y-0 border-x border-accent-line/40 bg-accent-soft/80" style={{ left: offset * width, width }}/>; })}</div>;
}

/** The count follows authoritative capacity rows, never the raw leave interval. */
export function GanttAvailabilityWarning({ availability, membershipId, startDate, endDate }: { availability: LeaveAvailabilityDto | undefined; membershipId: string | null; startDate: string | null; endDate: string | null }) {
  const { t } = useTranslation();
  if (!availability?.settingsConfigured || !membershipId) return null;
  if (availability.members.find(member => member.membershipId === membershipId)?.scheduleKnown === false) return <span title={t('timeOff.availabilityUnknownPerson')} className="text-[11px] text-muted">{t('timeOff.scheduleUnknown')}</span>;
  const count = availabilitySummary(availability, membershipId, startDate, endDate)?.dates.length ?? 0;
  return count > 0 ? <p title={t('timeOff.availabilityOverlap', { count })} className="truncate text-[11px] text-amber-800 [[data-theme=dark]_&]:text-amber-300">{t('timeOff.availabilityOverlap', { count })}</p> : null;
}
