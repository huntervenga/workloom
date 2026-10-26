import type { ProjectDto } from '@workloom/contracts';
import { Badge, Button } from '@workloom/ui';
import { ArrowDown, ArrowUp, ArrowUpDown, FolderKanban, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { WorkspaceLink as Link } from '../workspace/WorkspaceNavigation';
import { sortProjects, type ProjectSort, type ProjectSortField } from './order';
import { RenameProjectDialog } from './ProjectDialogs';

interface ProjectListTableProps {
  projects: readonly ProjectDto[];
  actorId: string;
  workspaceId: string;
  timeZone: string;
  canEdit: boolean;
  onRenamed: (project: ProjectDto) => void;
}

export function ProjectListTable({ projects, actorId, workspaceId, timeZone, canEdit, onRenamed }: ProjectListTableProps) {
  const { t, locale, formatDate } = useTranslation();
  const [sort, setSort] = useState<ProjectSort>({ field: 'name', direction: 'asc' });
  const columns: { field: ProjectSortField; label: string }[] = [
    { field: 'name', label: t('projects.list.name') },
    { field: 'createdAt', label: t('projects.list.created') },
    { field: 'updatedAt', label: t('projects.list.updated') },
    { field: 'startDate', label: t('projects.list.startDate') },
    { field: 'endDate', label: t('projects.list.endDate') },
    { field: 'status', label: t('projects.list.status') },
  ];
  const changeSort = (field: ProjectSortField) => setSort(current => ({
    field,
    direction: current.field === field
      ? current.direction === 'asc' ? 'desc' : 'asc'
      : field === 'createdAt' || field === 'updatedAt' ? 'desc' : 'asc',
  }));
  const timestamp = (value: string) => {
    const title = formatDate(value, { dateStyle: 'full', timeStyle: 'long', timeZone });
    return <time dateTime={value} title={title}>{formatDate(value, { dateStyle: 'medium', timeZone })}</time>;
  };
  const calendarDate = (value: string | undefined) => value
    ? <time dateTime={value}>{formatDate(value, { dateStyle: 'medium' })}</time>
    : <span className="text-subtle">{t('projects.list.notSet')}</span>;

  return (
    <div className="min-w-0 overflow-x-auto rounded-2xl border border-line bg-surface" role="region" aria-label={t('routes.projects')} tabIndex={0}>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('routes.projects')}</caption>
        <thead className="border-b border-line bg-canvas/70 text-xs text-muted">
          <tr>
            {columns.map(column => {
              const selected = sort.field === column.field;
              const Icon = selected ? sort.direction === 'asc' ? ArrowUp : ArrowDown : ArrowUpDown;
              return (
                <th key={column.field} scope="col" aria-sort={selected ? sort.direction === 'asc' ? 'ascending' : 'descending' : undefined}
                  className={column.field === 'name' ? 'w-full min-w-56 px-3 py-2 font-medium' : 'whitespace-nowrap px-3 py-2 font-medium'}>
                  <button type="button" onClick={() => changeSort(column.field)}
                    className="inline-flex min-h-8 items-center gap-1.5 rounded px-1 text-left outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
                    {column.label}<Icon size={14} aria-hidden="true" />
                  </button>
                </th>
              );
            })}
            {canEdit ? <th scope="col" className="px-3 py-2"><span className="sr-only">{t('projects.list.actions')}</span></th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {sortProjects(projects, sort, locale).map(project => (
            <tr key={project.id} className="hover:bg-canvas/40">
              <td className="px-3 py-2">
                <Link to={`/w/${workspaceId}/projects/${project.id}`}
                  className="flex items-center gap-3 rounded-lg px-1 py-1.5 outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-accent">
                  <span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
                    <FolderKanban size={16} />
                  </span>
                  <span className="max-w-sm truncate font-medium text-ink" title={project.name}>{project.name}</span>
                </Link>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-muted tabular-nums">{timestamp(project.createdAt)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-muted tabular-nums">{timestamp(project.updatedAt)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-muted tabular-nums">{calendarDate(project.dateRange?.from)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-muted tabular-nums">{calendarDate(project.dateRange?.to)}</td>
              <td className="whitespace-nowrap px-4 py-3">
                {project.archivedAt ? <Badge tone="muted">{t('routes.archived')}</Badge> : <span className="text-muted">{t('projects.list.active')}</span>}
              </td>
              {canEdit ? (
                <td className="px-3 py-2">
                  <RenameProjectDialog actorId={actorId} workspaceId={workspaceId} project={project} onRenamed={onRenamed}
                    trigger={<Button variant="ghost" size="sm" className="px-2" aria-label={t('routes.renameProject', { name: project.name })}>
                      <Pencil size={16} aria-hidden="true" />
                    </Button>} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
