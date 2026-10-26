import { Skeleton, TextInput, inputClassName } from '@workloom/ui';
import { CreateTagDialog } from '../features/tasks/TagDialogs';
import { useCreateTagMutation, useTagsQuery } from '../features/tasks/queries';
import { TagTable } from '../features/tags/TagTable';
import { useTranslation } from '../i18n';
import { useCurrentSearchParams } from '../lib/useCurrentSearchParams';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

export function TagsPage() {
  const { actorId, workspace } = useWorkspaceContext();
  return <TagCatalog key={actorId + ':' + workspace.id} />;
}

function TagCatalog() {
  const { actorId, workspace } = useWorkspaceContext();
  const { t, locale } = useTranslation();
  const tags = useTagsQuery(actorId, workspace.id);
  const create = useCreateTagMutation(actorId, workspace.id);
  const [params, update] = useCurrentSearchParams();
  const search = params.get('search') ?? '';
  const status = ['active', 'archived'].includes(params.get('status') ?? '') ? params.get('status') : 'all';
  const canEdit = workspace.role === 'owner' || workspace.role === 'admin';
  const visible = (tags.data ?? []).filter(tag =>
    (status === 'all' || (tag.archivedAt === null ? 'active' : 'archived') === status)
    && tag.name.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)))
    .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.name.localeCompare(b.name, locale, { numeric: true }));
  useDocumentTitle(t('tags.title'));
  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold text-ink">{t('tags.title')}</h1><p className="mt-1 text-sm text-muted">{t('tags.description')}</p></div>
      {canEdit ? <CreateTagDialog mutation={create} onCreated={() => undefined} /> : null}
    </header>
    <div className="flex flex-wrap gap-3">
      <label className="min-w-48 flex-1 space-y-1 text-sm"><span>{t('tags.search')}</span><TextInput type="search" value={search}
        onChange={event => { const value = event.target.value; update(before => { if (value) before.set('search', value); else before.delete('search'); return before; }, { replace: true }); }} /></label>
      <label className="space-y-1 text-sm"><span>{t('tags.status')}</span><select className={inputClassName()} value={status ?? 'all'} onChange={event => {
        const value = event.target.value; update(before => { if (value === 'all') before.delete('status'); else before.set('status', value); return before; });
      }}><option value="all">{t('tags.all')}</option><option value="active">{t('tags.active')}</option><option value="archived">{t('routes.archived')}</option></select></label>
    </div>
    {tags.isPending ? <div role="status"><span className="sr-only">{t('tasks.tagDialogs.loadingTags')}</span><Skeleton className="h-24" /></div>
      : tags.isError ? <QueryErrorState subject="tags" error={tags.error} retrying={tags.isFetching} onRetry={() => void tags.refetch()} />
      : null}
    <TagTable actorId={actorId} workspaceId={workspace.id} tags={tags.isSuccess ? visible : []} canEdit={canEdit && tags.isSuccess} ready={tags.isSuccess} />
  </div>;
}
