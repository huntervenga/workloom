import { t, useTranslation } from '../i18n';
import type { UseQueryResult } from '@tanstack/react-query';
import type { MembershipDto } from '@workloom/contracts';
import { Badge, Skeleton } from '@workloom/ui';
import { ArrowRight, Clock, FolderKanban, ShieldCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ProjectList } from '../features/projects/api';
import { orderProjects } from '../features/projects/order';
import { useProjectsQuery } from '../features/projects/queries';
import { MemberIdentity } from '../features/workspace/MemberIdentity';
import { useMembershipsQuery } from '../features/workspace/queries';
import { RoleBadge, roleLabels } from '../features/workspace/roles';
import { formatMemberCount, formatUtcOffset } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

const PREVIEW_SIZE = 5;

export function OverviewPage() {
  useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  const members = useMembershipsQuery(actorId, workspace.id);
  const projects = useProjectsQuery(actorId, workspace.id);
  const offset = formatUtcOffset(workspace.timezone);
  useDocumentTitle(t('routes.overviewTitle', { workspace: workspace.name }));

  return (
    <div className="space-y-6">
      <header className="space-y-2.5">
        <p className="text-xs font-semibold tracking-[0.08em] text-accent-ink uppercase">{t('routes.workspace')}</p>
        <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] text-ink sm:text-[1.75rem]">
          {workspace.name}
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-muted">

          {t('routes.overviewDescription')}
        </p>
      </header>

      <Link to={`/w/${workspace.id}/integrations`} className="inline-flex rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-accent-ink">{t('routes.integrations')}</Link>

      <dl className="grid gap-3 sm:grid-cols-3">
        <DetailTile icon={<Clock size={16} aria-hidden="true" />} label={t('routes.timezone')}>
          <span className="[overflow-wrap:anywhere]">{workspace.timezone}</span>
          {offset ? <span className="ml-1.5 text-sm font-normal text-muted">{offset}</span> : null}
        </DetailTile>
        <DetailTile icon={<ShieldCheck size={16} aria-hidden="true" />} label={t('routes.yourRole')}>
          {roleLabels[workspace.role]}
        </DetailTile>
        <DetailTile icon={<Users size={16} aria-hidden="true" />} label={t('routes.team')}>
          <MemberCount members={members} />
        </DetailTile>
      </dl>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <ProjectsPreview projects={projects} workspaceId={workspace.id} />
        <MembersPreview members={members} actorId={actorId} workspaceId={workspace.id} />
      </div>
    </div>
  );
}

function DetailTile({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  useTranslation();
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface px-4 py-3.5">
      <dt className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <span className="text-subtle">{icon}</span>
        {label}
      </dt>
      <dd className="mt-1.5 text-[15px] font-semibold text-ink">{children}</dd>
    </div>
  );
}

function MemberCount({ members }: { members: UseQueryResult<MembershipDto[]> }) {
  useTranslation();
  if (members.isPending) {
    return (
      <>
        <span className="sr-only">{t('routes.loading')}</span>
        <Skeleton className="h-5 w-24" />
      </>
    );
  }
  if (members.isError) return <span className="text-sm font-normal text-muted">{t('routes.noData')}</span>;
  return <>{formatMemberCount(members.data.length)}</>;
}

interface ProjectsPreviewProps {
  projects: UseQueryResult<ProjectList>;
  workspaceId: string;
}

function ProjectsPreview({ projects, workspaceId }: ProjectsPreviewProps) {
  useTranslation();
  const list = projects.isSuccess ? projects.data : null;
  const count = list ? list.projects.length : 0;
  // The P1a list is never paged, but a partial answer is labelled rather than shown as a total.
  const countLabel = list ? (list.nextCursor === null ? String(count) : t('routes.loadedCount', { count })) : null;

  return (
    <section aria-labelledby="projects-preview-heading" className="flex flex-col rounded-2xl border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 id="projects-preview-heading" className="text-sm font-semibold text-ink">

          {t('routes.projects')}
        </h2>
        {countLabel ? <Badge>{countLabel}</Badge> : null}
      </div>

      <div className="flex-1 p-2">
        {projects.isPending ? (
          <div role="status" className="space-y-1 p-1">
            <span className="sr-only">{t('routes.loadingProjects')}</span>
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3 px-2 py-2">
                <Skeleton className="size-8 rounded-lg" />
                <Skeleton className="h-4 w-44" />
              </div>
            ))}
          </div>
        ) : projects.isError ? (
          <QueryErrorState
            error={projects.error}
            subject="projects"
            headingLevel={3}
            className="border-0 px-3 py-6"
            retrying={projects.isFetching}
            onRetry={() => void projects.refetch()}
          />
        ) : count === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">{t('routes.workspaceNoProjects')}</p>
        ) : (
          <ul>
            {orderProjects(projects.data.projects)
              .slice(0, PREVIEW_SIZE)
              .map((project) => (
                <li key={project.id}>
                  <Link
                    to={`/w/${workspaceId}/projects/${project.id}`}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-canvas"
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
                    {project.archivedAt ? <Badge tone="muted">{t('routes.archived')}</Badge> : null}
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line px-5 py-3">
        <Link
          to={`/w/${workspaceId}/projects`}
          className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent-ink hover:text-accent-strong"
        >
          {list && count > PREVIEW_SIZE && list.nextCursor === null ? t('routes.allProjectsCount', { count }) : t('routes.allProjects')}
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}

interface MembersPreviewProps {
  members: UseQueryResult<MembershipDto[]>;
  actorId: string;
  workspaceId: string;
}

function MembersPreview({ members, actorId, workspaceId }: MembersPreviewProps) {
  useTranslation();
  return (
    <section aria-labelledby="members-preview-heading" className="flex flex-col rounded-2xl border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 id="members-preview-heading" className="text-sm font-semibold text-ink">

          {t('routes.members')}
        </h2>
        {members.isSuccess ? <Badge>{members.data.length}</Badge> : null}
      </div>

      <div className="flex-1 p-2">
        {members.isPending ? (
          <div role="status" className="space-y-1 p-1">
            <span className="sr-only">{t('routes.loadingMembers')}</span>
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3 px-2 py-2">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-4 w-36" />
              </div>
            ))}
          </div>
        ) : members.isError ? (
          <QueryErrorState
            error={members.error}
            subject="members"
            headingLevel={3}
            className="border-0 px-3 py-6"
            retrying={members.isFetching}
            onRetry={() => void members.refetch()}
          />
        ) : members.data.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">{t('routes.workspaceNoMembers')}</p>
        ) : (
          <ul>
            {members.data.slice(0, PREVIEW_SIZE).map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2">
                <MemberIdentity member={member} isCurrent={member.userId === actorId} />
                <span className="hidden sm:inline-flex xl:hidden 2xl:inline-flex">
                  <RoleBadge role={member.role} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line px-5 py-3">
        <Link
          to={`/w/${workspaceId}/members`}
          className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent-ink hover:text-accent-strong"
        >
          {members.isSuccess && members.data.length > PREVIEW_SIZE
            ? t('routes.allMembersCount', { count: members.data.length })
            : t('routes.allMembers')}
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
