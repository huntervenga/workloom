import type { MeDto } from '@workloom/contracts';
import { Logomark, cn } from '@workloom/ui';
import { FolderKanban, LayoutDashboard, Users } from 'lucide-react';
import { Link, NavLink } from 'react-router';
import type { WorkspaceRole } from '../../features/workspace/roles';
import { WorkspaceChooser } from '../../features/workspace/WorkspaceChooser';
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

export function SidebarContent({ me, workspaceId, role, onNavigate }: SidebarContentProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center px-5">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 rounded-md">
          <Logomark className="size-7" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">Workloom</span>
        </Link>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 pt-2 pb-4">
        <WorkspaceChooser actorId={me.actor.id} workspaceId={workspaceId} onNavigate={onNavigate} />

        <nav aria-label="Разделы">
          <p className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">Разделы</p>
          <ul className="space-y-0.5">
            {workspaceId ? (
              <>
                <li>
                  <NavLink to={`/w/${workspaceId}`} end className={navLinkClass} onClick={onNavigate}>
                    <LayoutDashboard size={18} aria-hidden="true" />
                    Обзор
                  </NavLink>
                </li>
                <li>
                  <NavLink to={`/w/${workspaceId}/projects`} className={navLinkClass} onClick={onNavigate}>
                    <FolderKanban size={18} aria-hidden="true" />
                    Проекты
                  </NavLink>
                </li>
                <li>
                  <NavLink to={`/w/${workspaceId}/members`} className={navLinkClass} onClick={onNavigate}>
                    <Users size={18} aria-hidden="true" />
                    Участники
                  </NavLink>
                </li>
              </>
            ) : (
              <li className="px-2.5 py-2 text-xs text-muted">Выберите пространство, чтобы открыть его разделы.</li>
            )}
          </ul>
        </nav>

        <div className="mt-auto">
          <LocalModeCard me={me} role={role} />
        </div>
      </div>
    </div>
  );
}
