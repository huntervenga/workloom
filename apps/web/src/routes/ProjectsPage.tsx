import { Badge, Button, Skeleton, StateCard } from '@workloom/ui';
import { ChevronRight, Eye, FolderKanban, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { orderProjects } from '../features/projects/order';
import { CreateProjectDialog, RenameProjectDialog } from '../features/projects/ProjectDialogs';
import { useProjectsQuery } from '../features/projects/queries';
import { formatProjectCount } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

export function ProjectsPage() {
  const { actorId, workspace } = useWorkspaceContext();
  const projects = useProjectsQuery(actorId, workspace.id);
  const canEdit = workspace.role !== 'viewer';
  const [announcement, setAnnouncement] = useState('');
  useDocumentTitle(`Проекты · ${workspace.name}`);

  const createTrigger = (
    <Button variant="primary">
      <Plus size={16} aria-hidden="true" />
      Новый проект
    </Button>
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem]">Проекты</h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
            {projects.isSuccess
              ? projects.data.nextCursor === null
                ? `${formatProjectCount(projects.data.projects.length)} в пространстве «${workspace.name}».`
                : `Загружено ${formatProjectCount(projects.data.projects.length)} — это не весь список.`
              : 'Проекты пространства и их задачи.'}
          </p>
        </div>
        {canEdit ? (
          <CreateProjectDialog
            actorId={actorId}
            workspaceId={workspace.id}
            trigger={createTrigger}
            onCreated={(project) => setAnnouncement(`Проект «${project.name}» создан.`)}
          />
        ) : null}
      </header>

      {canEdit ? null : (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Eye size={16} aria-hidden="true" className="shrink-0 text-subtle" />
          Роль «Наблюдатель» позволяет только просматривать проекты.
        </p>
      )}

      <p role="status" className="sr-only">
        {announcement}
      </p>

      {projects.isPending ? (
        <div role="status" className="space-y-px overflow-hidden rounded-2xl border border-line bg-surface">
          <span className="sr-only">Загрузка проектов</span>
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
          title="Проектов пока нет"
          description={
            canEdit
              ? 'Создайте первый проект, чтобы собрать в нём задачи команды.'
              : 'Когда участники создадут проекты, они появятся здесь.'
          }
        />
      ) : (
        <ul aria-label="Проекты" className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {orderProjects(projects.data.projects).map((project) => (
            <li key={project.id} className="flex items-center gap-2 px-2 py-1.5 sm:px-3">
              <Link
                to={`/w/${workspace.id}/projects/${project.id}`}
                className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 hover:bg-canvas"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink"
                >
                  <FolderKanban size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={project.name}>
                  {project.name}
                </span>
                {project.archivedAt ? <Badge tone="muted">В архиве</Badge> : null}
                <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-subtle group-hover:text-muted" />
              </Link>
              {canEdit ? (
                <RenameProjectDialog
                  actorId={actorId}
                  workspaceId={workspace.id}
                  project={project}
                  onRenamed={(renamed) => setAnnouncement(`Проект переименован в «${renamed.name}».`)}
                  trigger={
                    <Button variant="ghost" size="sm" className="px-2" aria-label={`Переименовать проект «${project.name}»`}>
                      <Pencil size={16} aria-hidden="true" />
                    </Button>
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
