import type { WorkspaceReportResultDto } from '@workloom/contracts';
import { useState } from 'react';
import { WorkspaceLink as Link } from '../workspace/WorkspaceNavigation';
import { useTranslation } from '../../i18n';
import { loadBand, loadRows, unfinishedWork, type LoadBand, type LoadCell } from './rhythm';

const classes = (...names: string[]) => names.join(' ');
const LOAD_CLASS: Record<LoadBand, string> = {
  good: classes('bg-emerald-500/20', 'text-emerald-800'),
  fair: classes('bg-amber-500/20', 'text-amber-900'),
  low: classes('bg-rose-500/20', 'text-rose-900', '[[data-theme=dark]_&]:text-rose-200'),
  none: 'text-muted',
};
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const hours = (minutes: number) => `${Math.round(minutes / 6) / 10}h`;

/** Per person and week: recorded hours against the hours the person could have worked, with part weeks marked. */
export function HoursLoad({ result }: { result: WorkspaceReportResultDto }) {
  const { t } = useTranslation();
  const rows = loadRows(result, t('workspaceReports.accuracy.team'), t('workspaceReports.people.unassigned'));
  const weeks = rows[0]?.cells ?? [];
  if (weeks.length < 1 || rows.every(row => row.cells.every(cell => cell.ratio === null))) return null;
  const label = (cell: LoadCell) => result.bucket === 'month' ? cell.start.slice(0, 7) : cell.start.slice(5);
  const title = (cell: LoadCell) => cell.ratio === null || cell.workedMinutes === null || cell.availableMinutes === null
    ? t(cell.missing === 'unknown' ? 'workspaceReports.load.unknown' : cell.missing === 'fact' ? 'workspaceReports.load.noFact' : 'workspaceReports.load.away')
    : t(cell.partial ? 'workspaceReports.load.cellPartial' : 'workspaceReports.load.cell', { worked: hours(cell.workedMinutes), available: hours(cell.availableMinutes), percent: percent(cell.ratio), away: hours(cell.awayMinutes), scheduled: hours(cell.scheduledMinutes ?? 0) });
  const average = (cells: LoadCell[]) => {
    const used = cells.filter(cell => cell.workedMinutes !== null && cell.availableMinutes !== null);
    const available = used.reduce((sum, cell) => sum + (cell.availableMinutes ?? 0), 0);
    return available > 0 ? used.reduce((sum, cell) => sum + (cell.workedMinutes ?? 0), 0) / available : null;
  };
  return <section aria-label={t('workspaceReports.load.title')} className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4">
    <h3 className="text-sm font-medium">{t('workspaceReports.load.title')}</h3>
    <p className="text-xs text-muted">{t('workspaceReports.load.help')}</p>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-xs">
        <thead className="text-muted"><tr>
          <th scope="col" className="py-1 pr-3 text-left font-medium">{t('workspaceReports.people.person')}</th>
          {weeks.map(cell => <th key={cell.start} scope="col" className="px-1 py-1 text-center font-normal tabular-nums">{label(cell)}</th>)}
          <th scope="col" className="py-1 pl-3 text-left font-medium" title={t('workspaceReports.load.averageTitle')}>{t('workspaceReports.load.average')}</th>
        </tr></thead>
        <tbody className="divide-y divide-line">{rows.map(row => {
          const mean = average(row.cells);
          return <tr key={row.key} className={row.key === 'team' ? 'font-medium' : undefined}>
            <th scope="row" className="max-w-40 truncate py-1.5 pr-3 text-left font-normal" title={row.name}>{row.name}</th>
            {row.cells.map(cell => <td key={cell.start} className="px-1 py-1 text-center">
              <span data-load-band={loadBand(cell.ratio)} title={title(cell)} className={`block rounded px-1 py-0.5 tabular-nums ${LOAD_CLASS[loadBand(cell.ratio)]}`}>{cell.ratio === null ? '—' : `${percent(cell.ratio)}${cell.partial ? '*' : ''}`}</span>
            </td>)}
            <td className="py-1 pl-3"><span data-load-band={loadBand(mean)} className={`inline-block rounded px-1.5 py-0.5 tabular-nums ${LOAD_CLASS[loadBand(mean)]}`}>{mean === null ? '—' : percent(mean)}</span></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className="text-xs text-muted">{t('workspaceReports.load.partial')}</p>
  </section>;
}

/** Open dated tasks per person and week; tasks whose week is over are listed so nothing hangs unnoticed. */
export function UnfinishedWork({ result, today, workspaceId }: { result: WorkspaceReportResultDto; today: string; workspaceId: string }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<Record<string, number>>({});
  const { weeks, people } = unfinishedWork(result, today, t('workspaceReports.people.unassigned'));
  if (people.length === 0) return null;
  const label = (start: string) => result.bucket === 'month' ? start.slice(0, 7) : start.slice(5);
  return <section aria-label={t('workspaceReports.unfinished.title')} className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4">
    <h3 className="text-sm font-medium">{t('workspaceReports.unfinished.title')}</h3>
    <p className="text-xs text-muted">{t('workspaceReports.unfinished.help')}</p>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-xs">
        <thead className="text-muted"><tr>
          <th scope="col" className="py-1 pr-3 text-left font-medium">{t('workspaceReports.unfinished.person')}</th>
          {weeks.map(week => <th key={week.start} scope="col" className="px-1 py-1 text-center font-normal tabular-nums" title={week.over ? t('workspaceReports.unfinished.weekOver') : undefined}>{label(week.start)}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-line">{people.map(person => <tr key={person.key}>
          <th scope="row" className="max-w-40 truncate py-1.5 pr-3 text-left font-normal" title={person.name}>{person.name}</th>
          {person.perWeek.map((count, index) => <td key={weeks[index]?.start ?? index} className="px-1 py-1 text-center">
            <span className={`block rounded px-1 py-0.5 tabular-nums ${count === 0 ? 'text-muted' : weeks[index]?.over ? LOAD_CLASS.low : ''}`}>{count === 0 ? '·' : count}</span>
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="space-y-2">{people.filter(person => person.pastDue.length > 0).map(person => {
      const limit = shown[person.key] ?? 5, list = person.pastDue.slice(0, limit);
      return <details key={person.key} className="rounded-lg bg-canvas px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">{person.name} · <span className="text-rose-700 [[data-theme=dark]_&]:text-rose-300">{t('workspaceReports.unfinished.overdue', { count: person.pastDue.length })}</span></summary>
        <ul className="mt-2 space-y-1">{list.map(task => <li key={task.taskId}>
          <Link className="hover:underline" to={`/w/${workspaceId}/projects/${task.projectId}?task=${task.taskId}`}>{t('workspaceReports.unfinished.task', { title: task.title, project: task.projectName, due: task.due })}</Link>
        </li>)}</ul>
        {person.pastDue.length > limit ? <button type="button" className="mt-1 text-accent hover:underline" onClick={() => setShown(before => ({ ...before, [person.key]: limit + 20 }))}>{t('workspaceReports.unfinished.showMore', { count: person.pastDue.length - limit })}</button> : null}
      </details>;
    })}</div>
  </section>;
}
