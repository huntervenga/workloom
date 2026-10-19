import { Temporal } from 'temporal-polyfill';
import type { LeaveAvailabilityDto, LeaveOverviewDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { UserAvatar } from '../../shared/UserAvatar';
import { rangeDates } from './presentation';

/** Calendar consumes authorized availability only, never private notes or pending requests. */
export function TimeOffCalendar({ availability, members }: { availability: LeaveAvailabilityDto; members: LeaveOverviewDto['members'] }) {
  const { t, locale } = useTranslation();
  const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' });
  const narrowWeekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
  const dates = rangeDates(availability.startDate, availability.endDate);
  const daily = new Map(availability.days.map(day => [`${day.membershipId}:${day.date}`, day]));
  const holiday = new Set(availability.companyHolidays);
  return <div className="overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full table-fixed border-collapse text-center text-xs" style={{ minWidth: dates.length * 32 + 190 }}>
    <caption className="sr-only">{t('timeOff.teamCalendar')}</caption><thead><tr className="border-b border-line bg-canvas"><th className="sticky left-0 z-10 w-48 bg-canvas px-3 py-3 text-left font-medium">{t('timeOff.person')}</th>{dates.map(date => { const plain = Temporal.PlainDate.from(date); return <th key={date} scope="col" title={fullDate.format(new Date(`${date}T00:00:00Z`))} className={`w-8 py-2 font-normal ${plain.dayOfWeek > 5 ? 'bg-canvas text-subtle' : 'text-muted'}`}><span className="block text-[10px]">{narrowWeekday.format(new Date(`${date}T00:00:00Z`))}</span><span className="font-semibold">{plain.day}</span></th>; })}</tr></thead>
    <tbody>{availability.members.map(member => { const identity = members.find(person => person.id === member.membershipId); return <tr key={member.membershipId} className="border-b border-line last:border-0"><th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-3 text-left"><span className="flex items-center gap-2"><UserAvatar size="sm" name={identity?.displayName ?? member.displayName} seed={member.membershipId} avatarUrl={identity?.avatarUrl}/><span className="truncate font-medium">{identity?.displayName ?? member.displayName}</span></span></th>{dates.map(date => { const day = daily.get(`${member.membershipId}:${date}`); const absence = availability.intervals.some(interval => interval.membershipId === member.membershipId && date >= interval.startDate && date <= interval.endDate); const text = !member.scheduleKnown ? t('timeOff.scheduleUnknown') : holiday.has(date) ? t('timeOff.companyHoliday') : absence ? t('timeOff.unavailable') : day ? t('timeOff.availableHours', { hours: day.availableMinutes / 60 }) : t('timeOff.nonWorkingDay'); return <td key={date} title={`${identity?.displayName ?? member.displayName} · ${date} · ${text}`} className="h-11 border-l border-line/50 px-0.5"><span role="img" aria-label={`${date}: ${text}`} className={`block h-6 rounded ${!member.scheduleKnown ? 'border border-dashed border-line-strong' : holiday.has(date) ? 'bg-amber-500/20 ring-1 ring-inset ring-amber-500/40' : absence ? 'bg-accent text-white ring-1 ring-inset ring-accent-strong' : day && day.scheduledMinutes === 0 ? 'bg-canvas' : ''}`}>{!member.scheduleKnown ? '?' : absence || holiday.has(date) ? '·' : ''}</span></td>; })}</tr>; })}</tbody>
  </table></div>;
}
