import type { GenericReportResultDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { statusLabels } from './translationKeys';

/** Status counts are complete server aggregates, not a quality score inferred from hours. */
export function ReportDeliveryOverview({ result }: { result: GenericReportResultDto }) {
  const { t } = useTranslation();
  const statuses = ['done', 'in_progress', 'todo', 'cancelled'] as const;
  return <section aria-label={t('genericReports.dashboard.deliveryTitle')} className="space-y-3 rounded-xl border border-line bg-surface p-4"><h3 className="text-sm font-semibold">{t('genericReports.dashboard.deliveryTitle')}</h3><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{statuses.map(status => {
    const count = result.groups.find(group => group.key === status)?.taskCount ?? 0;
    const width = result.totalTasks > 0 ? count / result.totalTasks * 100 : 0;
    return <div key={status} className="space-y-1.5"><p className="text-xs text-muted">{t(statusLabels[status])}</p><p className="text-xl font-semibold tabular-nums">{count}</p><span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-canvas"><span className={`block h-full rounded-full ${status === 'done' ? 'bg-emerald-500' : status === 'in_progress' ? 'bg-accent' : status === 'cancelled' ? 'bg-muted' : 'bg-cyan-600'}`} style={{width:`${width}%`}}/></span></div>;
  })}</div><p className="text-xs text-muted">{t('genericReports.dashboard.deliveryHint')}</p></section>;
}
