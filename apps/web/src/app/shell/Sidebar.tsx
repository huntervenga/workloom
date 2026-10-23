import { WorkspaceLink as Link, WorkspaceNavLink as NavLink, useCanonicalWorkspaceTo } from '../../features/workspace/WorkspaceNavigation';
import { t, useTranslation } from '../../i18n';
import type { MeDto } from '@workloom/contracts';
import { Logomark, Skeleton, cn } from '@workloom/ui';
import { BarChart3, Bell, CalendarDays, CheckCheck, Folder, FolderKanban, LayoutDashboard, RefreshCw, Users } from 'lucide-react';
import { useLocation } from 'react-router';
import { useProjectsQuery } from '../../features/projects/queries';
import type { WorkspaceRole } from '../../features/workspace/roles';
import { WorkspaceChooser } from '../../features/workspace/WorkspaceChooser';
import { useInboxQuery } from '../../features/inbox/queries';
import { unreadItems, useSeenAt } from '../../features/inbox/seen';
import { LocalModeCard } from './LocalModeCard';

export interface SidebarContentProps {
  me: MeDto;
  workspaceId: string | null;
  role: WorkspaceRole | null;
  onNavigate?: (() => void) | undefined;
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
    isActive ? 'bg-accent-soft text-accent-ink' : 'text-ink-soft hover:bg-slate-100 hover:text-ink',
  );

const projectLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
    isActive ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-soft hover:bg-slate-100 hover:text-ink',
  );

/**
 * Active projects of the workspace, in server order. It shares the Projects page query and cache,
 * reads nothing else and never writes. A long list scrolls inside its own bounded area.
 */
/** Count of items newer than the bookmark; shown only when there is something and the read worked. */
function InboxBadge({ actorId, workspaceId }: { actorId: string; workspaceId: string }) {
  const { t } = useTranslation();
  const inbox = useInboxQuery(actorId, workspaceId);
  const seenAt = useSeenAt(actorId, workspaceId);
  const count = unreadItems(inbox.data ?? [], seenAt).length;
  if (count === 0) return null;
  return <span aria-label={t('inbox.badge', { count })} className="ml-auto rounded-full bg-accent px-1.5 text-xs font-medium text-white">{count > 99 ? '99+' : count}</span>;
}

const SIDEBAR_PROJECTS_SHOWN = 8;

function SidebarProjects({ actorId, workspaceId, onNavigate }: { actorId: string; workspaceId: string; onNavigate?: (() => void) | undefined }) {
  useTranslation();
  const projects = useProjectsQuery(actorId, workspaceId);
  const location = useLocation();
  const canonical = useCanonicalWorkspaceTo();
  // Newest period first (by project end date), undated ones after; only a handful are listed, the rest sit behind "All projects".
  const all = (projects.data?.projects.filter(project => project.archivedAt === null) ?? [])
    .map((project, index) => ({ project, index }))
    .sort((a, b) => (b.project.dateRange?.to ?? '').localeCompare(a.project.dateRange?.to ?? '') || a.index - b.index)
    .map(item => item.project);
  const active = all.slice(0, SIDEBAR_PROJECTS_SHOWN);
  return (
    <nav aria-label={t('shell.activeProjects')}>
      <p aria-hidden="true" className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">{t('shell.activeProjects')}</p>
      {projects.isPending ? (
        <div role="status" className="space-y-1.5 px-2.5">
          <span className="sr-only">{t('shell.loadingProjects')}</span>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-28" />
        </div>
      ) : projects.isError ? (
        // Errors win over cached rows, so a denied refetch hides the list. The page itself shows details.
        <div className="space-y-1 px-2.5 text-xs text-muted">
          <p>{t('shell.projectsUnavailable')}</p>
          <button type="button" onClick={() => void projects.refetch()} disabled={projects.isFetching} className="inline-flex items-center gap-1 rounded font-medium text-accent-strong hover:underline disabled:text-muted disabled:no-underline">
            <RefreshCw size={12} aria-hidden="true" className={projects.isFetching ? 'motion-safe:animate-spin' : undefined} />
            {t('shell.retryProjects')}
          </button>
        </div>
      ) : active.length === 0 ? (
        <p className="px-2.5 text-xs text-muted">{t('shell.noActiveProjects')}</p>
      ) : (
        <ul data-sidebar-projects="" className="space-y-0.5">
          {active.map(project => {
            const pathname = canonical(`/w/${workspaceId}/projects/${project.id}`) as string;
            // On this project's own task page the link keeps the current filters, week, person,
            // view and open task, and a plain click changes nothing. Other pages open it clean.
            const here = location.pathname.replace(/\/$/, '').toLowerCase() === pathname.toLowerCase();
            return (
              <li key={project.id}>
                <NavLink to={here ? { pathname: location.pathname, search: location.search, hash: location.hash } : pathname} className={projectLinkClass}
                  onClick={event => {
                    if (here && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) event.preventDefault();
                    onNavigate?.();
                  }}>
                  <Folder size={16} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 truncate" title={project.name}>{project.name}</span>
                </NavLink>
              </li>
            );
          })}
          {all.length > active.length ? <li><NavLink to={canonical(`/w/${workspaceId}/projects`) as string} end className="block rounded-md px-2.5 py-1.5 text-sm font-medium text-accent-ink hover:bg-canvas" onClick={() => onNavigate?.()}>{t('shell.allProjectsCount', { count: all.length })}</NavLink></li> : null}
        </ul>
      )}
    </nav>
  );
}

