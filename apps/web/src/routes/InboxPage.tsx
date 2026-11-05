import { inboxItemState, updateInboxItemState, useInboxItemStates } from '../features/inbox/itemState';
import { Archive, ArchiveRestore, Bell, Bookmark, CalendarDays, Mail, MailOpen, MessageSquare, UserPlus } from 'lucide-react';
import type { InboxItemDto } from '@workloom/contracts';
import { useEffect, useState } from 'react';
import { Button, Skeleton, StateCard } from '@workloom/ui';
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
  const [tab, setTab] = useState<'activity' | 'saved' | 'archived'>('activity');
  const states = useInboxItemStates(actorId, workspace.id);
  const shown = items.filter(item => {
    const state = inboxItemState(states, item);
    return tab === 'archived' ? state.archived === true : !state.archived && (tab === 'activity' || state.saved === true);
  });
  const change = (item: (typeof items)[number], patch: Parameters<typeof updateInboxItemState>[3]) =>
    updateInboxItemState(actorId, workspace.id, item, patch);

  const unread = new Set(unreadItems(items, seenAtOpen).map(item => item.id));
  const newest = items[0]?.at;
  useEffect(() => {
    if (!newest) return;
    writeSeenAt(actorId, workspace.id, newest);
  }, [actorId, workspace.id, newest]);
  const describe = (item: InboxItemDto): string => {
    if (item.kind === 'date_changed' && item.task) return t('inbox.dateChanged', { actor: item.actorName, task: item.task.title });
    if (item.kind === 'assigned' && item.task) return t('inbox.assigned', { actor: item.actorName, task: item.task.title });
    if (item.kind === 'mention' && item.task) return t('inbox.mentioned', { actor: item.actorName, task: item.task.title });
    if (item.kind === 'comment' && item.task) return t('inbox.commented', { actor: item.actorName, task: item.task.title });
    const dates = { start: item.leave?.startDate ?? '', end: item.leave?.endDate ?? '' };
    if (item.kind === 'leave_pending') return t('inbox.leavePending', { person: item.leave?.personName ?? item.actorName, ...dates });
    return t(item.leave?.status === 'rejected' ? 'inbox.leaveRejected' : item.leave?.status === 'cancelled' ? 'inbox.leaveCancelled' : 'inbox.leaveApproved', { actor: item.actorName, ...dates });
  };
  return <div className="space-y-4">
    <header><h1 className="text-2xl font-semibold tracking-tight text-ink">{t('inbox.title')}</h1><p className="mt-1 text-sm text-muted">{t('inbox.description')}</p></header>
    <nav aria-label={t('inbox.views')} className="flex gap-1 border-b border-line pb-2">
      {([
        ['activity', t('inbox.activity')], ['saved', t('inbox.saved')], ['archived', t('inbox.archive')],
      ] as const).map(([id, label]) => <Button type="button" key={id} size="sm" variant={tab === id ? 'primary' : 'ghost'}
        aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</Button>)}
    </nav>
    {query.isError ? <QueryErrorState error={query.error} subject="tasks" retrying={query.isFetching} onRetry={() => void query.refetch()} />
      : query.isPending ? <div aria-label={t('inbox.loading')} className="space-y-2 rounded-xl border border-line bg-surface p-4">{[0, 1, 2].map(index => <Skeleton key={index} className="h-10 w-full" />)}</div>
      : shown.length === 0 ? <StateCard icon={<Bell size={18} aria-hidden="true" />} title={t(tab === 'saved' ? 'inbox.emptySaved' : tab === 'archived' ? 'inbox.emptyArchived' : 'inbox.emptyTitle')} description={tab === 'activity' ? t('inbox.emptyDescription') : undefined} />
      : <ul aria-label={t('inbox.list')} className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {shown.map(item => {
          const text = describe(item);
          const state = inboxItemState(states, item);
          const isUnread = state.unread ?? unread.has(item.id);
          const readLabel = t(isUnread ? 'inbox.markRead' : 'inbox.markUnread');
          const saveLabel = t(state.saved ? 'inbox.removeSaved' : 'inbox.saveItem');
          const archiveLabel = t(state.archived ? 'inbox.restore' : 'inbox.archiveItem');
          return <li key={`${item.kind}:${item.id}:${item.task?.id ?? ''}`} className="flex items-start gap-1">
            <Link to={item.task ? `/w/${workspace.id}/projects/${item.task.projectId}?task=${item.task.id}` : `/w/${workspace.id}/time-off`} onClick={() => change(item, { unread: false })} className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 hover:bg-canvas focus-visible:outline-2 focus-visible:-outline-offset-2">
              {item.kind === 'assigned' ? <UserPlus size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-ink" /> : item.kind === 'comment' || item.kind === 'mention' ? <MessageSquare size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-ink" /> : <CalendarDays size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-ink" />}
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink">
                  {isUnread ? <span className="mr-2 rounded bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent-ink">{t('inbox.new')}</span> : null}
                  {text}
                </span>
                {item.excerpt ? <span className="mt-0.5 block truncate text-sm text-muted">{item.excerpt}</span> : null}
                <span className="mt-0.5 block text-xs text-muted">{item.task ? `${item.task.projectName} · ` : ''}{formatDate(item.at, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </span>
            </Link>
            <div className="flex shrink-0 items-center gap-0.5 py-2 pr-2">
              {!state.archived ? <>
                <Button type="button" size="sm" variant="ghost" aria-label={readLabel} title={readLabel} onClick={() => change(item, { unread: !isUnread })}>
                  {isUnread ? <MailOpen size={15} aria-hidden="true" /> : <Mail size={15} aria-hidden="true" />}
                </Button>
                <Button type="button" size="sm" variant="ghost" aria-label={saveLabel} title={saveLabel} aria-pressed={Boolean(state.saved)}
                  onClick={() => change(item, { saved: !state.saved })}><Bookmark size={15} aria-hidden="true" className={state.saved ? 'fill-current text-accent-ink' : undefined} /></Button>
              </> : null}
              <Button type="button" size="sm" variant="ghost" aria-label={archiveLabel} title={archiveLabel}
                onClick={() => change(item, { archived: !state.archived, unread: false })}>
                {state.archived ? <ArchiveRestore size={15} aria-hidden="true" /> : <Archive size={15} aria-hidden="true" />}
              </Button>
            </div>
          </li>;
        })}
      </ul>}
  </div>;
}
