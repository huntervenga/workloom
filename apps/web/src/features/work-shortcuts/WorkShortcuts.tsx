import { useQueries } from '@tanstack/react-query';
import { Button, cn } from '@workloom/ui';
import { Star } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { queryKeys } from '../../lib/queryKeys';
import { fetchReport } from '../generic-reports/api';
import { useProjectsQuery } from '../projects/queries';
import { fetchTask } from '../tasks/api';
import { WorkspaceLink } from '../workspace/WorkspaceNavigation';
import { referenceKey, togglePinnedWork, useWorkShortcuts, type WorkReference } from './shortcuts';

export function FavoriteWorkButton({ actorId, workspaceId, target }: { actorId: string; workspaceId: string; target: WorkReference }) {
  const { t } = useTranslation();
  const { pinned } = useWorkShortcuts(actorId, workspaceId);
  const active = pinned.some(item => referenceKey(item) === referenceKey(target));
  const label = t(active ? 'quickJump.removeFavorite' : 'quickJump.addFavorite');
  return <Button type="button" size="sm" variant="ghost" aria-pressed={active} aria-label={label} title={label}
    onClick={() => togglePinnedWork(actorId, workspaceId, target)}>
    <Star size={16} aria-hidden="true" className={cn(active && 'fill-amber-400 text-amber-600')} />
  </Button>;
}

export function useShortcutItems(actorId: string, workspaceId: string, group: 'recent' | 'pinned', enabled = true) {
  const references = useWorkShortcuts(actorId, workspaceId)[group];
  const projects = useProjectsQuery(actorId, workspaceId);
  const details = useQueries({ queries: (enabled ? references : []).map(ref => ({
    queryKey: [...queryKeys.workspace(actorId, workspaceId), 'work-shortcut', ref.kind, ref.id],
    enabled: ref.kind !== 'project',
    retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (ref.kind === 'report') {
        const report = await fetchReport(workspaceId, ref.id, signal);
        return report.workspaceId === workspaceId && report.id === ref.id && report.archivedAt === null
          ? { label: report.name, projectId: report.projectId } : null;
      }
      const task = await fetchTask(workspaceId, ref.id, signal);
      return task.workspaceId === workspaceId && task.id === ref.id && task.archivedAt === null
        ? { label: task.title, projectId: task.projectId } : null;
    },
  })) });
  if (!enabled || !projects.isSuccess) return [];
  const catalog = projects.data.projects.filter(project => project.archivedAt === null);
  return references.flatMap((ref, index) => {
    const detail = details[index];
    const entity = detail?.isSuccess ? detail.data : null;
    const project = catalog.find(item => item.id === (ref.kind === 'project' ? ref.id : entity?.projectId));
    if (!project || ref.kind !== 'project' && !entity) return [];
    const base = `/w/${workspaceId}/projects/${project.id}`;
    const to = ref.kind === 'task' ? `${base}?task=${ref.id}` : ref.kind === 'report' ? `${base}/reports?report=${ref.id}` : base;
    return [{ key: referenceKey(ref), label: entity?.label ?? project.name, hint: project.name, to }];
  });
}

export function SidebarFavorites({ actorId, workspaceId, onNavigate }: { actorId: string; workspaceId: string; onNavigate?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const items = useShortcutItems(actorId, workspaceId, 'pinned');
  if (items.length === 0) return null;
  return <nav aria-label={t('quickJump.favorites')}>
    <p className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">{t('quickJump.favorites')}</p>
    <ul className="space-y-0.5">
      {items.map(item => <li key={item.key}>
        <WorkspaceLink className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink-soft hover:bg-canvas" to={item.to} onClick={onNavigate}>
          <Star size={14} className="shrink-0 text-muted" aria-hidden="true" /><span className="truncate">{item.label}</span>
        </WorkspaceLink>
      </li>)}
    </ul>
  </nav>;
}
