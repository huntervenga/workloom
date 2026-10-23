import { ArrowRight } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { WorkspaceLink as Link } from '../workspace/WorkspaceNavigation';
import { uniqueLoadedMyTasks } from './api';
import { useMyTasksQuery } from './queries';

const SHOWN = 5;

/** The few open tasks that are due first, for the Overview. Nothing is shown while loading, on error or when there is nothing to do. */
export function NextTasks({ actorId, workspaceId }: { actorId: string; workspaceId: string }) {
  const { t, formatDate } = useTranslation();
  const query = useMyTasksQuery(actorId, workspaceId, { relation: 'all', completion: 'open', includeArchived: false });
  const rows = uniqueLoadedMyTasks(query.data?.pages ?? []).slice(0, SHOWN);
  if (rows.length === 0) return null;
  return <section aria-labelledby="next-tasks-heading" className="rounded-2xl border border-line bg-surface">
    <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
      <h2 id="next-tasks-heading" className="text-sm font-semibold text-ink">{t('nextTasks.title')}</h2>
      <Link to={`/w/${workspaceId}/my-tasks`} className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent-ink hover:text-accent-strong">{t('nextTasks.all')}<ArrowRight size={16} aria-hidden="true" /></Link>
    </div>
    <ul className="divide-y divide-line">
      {rows.map(row => <li key={row.task.id}>
        <Link to={`/w/${workspaceId}/projects/${row.task.projectId}?task=${row.task.id}`} className="flex items-baseline gap-3 px-5 py-2.5 hover:bg-canvas">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{row.task.title}</span>
          <span className="hidden shrink-0 text-xs text-muted sm:inline">{row.project.name}</span>
          <span className="w-20 shrink-0 text-right text-xs text-muted">{row.task.dueDate ? formatDate(row.task.dueDate, { month: 'short', day: 'numeric' }) : ''}</span>
        </Link>
      </li>)}
    </ul>
  </section>;
}
