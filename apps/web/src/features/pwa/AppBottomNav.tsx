import { useSyncExternalStore } from 'react';
import { cn } from '@workloom/ui';
import { installManager } from './install';
import { CheckCheck, FolderKanban, House, Inbox } from 'lucide-react';
import { WorkspaceNavLink as NavLink } from '../workspace/WorkspaceNavigation';
import { useTranslation } from '../../i18n';

/** Compact navigation for the installed mobile app; ordinary browser navigation stays in the drawer. */
export function AppBottomNav({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(installManager.subscribe, installManager.getSnapshot);
  if (!state.installed) return null;
  const base = `/w/${encodeURIComponent(workspaceId)}`;
  const itemClass = ({ isActive }: { isActive: boolean }) => cn('flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium', isActive ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-canvas hover:text-ink');
  return <nav className="pwa-bottom-nav" aria-label={t('pwa.navigation')}>
    <NavLink to={base} end className={itemClass}><House size={20} aria-hidden="true" /><span>{t('shell.overview')}</span></NavLink>
    <NavLink to={`${base}/my-tasks`} className={itemClass}><CheckCheck size={20} aria-hidden="true" /><span>{t('myTasks.title')}</span></NavLink>
    <NavLink to={`${base}/inbox`} className={itemClass}><Inbox size={20} aria-hidden="true" /><span>{t('inbox.title')}</span></NavLink>
    <NavLink to={`${base}/projects`} className={itemClass}><FolderKanban size={20} aria-hidden="true" /><span>{t('routes.projects')}</span></NavLink>
  </nav>;
}
