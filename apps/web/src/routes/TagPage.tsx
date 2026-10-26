import type { MembershipDto, ProjectDto, TagDto, TaskDto } from '@workloom/contracts';
import { Badge, Button, Skeleton, StateCard, TextInput, inputClassName } from '@workloom/ui';
import { Tags } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useSectionsQuery, useStatusesQuery } from '../features/projects/queries';
import { useTagProjectsQuery, useTagTasksQuery } from '../features/tags/queries';
import { TagSettingsDialog } from '../features/tags/TagSettingsDialog';
import { TaskTable } from '../features/task-table/TaskTable';
import { TagBadge } from '../features/tasks/TagBadge';
import { useTagsQuery } from '../features/tasks/queries';
import { useMembershipsQuery } from '../features/workspace/queries';
import { WorkspaceLink as Link, useWorkspaceNavigate } from '../features/workspace/WorkspaceNavigation';
import { useTranslation } from '../i18n';
import { isUuid } from '../lib/format';
import { useCurrentSearchParams } from '../lib/useCurrentSearchParams';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

export function TagPage() {
  const { actorId, workspace } = useWorkspaceContext();
  const { tagId = '' } = useParams();
  return <TagContent key={`${actorId}:${workspace.id}:${tagId}`} tagId={tagId.toLowerCase()} />;
}

function TagContent({ tagId }: { tagId: string }) {
  const { t } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  const tags = useTagsQuery(actorId, workspace.id);
  const tag = tags.data?.find(value => value.id === tagId);
  const [editing, setEditing] = useState<TagDto | null>(null);
  const canEdit = workspace.role === 'owner' || workspace.role === 'admin';
  useDocumentTitle(tags.isSuccess && tag ? tag.name : t('tags.title'));
  return <div className="space-y-4">
    <Link to={`/w/${workspace.id}/tags`} className="text-sm font-medium text-accent-ink hover:underline">{t('tags.back')}</Link>
    {tags.isError ? <QueryErrorState subject="tags" error={tags.error} retrying={tags.isFetching} onRetry={() => void tags.refetch()} />
      : tags.isPending ? <Loading />
      : !isUuid(tagId) || !tag ? <StateCard icon={<Tags size={18} />} title={t('tags.unavailable')} description={t('tags.unavailableHelp')} />
      : <>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2"><h1 className="text-2xl font-semibold text-ink">{tag.name}</h1>
            <div className="flex flex-wrap items-center gap-2"><TagBadge tag={tag} /><Badge tone="muted">{tag.archivedAt === null ? t('tags.active') : t('routes.archived')}</Badge></div>
            <p className="text-sm text-muted">{tag.archivedAt === null ? t('tags.tasksHelp') : t('tags.archiveHelp')}</p>
          </div>
          {canEdit ? <Button onClick={() => setEditing(tag)}>{t('tags.settings')}</Button> : null}
        </header>
        <TagTasks tag={tag} />
      </>}
    <TagSettingsDialog actorId={actorId} workspaceId={workspace.id} tag={editing} canEdit={canEdit && tags.isSuccess} onClose={() => setEditing(null)} />
  </div>;
}

function Loading() {
  const { t } = useTranslation();
  return <div role="status"><span className="sr-only">{t('tags.loading')}</span><Skeleton className="h-24" /></div>;
}

