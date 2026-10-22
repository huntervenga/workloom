import { WorkspaceLink as Link } from '../features/workspace/WorkspaceNavigation';
import { useMyTasksLens } from '../features/my-tasks/navigation';
import { Badge, Button, Skeleton, StateCard, TextInput, inputClassName } from '@workloom/ui';
import { ArrowUpRight, CheckCheck, Inbox, RefreshCw, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { useTranslation } from '../i18n';
import { uniqueLoadedMyTasks } from '../features/my-tasks/api';
import { useMyTasksQuery } from '../features/my-tasks/queries';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

export function MyTasksPage() {
  const { actorId, workspace } = useWorkspaceContext();
  const { t, formatDate } = useTranslation();
  const lens = useMyTasksLens();
  const { filters } = lens;
  const appliedSearch = filters.search ?? '';
  const draftScope = { actorId, workspaceId: workspace.id, appliedSearch };
  const [searchDraft, setSearchDraft] = useState({ ...draftScope, value: appliedSearch });
  const sameDraftScope = searchDraft.actorId === actorId && searchDraft.workspaceId === workspace.id && searchDraft.appliedSearch === appliedSearch;
  // A changed applied lens replaces its search draft without remounting/focusing the input.
  // Other filter changes leave local typing intact, including when navigation is blocked.
  if (!sameDraftScope) setSearchDraft({ ...draftScope, value: appliedSearch });
  const search = sameDraftScope ? searchDraft.value : appliedSearch;
  const query = useMyTasksQuery(actorId, workspace.id, filters);
  const items = query.isError ? [] : uniqueLoadedMyTasks(query.data?.pages ?? []);
  useDocumentTitle(t('myTasks.documentTitle', { workspace: workspace.name }));
  const applySearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('search');
    if (typeof value !== 'string') return;
    lens.applySearch(value);
  };
  // Nothing narrowed the list, so an empty result means the person simply has no open work yet.
  const untouched = filters.relation === 'all' && filters.completion === 'open' && !filters.includeArchived && search.trim() === '';
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight text-ink">{t('myTasks.title')}</h1><p className="mt-1 text-sm text-muted">{t('myTasks.description')}</p></div>
        <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} aria-hidden="true" />{t('myTasks.refresh')}</Button>
      </header>
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="min-w-36 flex-1 space-y-1 text-xs font-medium text-muted"><span>{t('myTasks.relationLabel')}</span><select className={inputClassName()} value={filters.relation} onChange={event => lens.changeRelation(event.target.value)}><option value="all">{t('myTasks.relationAll')}</option><option value="assigned">{t('myTasks.relationAssigned')}</option><option value="participating">{t('myTasks.relationParticipating')}</option></select></label>
        <label className="min-w-36 flex-1 space-y-1 text-xs font-medium text-muted"><span>{t('myTasks.completionLabel')}</span><select className={inputClassName()} value={filters.completion} onChange={event => lens.changeCompletion(event.target.value)}><option value="open">{t('myTasks.open')}</option><option value="closed">{t('myTasks.closed')}</option><option value="all">{t('myTasks.allCompletion')}</option></select></label>
        <form onSubmit={applySearch} className="flex min-w-52 flex-[2] items-end gap-2"><label className="min-w-0 flex-1 space-y-1 text-xs font-medium text-muted"><span>{t('myTasks.searchLabel')}</span><TextInput name="search" value={search} maxLength={200} placeholder={t('myTasks.searchPlaceholder')} onChange={event => setSearchDraft({ ...draftScope, value: event.target.value })} /></label><Button type="submit" size="sm" aria-label={t('myTasks.searchAction')}><Search size={16} aria-hidden="true" /></Button></form>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <p role="status">{query.isError ? t('myTasks.errorStatus') : query.isPending ? t('myTasks.loading') : t('myTasks.loadedCount', { count: items.length })}</p>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={filters.includeArchived} onChange={event => lens.changeArchived(event.target.checked)} />{t('myTasks.includeArchived')}</label>
      </div>
      {query.isError ? <QueryErrorState error={query.error} subject="tasks" retrying={query.isFetching} onRetry={() => void query.refetch()} /> : query.isPending ? <div aria-label={t('myTasks.loading')} className="space-y-2 rounded-xl border border-line bg-surface p-4">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-10 w-full" />)}</div> : items.length === 0 ? <StateCard icon={<Inbox size={18} aria-hidden="true" />} title={untouched ? t('myTasks.nothingAssignedTitle') : t('myTasks.emptyTitle')} description={untouched ? t('myTasks.nothingAssignedDescription') : t('myTasks.emptyDescription')} /> : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_10rem_9rem_7rem] gap-3 border-b border-line bg-canvas/70 px-4 py-2 text-xs font-medium text-muted md:grid"><span>{t('myTasks.taskColumn')}</span><span>{t('myTasks.projectColumn')}</span><span>{t('myTasks.statusColumn')}</span><span>{t('myTasks.dueColumn')}</span></div>
          <ul aria-label={t('myTasks.listLabel')} className="divide-y divide-line">
            {items.map(row => <li key={row.task.id}><Link to={`/w/${workspace.id}/projects/${row.task.projectId}?task=${row.task.id}`} aria-label={t('myTasks.openTask', { title: row.task.title })} className="grid min-w-0 gap-1.5 px-4 py-3 transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent md:grid-cols-[minmax(0,1fr)_10rem_9rem_7rem] md:items-center md:gap-3"><div className="flex min-w-0 items-start gap-2"><CheckCheck size={16} aria-hidden="true" className={row.status.group === 'done' || row.status.group === 'cancelled' ? 'mt-0.5 shrink-0 text-emerald-600' : 'mt-0.5 shrink-0 text-subtle'} /><span className="min-w-0 flex-1 break-words text-sm font-medium text-ink">{row.task.title}</span><ArrowUpRight size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-subtle md:hidden" /></div><span className="truncate pl-6 text-xs text-muted md:pl-0" title={row.project.name}>{row.project.name}</span><span className="flex flex-wrap items-center gap-1.5 pl-6 md:pl-0"><Badge tone={row.status.group === 'done' ? 'accent' : 'neutral'}>{row.status.name}</Badge>{row.task.archivedAt || row.project.archivedAt ? <Badge tone="muted">{t('myTasks.archived')}</Badge> : null}</span><span className="pl-6 text-xs text-muted md:pl-0">{row.task.dueDate ? formatDate(row.task.dueDate, { month: 'short', day: 'numeric', year: 'numeric' }) : t('myTasks.noDueDate')}</span></Link></li>)}
          </ul>
        </div>
      )}
      {query.hasNextPage && !query.isError ? <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? t('myTasks.loadingMore') : t('myTasks.loadMore')}</Button> : null}
    </div>
  );
}
