import { AsanaImportButton } from '../features/asana-import/AsanaImportButton';
import { useTranslation } from '../i18n';
import { Button, Skeleton, StateCard } from '@workloom/ui';
import { Eye, FolderKanban, Plus } from 'lucide-react';
import { useState } from 'react';

import { ProjectListTable } from '../features/projects/ProjectListTable';
import { CreateProjectDialog } from '../features/projects/ProjectDialogs';
import { useProjectsQuery } from '../features/projects/queries';
import { formatProjectCount } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

export function ProjectsPage() {
  const { t } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  const projects = useProjectsQuery(actorId, workspace.id);
  const canEdit = workspace.role !== 'viewer';
  const [announcement, setAnnouncement] = useState<{ kind: 'created' | 'renamed'; name: string } | null>(null);
  useDocumentTitle(t('routes.projectsTitle', { workspace: workspace.name }));

  const createTrigger = (
    <Button variant="primary">
      <Plus size={16} aria-hidden="true" />

      {t('routes.newProject')}
    </Button>
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem]">{t('routes.projects')}</h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
            {projects.isSuccess
              ? projects.data.nextCursor === null
                ? t('routes.projectsSummary', { projects: formatProjectCount(projects.data.projects.length), workspace: workspace.name })
                : t('routes.projectsPartial', { projects: formatProjectCount(projects.data.projects.length) })
              : t('routes.projectsDescription')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AsanaImportButton actorId={actorId} workspaceId={workspace.id} isOwner={workspace.role === 'owner'} />
          {canEdit ? (
            <CreateProjectDialog
              actorId={actorId}
              workspaceId={workspace.id}
              trigger={createTrigger}
              onCreated={(project) => setAnnouncement({ kind: 'created', name: project.name })}
            />
          ) : null}
        </div>
      </header>

      {canEdit ? null : (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Eye size={16} aria-hidden="true" className="shrink-0 text-subtle" />

          {t('routes.viewerHelp')}
        </p>
      )}

      <p role="status" className="sr-only">
        {announcement ? t(announcement.kind === 'created' ? 'routes.projectCreated' : 'routes.projectRenamed', { name: announcement.name }) : ''}
      </p>

      {projects.isPending ? (
        <div role="status" className="space-y-px overflow-hidden rounded-2xl border border-line bg-surface">
          <span className="sr-only">{t('routes.loadingProjects')}</span>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
              <Skeleton className="size-8 rounded-lg" />
              <Skeleton className="h-4 w-48" />
            </div>
          ))}
        </div>
      ) : projects.isError ? (
        <QueryErrorState
          error={projects.error}
          subject="projects"
          retrying={projects.isFetching}
          onRetry={() => void projects.refetch()}
        />
      ) : projects.data.projects.length === 0 ? (
        <StateCard
          icon={<FolderKanban size={18} aria-hidden="true" />}
          title={t('routes.noProjects')}
          description={
            canEdit
              ? t('routes.createFirst')
              : t('routes.viewerNoProjects')
          }
        />
      ) : (
        <ProjectListTable projects={projects.data.projects} actorId={actorId} workspaceId={workspace.id}
          timeZone={workspace.timezone} canEdit={canEdit}
          onRenamed={project => setAnnouncement({ kind: 'renamed', name: project.name })} />
      )}
    </div>
  );
}
