import { sqlCalendarDateSchema } from '@workloom/contracts';
import { cn } from '@workloom/ui';
import { formatDate, useTranslation } from '../../i18n';
import { shiftDay } from '../schedule/dates';

export function calendarDateLabel(value: string, today: string | undefined, full = false): string {
  if (!sqlCalendarDateSchema.safeParse(value).success) return value;
  return formatDate(new Date(`${value}T00:00:00Z`), {
    weekday: full ? 'long' : 'short',
    month: full ? 'long' : 'short',
    day: 'numeric',
    ...(full || value.slice(0, 4) !== today?.slice(0, 4) ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

export function TaskDateLabel({ date, today, finished = false, showOverdue = false }: { date: string; today: string | undefined; finished?: boolean; showOverdue?: boolean }) {
  const { t } = useTranslation();
  const relative = date === today ? 'today' : today && date === shiftDay(today, 1) ? 'tomorrow' : null;
  const overdue = today !== undefined && !finished && date < today && sqlCalendarDateSchema.safeParse(date).success;
  const label = relative ? t(relative === 'today' ? 'tasks.dates.today' : 'tasks.dates.tomorrow') : null;
  return <span className={cn('inline-flex min-w-0 max-w-full items-baseline gap-1.5', overdue && 'font-medium text-rose-700 [[:is([data-theme=dark],[data-theme=default-dark])]_&]:text-rose-300')} title={calendarDateLabel(date, today, true)}>
    <span className="truncate">{calendarDateLabel(date, today)}</span>
    {label ? <span className={cn('shrink-0 rounded px-1 py-0.5 text-[10px] leading-none font-medium', relative === 'today'
      ? 'bg-emerald-100 text-emerald-800 [[:is([data-theme=dark],[data-theme=default-dark])]_&]:bg-emerald-950 [[:is([data-theme=dark],[data-theme=default-dark])]_&]:text-emerald-200'
      : 'bg-canvas text-muted')}>{label}</span> : null}
    {overdue ? <span className={showOverdue ? "shrink-0 text-[10px]" : "sr-only"}>{t(showOverdue ? 'board.overdue' : 'taskTable.taskTable.overdue')}</span> : null}
  </span>;
}
