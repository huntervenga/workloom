import { Temporal } from 'temporal-polyfill';
import { t } from '../../../i18n';
import type { LeaveOverviewDto } from '@workloom/contracts';

export type RowIssue = 'person' | 'type' | 'startDate' | 'endDate' | 'order' | 'columns' | 'duplicate';
export interface ParsedAbsence { line: number; person: string; type: string; startDate: string | null; endDate: string | null; note: string; issues: RowIssue[] }
export interface AbsenceTable { rows: ParsedAbsence[]; missingColumns: ('person' | 'type' | 'start' | 'end')[] }

type Column = 'person' | 'type' | 'start' | 'end' | 'note';
/** Accepted column titles per language come from the catalog, `|`-separated, so they can be localized. */
const aliases = (key: Column): string[] => {
  const titles = { person: t('absenceImport.headers.person'), type: t('absenceImport.headers.type'), start: t('absenceImport.headers.start'), end: t('absenceImport.headers.end'), note: t('absenceImport.headers.note') };
  return titles[key].split('|');
};
const normal = (text: string) => text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** ISO `2026-07-06` or dotted `06.07.2026`; slashes are refused because day/month order cannot be guessed. */
export function normalizeDate(text: string): string | null {
  const value = text.trim();
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : dotted ? [dotted[3], dotted[2], dotted[1]] : [];
  if (!year || !month || !day) return null;
  try {
    const date = Temporal.PlainDate.from({ year: Number(year), month: Number(month), day: Number(day) }, { overflow: 'reject' });
    return date.year >= 1900 && date.year <= 2200 ? date.toString() : null;
  } catch { return null; }
}

export function readAbsenceTable(grid: readonly (readonly string[])[]): AbsenceTable {
  const header = (grid[0] ?? []).map(normal);
  const column = (key: Column) => header.findIndex(cell => aliases(key).includes(cell));
  const index = { person: column('person'), type: column('type'), start: column('start'), end: column('end'), note: column('note') };
  const missingColumns = (['person', 'type', 'start', 'end'] as const).filter(key => index[key] < 0);
  if (missingColumns.length > 0) return { rows: [], missingColumns };
  const cell = (row: readonly string[], position: number) => (position >= 0 ? row[position] ?? '' : '').trim();
  const rows = grid.slice(1).map((row, offset): ParsedAbsence => {
    const startText = cell(row, index.start), endText = cell(row, index.end) || startText;
    const startDate = normalizeDate(startText), endDate = normalizeDate(endText);
    const issues: RowIssue[] = [];
    if (startDate === null) issues.push('startDate');
    if (endDate === null) issues.push('endDate');
    if (startDate !== null && endDate !== null && endDate < startDate) issues.push('order');
    return { line: offset + 2, person: cell(row, index.person), type: cell(row, index.type), startDate, endDate, note: cell(row, index.note), issues };
  });
  const seen = new Set<string>();
  for (const row of rows) {
    const key = [normal(row.person), normal(row.type), row.startDate, row.endDate].join('|');
    if (seen.has(key)) row.issues.push('duplicate'); else seen.add(key);
  }
  return { rows, missingColumns };
}

export type RowStatus = 'ready' | 'exists' | 'invalid';
export interface ResolvedAbsence extends ParsedAbsence { membershipId: string | null; typeId: string | null; status: RowStatus }
export interface Names { id: string; name: string }

/** Each distinct person/type text maps to one member/type; `overrides` are the choices made for names that did not match. */
export function resolveAbsences(rows: readonly ParsedAbsence[], overview: Pick<LeaveOverviewDto, 'members' | 'settings' | 'requests'>, overrides: { people: Record<string, string>; types: Record<string, string> } = { people: {}, types: {} }): ResolvedAbsence[] {
  const people: Names[] = overview.members.map(member => ({ id: member.id, name: member.displayName }));
  const types = new Map<string, Names>();
  for (const version of [...(overview.settings?.policyVersions ?? [])].sort((a, b) => a.effectiveYear - b.effectiveYear)) for (const type of version.types) types.set(type.id, { id: type.id, name: type.name });
  const unique = (list: readonly Names[], text: string): string | null => { const hits = list.filter(item => normal(item.name) === normal(text)); return hits.length === 1 ? hits[0]?.id ?? null : null; };
  return rows.map(row => {
    const membershipId = overrides.people[normal(row.person)] || unique(people, row.person);
    const typeId = overrides.types[normal(row.type)] || unique([...types.values()], row.type);
    const issues = [...row.issues];
    if (membershipId === null) issues.push('person');
    if (typeId === null) issues.push('type');
    const exists = membershipId !== null && typeId !== null && overview.requests.some(request => request.membershipId === membershipId && request.typeId === typeId && request.startDate === row.startDate && request.endDate === row.endDate && request.status !== 'rejected' && request.status !== 'cancelled');
    const status: RowStatus = issues.length > 0 ? 'invalid' : exists ? 'exists' : 'ready';
    return { ...row, issues, membershipId, typeId, status };
  });
}

/** Names that matched nothing, so the person can pick the counterpart once for every row that uses them. */
export function unmatchedNames(rows: readonly ResolvedAbsence[]): { people: string[]; types: string[] } {
  const distinct = (pick: (row: ResolvedAbsence) => string, bad: (row: ResolvedAbsence) => boolean) => [...new Map(rows.filter(bad).map(row => [normal(pick(row)), pick(row)])).values()].filter(Boolean);
  return { people: distinct(row => row.person, row => row.membershipId === null), types: distinct(row => row.type, row => row.typeId === null) };
}
export const nameKey = normal;
