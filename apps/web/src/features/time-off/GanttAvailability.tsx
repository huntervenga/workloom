import type { LeaveAvailabilityDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { rangeDates } from './presentation';
import { windowOffset, type CalendarWindow } from '../schedule/dates';

/** Matches the public leave-calendar contract; task dates retain their wider 0001–9999 domain. */
export function supportedAvailabilityWindow(window: CalendarWindow): { startDate: string; endDate: string; complete: boolean } | null {
  const startDate = window.start < '1900-01-01' ? '1900-01-01' : window.start;
  const endDate = window.end > '2200-12-31' ? '2200-12-31' : window.end;
  return startDate > endDate ? null : { startDate, endDate, complete: startDate === window.start && endDate === window.end };
}

export function unavailableDates(availability: LeaveAvailabilityDto, membershipId: string | null, window: CalendarWindow): Set<string> {
  const dates = new Set(availability.companyHolidays.filter(date => date >= window.start && date <= window.end));
  if (membershipId) for (const interval of availability.intervals) {
    if (interval.membershipId !== membershipId || interval.endDate < window.start || interval.startDate > window.end) continue;
    for (const date of rangeDates(interval.startDate < window.start ? window.start : interval.startDate, interval.endDate > window.end ? window.end : interval.endDate)) dates.add(date);
  }
  return dates;
}
/** Decorative bands never catch a pointer intended for a Gantt move bar. */
export function GanttAvailabilityBands({ dates, window, width }: { dates: ReadonlySet<string>; window: CalendarWindow; width: number }) {
  return <div aria-hidden="true" data-gantt-availability="" className="pointer-events-none absolute inset-0 z-[1]">{[...dates].map(date => { const offset = windowOffset(date, window); return offset === null ? null : <span key={date} data-unavailable-date={date} className="pointer-events-none absolute inset-y-0 border-x border-accent-line/40 bg-accent-soft/80" style={{ left: offset * width, width }}/>; })}</div>;
}
export function GanttAvailabilityWarning({ availability, membershipId, startDate, endDate, dates }: { availability: LeaveAvailabilityDto | undefined; membershipId: string | null; startDate: string | null; endDate: string | null; dates: ReadonlySet<string> }) {
  const { t } = useTranslation();
  if (!availability?.settingsConfigured || !membershipId) return null;
  if (availability.members.find(member => member.membershipId === membershipId)?.scheduleKnown === false) return <span title={t('timeOff.availabilityUnknownPerson')} className="text-[11px] text-muted">{t('timeOff.scheduleUnknown')}</span>;
  const from = startDate ?? endDate; const to = endDate ?? startDate;
  const count = from && to ? [...dates].filter(date => date >= from && date <= to).length : 0;
  return count > 0 ? <p title={t('timeOff.availabilityOverlap', { count })} className="truncate text-[11px] text-amber-800 dark:text-amber-300">{t('timeOff.availabilityOverlap', { count })}</p> : null;
}