function TagTasks({ tag }: { tag: TagDto }) {
  const { t, locale } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  const projects = useTagProjectsQuery(actorId, workspace.id);
  const members = useMembershipsQuery(actorId, workspace.id);
  const [params, update] = useCurrentSearchParams();
  const projectId = params.get('project') ?? '';
  const search = (params.get('search') ?? '').trim().slice(0, 200);
  const openOnly = params.get('completion') === 'open';
  const includeArchived = params.get('archived') === '1';
  const ordered = [...(projects.data?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name, locale, { numeric: true }) || a.id.localeCompare(b.id));
  // IDs have a stable scan order even if another person renames a project while pages load.
  const projectIds = ordered.filter(project => !projectId || project.id === projectId).map(project => project.id).sort();
  const enabled = projects.isSuccess && members.isSuccess;
  const tasks = useTagTasksQuery(actorId, workspace.id, tag.id, projectIds, { search, openOnly, includeArchived }, enabled);
  const rows = [...new Map((tasks.data?.pages.flatMap(page => page.tasks) ?? []).map(task => [task.id, task])).values()];
  const emptyBatch = tasks.data?.pages.at(-1)?.tasks.length === 0;
  const { hasNextPage, isFetching, isError, fetchNextPage } = tasks;
  // Skip batches of empty projects; an empty result is only final after every project was checked.
  useEffect(() => {
    if (enabled && emptyBatch && hasNextPage && !isFetching && !isError) void fetchNextPage();
  }, [enabled, emptyBatch, hasNextPage, isFetching, isError, fetchNextPage]);
  const setFilter = (key: string, value: string) => update(before => { if (value) before.set(key, value); else before.delete(key); return before; });
  if (projects.isError) return <QueryErrorState subject="projects" error={projects.error} retrying={projects.isFetching} onRetry={() => void projects.refetch()} />;
  if (members.isError) return <QueryErrorState subject="members" error={members.error} retrying={members.isFetching} onRetry={() => void members.refetch()} />;
  if (projects.isPending || members.isPending) return <Loading />;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-3">
      <form key={search} className="flex min-w-56 flex-1 items-end gap-2" onSubmit={event => { event.preventDefault(); setFilter('search', String(new FormData(event.currentTarget).get('search') ?? '').trim()); }}>
        <label className="flex-1 space-y-1 text-sm"><span>{t('tags.searchTasks')}</span><TextInput name="search" type="search" defaultValue={search} maxLength={200} /></label>
        <Button type="submit">{t('tags.searchAction')}</Button>
      </form>
      <label className="space-y-1 text-sm"><span>{t('tags.project')}</span><select className={inputClassName()} value={projectId} onChange={event => setFilter('project', event.target.value)}>
        <option value="">{t('tags.allProjects')}</option>
        {projectId && !ordered.some(project => project.id === projectId) ? <option value={projectId}>{t('tags.projectUnavailable')}</option> : null}
        {ordered.map(project => <option key={project.id} value={project.id}>{project.name}{project.archivedAt ? ` (${t('routes.archived')})` : ''}</option>)}
      </select></label>
      <label className="flex items-center gap-2 py-2 text-sm"><input type="checkbox" checked={openOnly} onChange={event => setFilter('completion', event.target.checked ? 'open' : '')} />{t('tags.openOnly')}</label>
      <label className="flex items-center gap-2 py-2 text-sm"><input type="checkbox" checked={includeArchived} onChange={event => setFilter('archived', event.target.checked ? '1' : '')} />{t('tags.includeArchived')}</label>
    </div>
    {projects.data.nextCursor !== null ? <p role="status" className="text-sm text-muted">{t('tags.partialProjects')}</p> : null}
    {tasks.isError ? <QueryErrorState subject="tasks" error={tasks.error} retrying={tasks.isFetching} onRetry={() => void tasks.refetch()} />
      : tasks.isPending || (rows.length === 0 && tasks.hasNextPage) ? <Loading />
      : rows.length === 0 ? <StateCard icon={<Tags size={18} />} title={t('tags.noTasks')} description={t('tags.noTasksHelp')} />
      : <>
        <p role="status" className="text-sm text-muted">{t('tags.loadedTasks', { count: rows.length })}</p>
        {ordered.map(project => {
          const projectTasks = rows.filter(task => task.projectId === project.id);
          return projectTasks.length ? <ProjectTasks key={project.id} project={project} tasks={projectTasks} members={members.data} /> : null;
        })}
      </>}
    {!tasks.isError && tasks.hasNextPage && rows.length > 0 ? <Button disabled={tasks.isFetching} onClick={() => void tasks.fetchNextPage()}>{tasks.isFetching ? t('tags.loading') : t('tags.loadMore')}</Button> : null}
  </div>;
}

function ProjectTasks({ project, tasks, members }: { project: ProjectDto; tasks: TaskDto[]; members: MembershipDto[] }) {
  const { actorId, workspace } = useWorkspaceContext();
  const { t } = useTranslation();
  const navigate = useWorkspaceNavigate();
  const statuses = useStatusesQuery(actorId, workspace.id, project.id);
  const sections = useSectionsQuery(actorId, workspace.id, project.id);
  return <section className="space-y-2" aria-label={project.name}>
    <h2 className="flex items-center gap-2 text-lg font-semibold"><Link to={`/w/${workspace.id}/projects/${project.id}`} className="text-accent-ink hover:underline">{project.name}</Link>
      {project.archivedAt ? <Badge tone="muted">{t('routes.archived')}</Badge> : null}
    </h2>
    {statuses.isError ? <QueryErrorState subject="tasks" error={statuses.error} retrying={statuses.isFetching} onRetry={() => void statuses.refetch()} />
      : sections.isError ? <QueryErrorState subject="tasks" error={sections.error} retrying={sections.isFetching} onRetry={() => void sections.refetch()} />
      : statuses.isPending || sections.isPending ? <Loading />
      : <TaskTable tasks={tasks} sections={sections.data} statuses={statuses.data} members={members} caption={t('tags.projectTasks', { name: project.name })}
        layoutScope={{ actorId, workspaceId: workspace.id, projectId: project.id }}
        partial showLegacySummary={false} columnPreset="expanded"
        onOpenTask={id => void navigate(`/w/${workspace.id}/projects/${project.id}?task=${id}`)}
        onCreateTask={() => undefined} onCreateChild={() => undefined} />}
  </section>;
}
