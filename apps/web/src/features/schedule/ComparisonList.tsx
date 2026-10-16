import { useTranslation } from '../../i18n';
import type { ScheduleDependencyComparisonDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useState } from 'react';
import { Link } from 'react-router';
export function ComparisonList({ comparisons, names, workspaceId }: { comparisons: readonly ScheduleDependencyComparisonDto[]; names: ReadonlyMap<string, string>; workspaceId: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(10);
  if (!comparisons.length) return <p className="text-xs text-muted">{t('schedule.comparisonList.noDependenciesToCompareDates')}</p>;
  return <section aria-label={t('schedule.comparisonList.dependencyDateChecks')} className="space-y-3"><h3 className="text-sm font-semibold">{t('schedule.comparisonList.currentDependencies')}</h3><p className="text-xs text-muted">{t('schedule.comparisonList.warningsDoNotMoveOtherTasksOrReplace')}</p><ul className="space-y-2">{comparisons.slice(0, visible).map(item => <li key={item.dependencyId} className="space-y-1 rounded-lg border border-line p-3 text-xs">
    <p className="[overflow-wrap:anywhere]"><Link className="text-accent-ink underline" to={`/w/${workspaceId}/projects/${item.predecessorContext.project.id}?task=${item.predecessorTaskId}`}>{names.get(item.predecessorTaskId) ?? t('schedule.comparisonList.predecessorValue', { p0: item.predecessorContext.project.name })}</Link> → <Link className="text-accent-ink underline" to={`/w/${workspaceId}/projects/${item.successorContext.project.id}?task=${item.successorTaskId}`}>{names.get(item.successorTaskId) ?? t('schedule.comparisonList.successorValue', { p0: item.successorContext.project.name })}</Link></p>
    <p className={item.state === 'conflict' ? 'font-medium text-amber-900' : 'text-muted'}>{item.state === 'conflict' ? t('schedule.comparisonList.theSuccessorStartsOnOrBeforeThePredecessor') : item.state === 'compatible' ? t('schedule.comparisonList.datesAreAligned') : item.reason === 'meeting_calendar' ? t('schedule.comparisonList.meetingCheckTheScheduleInTheCalendar') : t('schedule.comparisonList.notEnoughDatesToCompare')}</p>
  </li>)}</ul>{comparisons.length > visible ? <Button size="sm" onClick={() => setVisible(count => count + 10)}>{t('schedule.comparisonList.moreDateComparisons')}</Button> : null}</section>;
}
