import { Bell, MessageSquare, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Skeleton, StateCard } from '@workloom/ui';
import { useTranslation } from '../i18n';
import { useInboxQuery } from '../features/inbox/queries';
import { readSeenAt, unreadItems, writeSeenAt } from '../features/inbox/seen';
import { WorkspaceLink as Link } from '../features/workspace/WorkspaceNavigation';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

/** Assignments and comments from other people on the person's own tasks, newest first. */
export function InboxPage() {
  const { actorId, workspace } = useWorkspaceContext();
  const { t, formatDate } = useTranslation();
  useDocumentTitle(t('inbox.title'));
  const query = useInboxQuery(actorId, workspace.id);
  // What was new when the page opened stays marked while it is open; leaving (or refreshing) moves the bookmark.
  const [seenAtOpen] = useState(() => readSeenAt(actorId, workspace.id));
  const items = query.data ?? [];
  const unread = new Set(unreadItems(items, seenAtOpen).map(item => item.id));
  const newest = items[0]?.at;
  useEffect(() => {
    if (!newest) return;
    writeSeenAt(actorId, workspace.id, newest);
  }, [actorId, workspace.id, newest]);
  return <div className="space-y-4">
    <header><h1 className="text-2xl font-semibold tracking-tight text-ink">{t('inbox.title')}</h1><p className="mt-1 text-sm text-muted">{t('inbox.description')}</p></header>
    {query.isError ? <QueryErrorState error={query.error} subject="tasks" retrying={query.isFetching} onRetry={() => void query.refetch()} />
      : query.isPending ? <div aria-label={t('inbox.loading')} className="space-y-2 rounded-xl border border-line bg-surface p-4">{[0, 1, 2].map(index => <Skeleton key={index} className="h-10 w-full" />)}</div>
      : items.length === 0 ? <StateCard icon={<Bell size={18} aria-hidden="true" />} title={t('inbox.emptyTitle')} description={t('inbox.emptyDescription')} />
      : <ul aria-label={t('inbox.list')} className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {items.map(item => <li key={item.id}>
          <Link to={`/w/${workspace.id}/projects/${item.task.projectId}?task=${item.task.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-canvas focus-visible:outline-2 focus-visible:-outline-offset-2">
            {item.kind === 'assigned' ? <UserPlus size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-ink" /> : <MessageSquare size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-ink" />}
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-ink">
                {unread.has(item.id) ? <span className="mr-2 rounded bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent-ink">{t('inbox.new')}</span> : null}
                {item.kind === 'assigned' ? t('inbox.assigned', { actor: item.actorName, task: item.task.title }) : t('inbox.commented', { actor: item.actorName, task: item.task.title })}
              </span>
              {item.excerpt ? <span className="mt-0.5 block truncate text-sm text-muted">{item.excerpt}</span> : null}
              <span className="mt-0.5 block text-xs text-muted">{item.task.projectName} · {formatDate(item.at, { dateStyle: 'medium', timeStyle: 'short' })}</span>
            </span>
          </Link>
        </li>)}
      </ul>}
  </div>;
}
