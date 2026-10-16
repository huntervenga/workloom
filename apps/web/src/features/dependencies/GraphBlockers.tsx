import type { TaskDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import type { useBlockingQuery } from './queries';

/** One selected task's authoritative, paginated read; never inferred from graph edges. */
export function GraphBlockers({ task, graphTaskIds, blocking, onClose, onOpen }: {
  task: TaskDto;
  graphTaskIds: ReadonlySet<string>;
  blocking: ReturnType<typeof useBlockingQuery>;
  onClose: () => void;
  onOpen: (task: TaskDto) => void;
}) {
  const { t } = useTranslation();
  const pages = blocking.data?.pages;
  const summary = pages?.[0]?.data.summary;
  const mismatched = pages?.some(page => page.data.summary.taskId !== task.id.toLowerCase()) ?? false;
  const error = blocking.error ?? (mismatched ? new ApiError({ kind: 'invalid_response', status: 200 }) : null);
  // Errors (including a failed later page) hide cached data. A refreshed zero is authoritative.
  const checking = blocking.isPending || blocking.isFetching && !blocking.isFetchingNextPage;
  const rows = pages?.flatMap(page => page.data.blockers) ?? [];
  return <DialogShell open title={t('dependencies.graphBlockers.title', { title: task.title })} description={t('dependencies.graphBlockers.description')} onOpenChange={open => { if (!open) onClose(); }}>
    <div className="mt-4 space-y-3">
      {error ? <>
        <p role="status" className="text-sm text-muted">{t('dependencies.graphBlockers.unavailable')}</p>
        <QueryErrorState error={error} subject="task" headingLevel={3} />
        <Button size="sm" disabled={blocking.isFetching} onClick={() => void blocking.refetch({ cancelRefetch: true })}>{t('dependencies.graphBlockers.restart')}</Button>
      </> : checking || !summary ? <p role="status" className="text-sm text-muted">{t('dependencies.graphBlockers.checking')}</p> : <>
        <p className="text-sm font-medium">{t('dependencies.graphBlockers.count', { count: summary.unresolvedCount })}</p>
        {summary.unresolvedCount === 0 ? <p role="status" className="text-sm text-muted">{t('dependencies.graphBlockers.resolved')}</p> : <>
          <p className="text-sm text-amber-900">{t(summary.policy.mode === 'enforce' ? 'dependencies.graphBlockers.enforce' : 'dependencies.graphBlockers.warn')}</p>
          {summary.violatesCurrentStatus ? <p className="text-sm text-amber-900">{t('dependencies.graphBlockers.violation')}</p> : null}
          <p role="status" className="text-xs text-muted">{t('dependencies.graphBlockers.loaded', { loaded: rows.length, total: summary.unresolvedCount })}</p>
          <ul className="space-y-3">{rows.map(row => <li key={row.dependency.id} className="space-y-1 rounded-lg border border-line p-3">
            <p className="text-sm font-medium [overflow-wrap:anywhere]">{row.predecessor.title}</p>
            <p className="text-xs text-muted [overflow-wrap:anywhere]">{row.predecessorContext.project.name} · {row.predecessorContext.status.name}</p>
            {row.predecessor.archivedAt ? <p className="text-xs text-muted">{t('dependencies.graphBlockers.archived')}</p> : null}
            {row.predecessorContext.project.archivedAt ? <p className="text-xs text-muted">{t('dependencies.graphBlockers.archivedProject')}</p> : null}
            {!graphTaskIds.has(row.predecessor.id) ? <p className="text-xs text-muted">{t('dependencies.graphBlockers.outside')}</p> : null}
            <Button size="sm" aria-label={t('dependencies.graphBlockers.openTask', { title: row.predecessor.title })} onClick={() => onOpen(row.predecessor)}>{t('dependencies.graphBlockers.open')}</Button>
          </li>)}</ul>
          {blocking.hasNextPage ? <Button size="sm" disabled={blocking.isFetchingNextPage} onClick={() => void blocking.fetchNextPage()}>{t('dependencies.graphBlockers.more')}</Button> : null}
        </>}
        <Button size="sm" disabled={blocking.isFetching} onClick={() => void blocking.refetch({ cancelRefetch: true })}>{t('dependencies.graphBlockers.refresh')}</Button>
      </>}
    </div>
  </DialogShell>;
}