export function SidebarContent({ me, workspaceId, role, onNavigate }: SidebarContentProps) {
  useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center px-5">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 rounded-md">
          <Logomark className="size-7" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">{t('common.brand')}</span>
        </Link>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-2 pb-4">
        <WorkspaceChooser actorId={me.actor.id} workspaceId={workspaceId} onNavigate={onNavigate} />

        <nav aria-label={t('shell.sections')}>
          <p className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">{t('shell.sections')}</p>
          <ul className="space-y-0.5">
            {workspaceId ? (
              <>
                <li>
                  <NavLink to={`/w/${workspaceId}`} end className={navLinkClass} onClick={onNavigate}>
                    <LayoutDashboard size={18} aria-hidden="true" />

                    {t('shell.overview')}
                  </NavLink>
                </li>
                <li>
                  <NavLink to={`/w/${workspaceId}/inbox`} className={navLinkClass} onClick={onNavigate}>
                    <Bell size={18} aria-hidden="true" />
                    {t('inbox.nav')}
                    <InboxBadge actorId={me.actor.id} workspaceId={workspaceId} />
                  </NavLink>
                </li>
                <li>
                  <NavLink to={`/w/${workspaceId}/my-tasks`} className={navLinkClass} onClick={onNavigate}>
                    <CheckCheck size={18} aria-hidden="true" />
                    {t('myTasks.title')}
                  </NavLink>
                </li>
                <li>
                  {/* Exact: on a project page only that project's entry below is current. */}
                  <NavLink to={`/w/${workspaceId}/projects`} end className={navLinkClass} onClick={onNavigate}>
                    <FolderKanban size={18} aria-hidden="true" />

                    {t('routes.projects')}
                  </NavLink>
                </li>
                <li>
                  <NavLink to={`/w/${workspaceId}/reports`} className={navLinkClass} onClick={onNavigate}>
                    <BarChart3 size={18} aria-hidden="true" />
                    {t('workspaceReports.title')}
                  </NavLink>
                </li>
                <li>
                  <NavLink to={`/w/${workspaceId}/time-off`} className={navLinkClass} onClick={onNavigate}>
                    <CalendarDays size={18} aria-hidden="true" />
                    {t('timeOff.title')}
                  </NavLink>
                </li>
                <li>
                  <NavLink to={`/w/${workspaceId}/members`} className={navLinkClass} onClick={onNavigate}>
                    <Users size={18} aria-hidden="true" />

                    {t('routes.members')}
                  </NavLink>
                </li>
              </>
            ) : (
              <li className="px-2.5 py-2 text-xs text-muted">{t('shell.chooseWorkspaceHelp')}</li>
            )}
          </ul>
        </nav>

        {/* Only for a workspace the current actor has opened; its role is known from that read. */}
        {workspaceId && role ? <SidebarProjects actorId={me.actor.id} workspaceId={workspaceId} onNavigate={onNavigate} /> : null}

        <div className="mt-auto">
          {me.authMode === 'shared' ? null : (            <LocalModeCard me={me} role={role} />
          )}
        </div>
      </div>
    </div>
  );
}
