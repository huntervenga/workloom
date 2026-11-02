import { Button, Skeleton, StateCard } from '@workloom/ui';
import { Archive, ArrowLeft, Trash2 } from 'lucide-react';
import { useTranslation } from '../i18n';
import { ArchiveProjectButton, DeleteProjectDialog } from '../features/projects/ProjectArchive';
import { useArchivedProjectsQuery } from '../features/projects/queries';
import { WorkspaceLink as Link } from '../features/workspace/WorkspaceNavigation';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

export function ArchivedProjectsPage() {
  const { t, formatDate } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  const projects = useArchivedProjectsQuery(actorId, workspace.id);
  const canEdit = workspace.role !== 'viewer';
  const canDelete = workspace.role === 'owner' || workspace.role === 'admin';
  useDocumentTitle(t('projects.archive.pageTitle'));
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link to={`/w/${workspace.id}/projects`} className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted hover:text-accent-strong">
          <ArrowLeft size={16} aria-hidden="true" />{t('projects.archive.back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem]">{t('projects.archive.pageTitle')}</h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-muted">{t('projects.archive.summary')}</p>
        {canEdit && !canDelete ? <p className="text-sm text-muted">{t('projects.archive.ownerOnlyHint')}</p> : null}
      </header>
      {projects.isPending ? (
        <div role="status" className="space-y-px overflow-hidden rounded-2xl border border-line bg-surface">
          <span className="sr-only">{t('projects.archive.loading')}</span>
          {[0, 1].map(row => <div key={row} className="px-4 py-3.5"><Skeleton className="h-4 w-48" /></div>)}
        </div>
      ) : projects.isError ? (
        <QueryErrorState error={projects.error} subject="projects" retrying={projects.isFetching} onRetry={() => void projects.refetch()} />
      ) : projects.data.length === 0 ? (
        <StateCard icon={<Archive size={18} aria-hidden="true" />} title={t('projects.archive.empty')} description={t('projects.archive.emptyHelp')} />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {projects.data.map(project => (
            <li key={project.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link to={`/w/${workspace.id}/projects/${project.id}`} className="block truncate font-medium text-ink hover:underline" title={project.name}>{project.name}</Link>
                {project.archivedAt ? <p className="text-xs text-muted">{t('projects.archive.archivedOn')} <time dateTime={project.archivedAt}>{formatDate(project.archivedAt, { dateStyle: 'medium', timeZone: workspace.timezone })}</time></p> : null}
              </div>
              {canEdit ? <ArchiveProjectButton actorId={actorId} workspaceId={workspace.id} project={project} /> : null}
              {canDelete ? <DeleteProjectDialog actorId={actorId} workspaceId={workspace.id} project={project}
                trigger={<Button size="sm" variant="ghost"><Trash2 size={16} aria-hidden="true" />{t('projects.archive.delete')}</Button>} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
