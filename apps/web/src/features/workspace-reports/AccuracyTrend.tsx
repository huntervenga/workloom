import type { WorkspaceReportResultDto } from '@workloom/contracts';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { accuracyRows, band, MIN_POINTS, type AccuracyPoint, type AccuracyRow, type TrendKind } from './estimationAccuracy';

const classes = (...names: string[]) => names.join(' ');
const BAND_CLASS = {
  good: classes('bg-emerald-500/20', 'text-emerald-800'),
  fair: classes('bg-amber-500/20', 'text-amber-900'),
  poor: classes('bg-rose-500/20', 'text-rose-900', '[[data-theme=dark]_&]:text-rose-200'),
  none: 'text-muted',
} as const;

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/**
 * Per person and week: actual ÷ estimate on the tasks that have both. 100% is a perfect estimate; the trend column says
 * whether the misses are shrinking. Everything comes from the same bucketed server result as the rest of the dashboard.
 */
export function AccuracyTrend({ result }: { result: WorkspaceReportResultDto }) {
  const { t } = useTranslation();
  const rows = accuracyRows(result, t('workspaceReports.accuracy.team'), t('workspaceReports.people.unassigned'));
  const weeks = rows[0]?.points ?? [];
  if (weeks.length < 2 || rows.every(row => row.points.every(point => point.ratio === null))) return null;
  const label = (point: AccuracyPoint) => result.bucket === 'month' ? point.start.slice(0, 7) : point.start.slice(5);
  const trendText = (trend: TrendKind) => trend === 'improving' ? t('workspaceReports.accuracy.improving') : trend === 'worsening' ? t('workspaceReports.accuracy.worsening') : trend === 'steady' ? t('workspaceReports.accuracy.steady') : t('workspaceReports.accuracy.notEnough', { count: MIN_POINTS });
  const detail = (row: AccuracyRow) => row.earlyMiss === null || row.lateMiss === null ? undefined : t('workspaceReports.accuracy.missChange', { early: percent(row.earlyMiss), late: percent(row.lateMiss) });
  return <section aria-label={t('workspaceReports.accuracy.title')} className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4">
    <h3 className="text-sm font-medium">{t('workspaceReports.accuracy.title')}</h3>
    <p className="text-xs text-muted">{t('workspaceReports.accuracy.help')}</p>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-xs">
        <thead className="text-muted"><tr>
          <th scope="col" className="py-1 pr-3 text-left font-medium">{t('workspaceReports.people.person')}</th>
          {weeks.map(point => <th key={point.start} scope="col" className="px-1 py-1 text-center font-normal tabular-nums">{label(point)}</th>)}
          <th scope="col" className="py-1 pl-3 text-left font-medium">{t('workspaceReports.accuracy.trend')}</th>
        </tr></thead>
        <tbody className="divide-y divide-line">{rows.map(row => <tr key={row.key} className={row.key === 'team' ? 'font-medium' : undefined}>
          <th scope="row" className="max-w-40 truncate py-1.5 pr-3 text-left font-normal" title={row.name}>{row.name}</th>
          {row.points.map(point => <td key={point.start} className="px-1 py-1 text-center">
            <span data-accuracy-band={band(point.ratio)} title={point.ratio === null ? t('workspaceReports.accuracy.noPairs') : t('workspaceReports.accuracy.cell', { percent: percent(point.ratio), paired: point.paired })}
              className={`block rounded px-1 py-0.5 tabular-nums ${BAND_CLASS[band(point.ratio)]}`}>{point.ratio === null ? '—' : percent(point.ratio)}</span>
          </td>)}
          <td className="py-1.5 pl-3" title={detail(row)}>
            <span data-accuracy-trend={row.trend} className="inline-flex items-center gap-1">
              {row.trend === 'improving' ? <TrendingDown size={14} aria-hidden="true" className="text-emerald-600" /> : row.trend === 'worsening' ? <TrendingUp size={14} aria-hidden="true" className="text-rose-600" /> : <Minus size={14} aria-hidden="true" className="text-muted" />}
              {trendText(row.trend)}
            </span>
          </td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="text-xs text-muted">{t('workspaceReports.accuracy.caption')}</p>
  </section>;
}
