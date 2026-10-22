import { Temporal } from 'temporal-polyfill';
import type { LeaveAvailabilityDto, LeaveOverviewDto, LeaveRequestDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { UserAvatar } from '../../shared/UserAvatar';
import { ABSENCE_FALLBACK_COLOR, HOLIDAY_FALLBACK_COLOR, MICRODAYS, rangeDates } from './presentation';

/** Only the already-authorized approved allocations cross into the team calendar; no type or note. */
export interface ApprovedCalendarAllocation { membershipId: string; date: string; microdays: number; scheduledMinutes: number }
export function approvedCalendarAllocations(requests: readonly LeaveRequestDto[]): ApprovedCalendarAllocation[] {
  return requests.filter(request => request.status === 'approved').flatMap(request => request.chargedDays.map(day => ({ membershipId: request.membershipId, date: day.date, microdays: day.microdays, scheduledMinutes: day.scheduledMinutes })));
}

/** Capacity and recorded balance allocations are distinct. Raw intervals never imply a charged working day. */
export function TimeOffCalendar({ availability, members, allocations = [], colors }: { colors?: ReadonlyMap<string, string> | undefined; availability: LeaveAvailabilityDto; members: LeaveOverviewDto['members']; allocations?: readonly ApprovedCalendarAllocation[] }) {
  const { t, locale } = useTranslation();
  const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' });
  const narrowWeekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
  const columns = rangeDates(availability.startDate, availability.endDate).map(date => {
    const instant = new Date(`${date}T00:00:00Z`), plain = Temporal.PlainDate.from(date);
    return { date, day: plain.day, weekend: plain.dayOfWeek > 5, full: fullDate.format(instant), narrow: narrowWeekday.format(instant) };
  });
  const daily = new Map(availability.days.map(day => [`${day.membershipId}:${day.date}`, day]));
  const recorded = new Map<string, ApprovedCalendarAllocation>();
  for (const allocation of allocations) {
    const key = `${allocation.membershipId}:${allocation.date}`;
    // Defensive union: an overlapping historical record must not double the displayed daily charge.
    if ((recorded.get(key)?.microdays ?? -1) < allocation.microdays) recorded.set(key, allocation);
  }
  return <div className="overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full table-fixed border-collapse text-center text-xs" style={{ minWidth: columns.length * 32 + 190 }}>
    <caption className="sr-only">{t('timeOff.teamCalendar')}</caption><thead><tr className="border-b border-line bg-canvas"><th className="sticky left-0 z-10 w-48 bg-canvas px-3 py-3 text-left font-medium">{t('timeOff.person')}</th>{columns.map(column => <th key={column.date} data-calendar-date={column.date} scope="col" title={column.full} className={`w-8 py-2 font-normal text-ink-soft ${column.weekend ? 'bg-[#e2e8f0] [[data-theme=dark]_&]:bg-[#334155]' : ''}`}><span className="block text-[10px]">{column.narrow}</span><span className="font-semibold">{column.day}</span></th>)}</tr></thead>
    <tbody>{availability.members.map(member => {
      const identity = members.find(person => person.id === member.membershipId), person = identity?.displayName ?? member.displayName;
      return <tr key={member.membershipId} className="border-b border-line last:border-0"><th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-3 text-left"><span className="flex items-center gap-2"><UserAvatar size="sm" name={person} seed={member.membershipId} avatarUrl={identity?.avatarUrl}/><span className="truncate font-medium">{person}</span></span></th>{columns.map(column => {
        const { date } = column, day = member.scheduleKnown ? daily.get(`${member.membershipId}:${date}`) : undefined;
        const allocation = recorded.get(`${member.membershipId}:${date}`);
        const absence = !!day && day.absenceMinutes > 0, holiday = !!day && day.holidayMinutes > 0;
        const paidRecord = !!allocation && allocation.microdays > 0, neutralRecord = !!allocation && !paidRecord && !absence && !holiday;
        const unknown = !day;
        const status = absence ? t('timeOff.unavailable') : paidRecord ? t('timeOff.approvedTimeOff') : holiday ? t('timeOff.companyHoliday') : neutralRecord ? t('timeOff.recordedAbsence') : unknown ? t('timeOff.scheduleUnknown') : day.scheduledMinutes > 0 ? t('timeOff.availableHours', { hours: day.availableMinutes / 60 }) : t('timeOff.nonWorkingDay');
        const current = day ? t('timeOff.calendarDayHint', { person, date: column.full, status, scheduled: day.scheduledMinutes / 60, available: day.availableMinutes / 60 }) : `${person} · ${column.full} · ${status} · ${t('timeOff.scheduleUnknown')}`;
        const title = allocation ? `${current} · ${t('timeOff.recordedBalanceDays', { days: allocation.microdays / MICRODAYS })}` : current;
        const typeColor = colors?.get(`${member.membershipId}:${date}`);
        const fill = absence || paidRecord || neutralRecord ? typeColor ?? (absence || paidRecord ? ABSENCE_FALLBACK_COLOR : undefined) : holiday ? HOLIDAY_FALLBACK_COLOR : undefined;
        const paint = fill ? 'text-white ring-1 ring-inset ring-black/10' : neutralRecord ? 'ring-1 ring-inset ring-line-strong text-ink-soft' : unknown ? 'border border-dashed border-line-strong' : day.scheduledMinutes === 0 && !column.weekend ? 'bg-canvas' : '';
        return <td key={date} data-calendar-date={date} title={title} className={`h-11 border-l border-line/50 px-0.5 ${column.weekend ? 'bg-[#e2e8f0] [[data-theme=dark]_&]:bg-[#334155]' : ''}`}><span role="img" aria-label={`${date}: ${status}`} className={`block h-6 rounded ${paint}`} style={fill ? { backgroundColor: fill } : undefined}>{absence || holiday || allocation ? '·' : unknown ? '?' : ''}</span></td>;
      })}</tr>;
    })}</tbody>
  </table></div>;
}
