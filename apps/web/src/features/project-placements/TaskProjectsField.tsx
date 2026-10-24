import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import type { ProjectDto, TaskDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { useProjectsQuery } from '../projects/queries';
import { useProjectRules } from '../project-rules/queries';
import { useTaskPlacementsQuery, type PlacementCommands } from './queries';

export function TaskProjectsField({ actorId, task, homeProject, writable, commands }: { actorId: string; task: TaskDto; homeProject: ProjectDto; writable: boolean; commands: PlacementCommands }) {
  const { t } = useTranslation();
  const placements = useTaskPlacementsQuery(actorId, task.workspaceId, task.id);
  const projects = useProjectsQuery(actorId, task.workspaceId);
  const homeRules = useProjectRules(actorId, task.workspaceId, homeProject.id);
  const keepsOneProject = homeRules.data?.config.singleProject === true;
  const registry = protectedCommandsFor(useQueryClient());
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  // A denied/failed refetch hides retained membership metadata and disables all writes.
  const current = placements.isSuccess && !placements.isFetching && projects.isSuccess && !projects.isFetching;
  const blocked = !writable || task.visibility !== 'workspace' || task.archivedAt !== null || !current || commands.isError || commands.pendingCommand !== null || commands.uncertain !== null || commands.hasOtherProtectedCommands();
  const active = placements.isSuccess ? placements.data.filter(item => item.archivedAt === null && item.projectId !== homeProject.id) : [];
  const projectName = (id: string) => projects.isSuccess ? projects.data.projects.find(item => item.id === id)?.name ?? t('placements.unavailableProject') : t('placements.unavailableProject');
  const archived = placements.isSuccess ? placements.data.filter(item => item.archivedAt !== null && item.projectId !== homeProject.id) : [];
  const present = new Set([homeProject.id, ...active.map(item => item.projectId), ...archived.map(item => item.projectId)]);
  const choices = projects.isSuccess ? projects.data.projects.filter(item => item.archivedAt === null && !present.has(item.id)).map(item => ({ value: item.id, label: item.name })) : [];
  return <div className="min-w-0 space-y-2" aria-label={t('placements.projects')}>
    <div className="flex min-h-9 flex-wrap items-center gap-2"><span>{homeProject.name}</span><span className="rounded bg-canvas px-1.5 py-0.5 text-xs text-muted">{t('placements.home')}</span></div>
    {active.length > 0 ? <p role="note" data-multi-project-warning="" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">{t('placements.multiProjectWarning')}</p> : null}
    {active.map(item => <div key={item.id} className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate">{projectName(item.projectId)}</span><Button size="sm" variant="ghost" disabled={blocked} aria-label={t('placements.removeFrom', { p0: projectName(item.projectId) })} onClick={() => commands.mutate({ command: { kind: 'detach', placementId: item.id, input: { expectedRevision: item.revision } } })}>{t('placements.remove')}</Button></div>)}
    {archived.map(item => <Button key={item.id} size="sm" variant="ghost" disabled={blocked} onClick={() => commands.mutate({ command: { kind: 'restore', placementId: item.id, input: { expectedRevision: item.revision } } })}>{t('placements.restoreTo', { p0: projectName(item.projectId) })}</Button>)}
    {placements.isError || projects.isError ? <div className="space-y-1"><p role="status" className="text-xs text-muted">{t('placements.loadFailed')}</p><Button size="sm" variant="ghost" onClick={() => { void placements.refetch(); void projects.refetch(); }}>{t('placements.reload')}</Button></div> : null}
    {writable && !keepsOneProject && task.visibility === 'workspace' && task.meetingId === null && task.archivedAt === null ? <ChoicePicker compact searchable label={t('placements.add')} placeholder={t('placements.add')} value="" options={choices} disabled={blocked || choices.length === 0} onValueChange={projectId => {
      if (!blocked && choices.some(choice => choice.value === projectId)) commands.mutate({ command: { kind: 'attach', taskId: task.id, input: { projectId, expectedTaskRevision: task.revision } } });
    }} /> : null}
    <p className="text-xs text-muted">{keepsOneProject ? t('placements.oneProjectHint') : t('placements.sharedHint')}</p>
  </div>;
}
