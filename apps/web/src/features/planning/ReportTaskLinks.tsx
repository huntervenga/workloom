import { WorkspaceLink } from '../workspace/WorkspaceNavigation';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@workloom/ui';
import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import { isAccessDenied } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { fetchTask } from '../tasks/api';
import { currentReportTaskHref, type ReportTaskSourceContext } from './navigation';

const TASK_REVEAL_SIZE = 10;

interface Props {
  actorId: string;
  workspaceId: string;
  projectId: string;
  periodId: string;
  membershipId: string;
  taskIds: readonly string[];
}

/** Current destinations are separate from the report's immutable titles and calculations. */
export function ReportTaskLinks({ actorId, workspaceId, projectId, periodId, membershipId, taskIds }: Props) {
  const { t } = useTranslation();
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(TASK_REVEAL_SIZE);
  const ids = [...new Set(taskIds)];
  const source: ReportTaskSourceContext = { workspaceId, projectId, periodId, workerId: membershipId };
  if (ids.length === 0) return <p className="mt-2 text-xs text-muted">{t('planning.reportTasks.none')}</p>;
  return <div className="mt-2 space-y-2">
    <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={panelId} onClick={() => { setExpanded(!expanded); setVisibleCount(TASK_REVEAL_SIZE); }}>{expanded ? t('planning.reportTasks.hide') : t('planning.reportTasks.show', { count: ids.length })}</Button>
    {expanded ? <div id={panelId} className="space-y-3 rounded-lg border border-line bg-canvas p-3">
      <p className="text-xs leading-relaxed text-muted">{t('planning.reportTasks.currentContext')}</p>
      <ul className="space-y-3">{ids.slice(0, visibleCount).map(taskId => <CurrentTaskLink key={taskId} actorId={actorId} source={source} taskId={taskId} />)}</ul>
      <p className="text-xs text-muted">{t('planning.reportTasks.showing', { shown: Math.min(visibleCount, ids.length), total: ids.length })}</p>
      {visibleCount < ids.length ? <Button size="sm" onClick={() => setVisibleCount(before => before + TASK_REVEAL_SIZE)}>{t('planning.reportTasks.showMore', { count: Math.min(TASK_REVEAL_SIZE, ids.length - visibleCount) })}</Button> : null}
    </div> : null}
  </div>;
}

function CurrentTaskLink({ actorId, source, taskId }: { actorId: string; source: ReportTaskSourceContext; taskId: string }) {
  const { t } = useTranslation();
  const task = useQuery({
    queryKey: queryKeys.task(actorId, source.workspaceId, taskId),
    queryFn: ({ signal }) => fetchTask(source.workspaceId, taskId, signal),
    // A cached title is not evidence of current access. Every reveal must finish a fresh read.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  if (task.isError) return <li className="space-y-1 text-xs text-muted"><p>{isAccessDenied(task.error) ? t('planning.reportTasks.unavailable') : t('planning.reportTasks.loadFailed')}</p><Button size="sm" variant="ghost" onClick={() => void task.refetch()}>{t('planning.reportTasks.retry')}</Button></li>;
  if (!task.isFetchedAfterMount || task.isFetching || !task.data) return <li role="status" className="text-xs text-muted">{t('planning.reportTasks.loading')}</li>;
  if (task.data.id !== taskId || task.data.workspaceId !== source.workspaceId) return <li className="text-xs text-muted">{t('planning.reportTasks.unavailable')}</li>;
  return <li className="space-y-1 text-sm [overflow-wrap:anywhere]">
    <p className="text-xs text-muted">{t('planning.reportTasks.currentTitle')}</p>
    <WorkspaceLink to={currentReportTaskHref(task.data, source)} target="_blank" rel="noopener" className="inline-block rounded font-medium text-accent-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">{task.data.title}<span className="mt-0.5 block text-xs font-normal">{t('planning.reportTasks.openNewTab')}</span></WorkspaceLink>
  </li>;
}
