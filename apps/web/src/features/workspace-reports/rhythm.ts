import type { WorkspaceReportBucketDto, WorkspaceReportPersonDto, WorkspaceReportResultDto } from '@workloom/contracts';

/** How fully a person's available hours were used: under 90% needs a look, 95% and above is fine, more than 100% is simply more. */
export type LoadBand = 'low' | 'fair' | 'good' | 'none';
export const LOW_LOAD = 0.9;
export const GOOD_LOAD = 0.95;

export function loadBand(ratio: number | null): LoadBand {
  if (ratio === null) return 'none';
  return ratio < LOW_LOAD ? 'low' : ratio < GOOD_LOAD ? 'fair' : 'good';
}

export interface LoadCell {
  start: string; end: string;
  /** Worked ÷ available; null when nobody was available (a dash) or the schedule is not known. */
  ratio: number | null;
  workedMinutes: number | null;
  availableMinutes: number | null;
  scheduledMinutes: number | null;
  /** Time off or a holiday took part of the week, so the figure is measured against fewer hours. */
  partial: boolean;
  /** Why there is no figure. */
  missing: 'away' | 'unknown' | null;
  awayMinutes: number;
}
export interface LoadRow { key: string; membershipId: string | null; name: string; cells: LoadCell[] }

const rational = (value: { numerator: string; denominator: string } | null | undefined): number | null => {
  if (!value) return null;
  const denominator = Number(value.denominator);
  return denominator === 0 ? null : Number(value.numerator) / denominator;
};

function personCell(bucket: WorkspaceReportBucketDto, person: WorkspaceReportPersonDto | undefined): LoadCell {
  const base = { start: bucket.startDate, end: bucket.endDate };
  const capacity = person?.capacity;
  if (!person || !capacity || !capacity.scheduleKnown) return { ...base, ratio: null, workedMinutes: null, availableMinutes: null, scheduledMinutes: null, partial: false, missing: 'unknown', awayMinutes: 0 };
  const worked = person.fact.unit === 'minutes' ? rational(person.fact.value) ?? 0 : 0;
  const available = capacity.availableMinutes ?? 0, away = (capacity.absenceMinutes ?? 0) + (capacity.holidayMinutes ?? 0);
  if (available <= 0) return { ...base, ratio: null, workedMinutes: worked, availableMinutes: 0, scheduledMinutes: capacity.scheduledMinutes ?? 0, partial: false, missing: 'away', awayMinutes: away };
  return { ...base, ratio: worked / available, workedMinutes: worked, availableMinutes: available, scheduledMinutes: capacity.scheduledMinutes ?? 0, partial: away > 0, missing: null, awayMinutes: away };
}

/** The team row followed by one row per person: hours recorded against the hours the person could have worked that week. */
export function loadRows(result: Pick<WorkspaceReportResultDto, 'buckets' | 'people'>, teamLabel: string, unassignedLabel: string): LoadRow[] {
  const buckets = [...result.buckets].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const people = result.people.filter(person => person.membershipId !== null).map(person => ({
    key: person.membershipId as string, membershipId: person.membershipId, name: person.displayName,
    cells: buckets.map(bucket => personCell(bucket, bucket.people.find(entry => entry.membershipId === person.membershipId))),
  }));
  const team: LoadRow = {
    key: 'team', membershipId: null, name: teamLabel,
    cells: buckets.map((bucket, index) => {
      const cells = people.map(person => person.cells[index]).filter((cell): cell is LoadCell => cell !== undefined && cell.ratio !== null);
      const available = cells.reduce((sum, cell) => sum + (cell.availableMinutes ?? 0), 0), worked = cells.reduce((sum, cell) => sum + (cell.workedMinutes ?? 0), 0);
      const base = { start: bucket.startDate, end: bucket.endDate };
      if (available <= 0) return { ...base, ratio: null, workedMinutes: null, availableMinutes: null, scheduledMinutes: null, partial: false, missing: 'away' as const, awayMinutes: 0 };
      return { ...base, ratio: worked / available, workedMinutes: worked, availableMinutes: available, scheduledMinutes: cells.reduce((sum, cell) => sum + (cell.scheduledMinutes ?? 0), 0), partial: cells.some(cell => cell.partial), missing: null, awayMinutes: cells.reduce((sum, cell) => sum + cell.awayMinutes, 0) };
    }),
  };
  void unassignedLabel;
  return [team, ...people];
}

export interface OpenTask { taskId: string; title: string; projectId: string; projectName: string; due: string; planMinutes: number | null; weekIndex: number }
export interface UnfinishedPerson { key: string; membershipId: string | null; name: string; perWeek: number[]; pastDue: OpenTask[] }

/**
 * Open tasks (to do or in progress) with a due date, per person and week. The ones whose week is over are "past due": work
 * that was planned for a week and is still hanging.
 */
export function unfinishedWork(result: Pick<WorkspaceReportResultDto, 'buckets' | 'people' | 'rows' | 'sources'>, today: string, unassignedLabel: string): { weeks: { start: string; end: string; over: boolean }[]; people: UnfinishedPerson[] } {
  const buckets = [...result.buckets].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const weeks = buckets.map(bucket => ({ start: bucket.startDate, end: bucket.endDate, over: bucket.endDate < today }));
  const projectName = new Map(result.sources.map(source => [source.projectId, source.projectName]));
  const names = new Map(result.people.map(person => [person.membershipId ?? 'unassigned', person.membershipId === null ? unassignedLabel : person.displayName]));
  const byPerson = new Map<string, UnfinishedPerson>();
  for (const row of result.rows) {
    if ((row.statusGroup !== 'todo' && row.statusGroup !== 'in_progress') || row.date === null) continue;
    const weekIndex = buckets.findIndex(bucket => row.date !== null && row.date >= bucket.startDate && row.date <= bucket.endDate);
    if (weekIndex < 0) continue;
    const key = row.primaryAssigneeId ?? 'unassigned';
    const person = byPerson.get(key) ?? { key, membershipId: row.primaryAssigneeId, name: names.get(key) ?? unassignedLabel, perWeek: weeks.map(() => 0), pastDue: [] };
    person.perWeek[weekIndex] = (person.perWeek[weekIndex] ?? 0) + 1;
    if (row.date < today) person.pastDue.push({ taskId: row.taskId, title: row.title, projectId: row.homeProjectId, projectName: projectName.get(row.homeProjectId) ?? '', due: row.date, planMinutes: row.planMinutes, weekIndex });
    byPerson.set(key, person);
  }
  const people = [...byPerson.values()].map(person => ({ ...person, pastDue: person.pastDue.sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title)) }))
    .sort((a, b) => b.pastDue.length - a.pastDue.length || a.name.localeCompare(b.name));
  return { weeks, people };
}
