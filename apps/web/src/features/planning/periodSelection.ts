import type { PlanningPeriodDto } from '@workloom/contracts';

type PeriodDates = Pick<PlanningPeriodDto, 'id' | 'localStart' | 'localEndExclusive' | 'timezone'>;

/** The selector lists newest weeks first, with stable ties independent of UUID paging order. */
export function sortPlanningPeriods<T extends PeriodDates>(periods: readonly T[]): T[] {
  return [...periods].sort((a, b) =>
    b.localStart.localeCompare(a.localStart) ||
    b.localEndExclusive.localeCompare(a.localEndExclusive) ||
    a.timezone.localeCompare(b.timezone) ||
    a.id.localeCompare(b.id),
  );
}

/** An explicit URL choice always wins. Otherwise prefer current, nearest future, then latest past. */
export function selectPlanningPeriodId(
  periods: readonly PeriodDates[],
  explicitId: string | null,
  at: Date = new Date(),
): string | null {
  if (explicitId !== null) return explicitId;
  const ordered = sortPlanningPeriods(periods);
  const dated = ordered.flatMap((period) => {
    const today = localDate(period.timezone, at);
    return today === null ? [] : [{ period, today }];
  });
  const current = dated.find(({ period, today }) => period.localStart <= today && today < period.localEndExclusive);
  if (current) return current.period.id;
  const upcoming = dated
    .filter(({ period, today }) => today < period.localStart)
    .sort((a, b) => a.period.localStart.localeCompare(b.period.localStart) ||
      a.period.localEndExclusive.localeCompare(b.period.localEndExclusive) ||
      a.period.timezone.localeCompare(b.period.timezone) || a.period.id.localeCompare(b.period.id));
  return upcoming[0]?.period.id ?? dated.find(({ period, today }) => period.localEndExclusive <= today)?.period.id ?? null;
}

function localDate(timezone: string, at: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}
