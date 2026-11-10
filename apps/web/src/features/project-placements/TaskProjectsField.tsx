import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore, type ReactNode } from 'react';
import { House, X } from 'lucide-react';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import type { ProjectDto, TaskDto, TaskProjectPlacementDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { useProjectsQuery, useSectionsQuery } from '../projects/queries';
import { fetchProjectRules } from '../project-rules/api';
import { projectRulesKey, useProjectRules } from '../project-rules/queries';
import { useTaskPlacementsQuery, type PlacementCommands } from './queries';
import { HomeSwitchFeedback, useHomeSwitch } from './HomeSwitch';

const compactPicker = 'border-transparent! bg-transparent! px-1.5 shadow-none! hover:bg-canvas!';

/** A small deterministic colour square, so projects are told apart at a glance. */
function Swatch({ id }: { id: string }) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return <span aria-hidden="true" className="size-3.5 shrink-0 rounded-[4px]" style={{ backgroundColor: `hsl(${hash} 65% 78%)` }} />;
}

/** The section of one linked project, chosen right in its row. */
function LinkedSection({ actorId, item, blocked, commands }: { actorId: string; item: TaskProjectPlacementDto; blocked: boolean; commands: PlacementCommands }) {
  const { t } = useTranslation();
  const sections = useSectionsQuery(actorId, item.workspaceId, item.projectId);
  if (!sections.isSuccess) return null;
  const options = [{ value: '', label: t('placements.noSection') }, ...sections.data.filter(section => section.archivedAt === null || section.id === item.sectionId).map(section => ({ value: section.id, label: section.name }))];
  return <ChoicePicker compact className={compactPicker} label={t('placements.sectionIn')} value={item.sectionId ?? ''} options={options} disabled={blocked}
    onValueChange={value => { const next = value === '' ? null : value; if (next !== item.sectionId) commands.mutate({ command: { kind: 'update', placementId: item.id, input: { expectedRevision: item.revision, sectionId: next } } }); }} />;
}

export function TaskProjectsField({ actorId, task, homeProject, writable, commands, homeSectionPicker }: { actorId: string; task: TaskDto; homeProject: ProjectDto; writable: boolean; commands: PlacementCommands; homeSectionPicker?: ReactNode }) {
  const { t } = useTranslation();
  const placements = useTaskPlacementsQuery(actorId, task.workspaceId, task.id);
  const projects = useProjectsQuery(actorId, task.workspaceId);
  const homeRules = useProjectRules(actorId, task.workspaceId, homeProject.id);
  const keepsOneProject = homeRules.data?.config.singleProject === true;
  const home = useHomeSwitch(actorId, task, homeProject);
  const registry = protectedCommandsFor(useQueryClient());
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  // A denied/failed refetch hides retained membership metadata and disables all writes.
  const current = placements.isSuccess && !placements.isFetching && projects.isSuccess && !projects.isFetching;
  const blocked = !writable || task.visibility !== 'workspace' || task.archivedAt !== null || !current || commands.isError || commands.pendingCommand !== null || commands.uncertain !== null || commands.hasOtherProtectedCommands();
  const canMove = writable && task.visibility === 'workspace' && task.meetingId === null && task.archivedAt === null && task.parentTaskId === null && homeRules.data?.config.lockMoves !== true && projects.isSuccess;
  const active = placements.isSuccess ? placements.data.filter(item => item.archivedAt === null && item.projectId !== homeProject.id) : [];
  const projectName = (id: string) => projects.isSuccess ? projects.data.projects.find(item => item.id === id)?.name ?? t('placements.unavailableProject') : t('placements.unavailableProject');
  const archived = placements.isSuccess ? placements.data.filter(item => item.archivedAt !== null && item.projectId !== homeProject.id) : [];
  // A project the task was removed from (or moved out of) is offered again: choosing it restores the detached placement.
  const present = new Set([homeProject.id, ...active.map(item => item.projectId)]);
  const candidates = projects.isSuccess ? projects.data.projects.filter(item => item.archivedAt === null && !present.has(item.id)) : [];
  // A target project with the "one project only" rule refuses tasks from elsewhere, so it must not be offered.
  const targetRules = useQueries({ queries: candidates.map(item => ({ queryKey: projectRulesKey(actorId, task.workspaceId, item.id), queryFn: ({ signal }: { signal: AbortSignal }) => fetchProjectRules(task.workspaceId, item.id, signal), retry: false, staleTime: 30_000 })) });
  const choices = candidates.filter((_, index) => targetRules[index]?.data?.config.singleProject !== true).map(item => ({ value: item.id, label: item.name }));
  const nameStyle = 'min-w-0 flex-1 truncate px-1.5 text-sm text-ink';
  return <div className="min-w-0 space-y-1" aria-label={t('placements.projects')}>
    <div className="flex items-center gap-2" title={keepsOneProject ? t('placements.oneProjectHint') : t('placements.sharedHint')}>
      <h3 className="text-sm font-semibold text-ink">{t('placements.projects')}</h3>
      <span className="rounded bg-canvas px-1.5 text-xs text-muted tabular-nums">{1 + active.length}</span>
    </div>
    <div className="flex min-h-8 min-w-0 items-center gap-1">
      <Swatch id={homeProject.id} /><span className={nameStyle}>{homeProject.name}</span>
      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent-ink" title={t('placements.homeHint')}><House size={12} aria-hidden="true" />{t('placements.homeBadge')}</span>
      {homeSectionPicker ? <div className="max-w-[45%] shrink-0">{homeSectionPicker}</div> : null}
    </div>
    {active.length > 0 ? <p role="note" data-multi-project-warning="" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">{t('placements.multiProjectWarning')}</p> : null}
    {active.map(item => <div key={item.id} className="flex min-h-8 min-w-0 items-center gap-1">
      <Swatch id={item.projectId} /><span className={nameStyle}>{projectName(item.projectId)}</span>
      <div className="max-w-[45%] shrink-0"><LinkedSection actorId={actorId} item={item} blocked={blocked} commands={commands} /></div>
      {canMove ? <Button size="sm" variant="ghost" disabled={blocked || home.busy} title={t('placements.makeHome')} aria-label={t('placements.makeHomeIn', { p0: projectName(item.projectId) })} onClick={() => home.makeHome(item.projectId)}><House size={14} aria-hidden="true" /></Button> : null}
      <Button size="sm" variant="ghost" disabled={blocked} aria-label={t('placements.removeFrom', { p0: projectName(item.projectId) })} onClick={() => commands.mutate({ command: { kind: 'detach', placementId: item.id, input: { expectedRevision: item.revision } } })}><X size={14} aria-hidden="true" /></Button>
    </div>)}
    <HomeSwitchFeedback task={task} home={home} nameOf={projectName} disabled={blocked} />
    {placements.isError || projects.isError ? <div className="space-y-1"><p role="status" className="text-xs text-muted">{t('placements.loadFailed')}</p><Button size="sm" variant="ghost" onClick={() => { void placements.refetch(); void projects.refetch(); }}>{t('placements.reload')}</Button></div> : null}
    {writable && !keepsOneProject && task.visibility === 'workspace' && task.meetingId === null && task.archivedAt === null ? <ChoicePicker compact searchable className={compactPicker} label={t('placements.add')} placeholder={`+ ${t('placements.add')}`} value="" options={choices} disabled={blocked || choices.length === 0} onValueChange={projectId => {
      if (blocked || !choices.some(choice => choice.value === projectId)) return;
      const detached = archived.find(item => item.projectId === projectId);
      commands.mutate({ command: detached
        ? { kind: 'restore', placementId: detached.id, input: { expectedRevision: detached.revision } }
        : { kind: 'attach', taskId: task.id, input: { projectId, expectedTaskRevision: task.revision } } });
    }} /> : null}
    {!keepsOneProject && candidates.length > 0 && choices.length === 0 && targetRules.every(rule => rule.isSuccess) ? <p role="note" className="text-xs text-amber-900">{t('placements.targetsKeepOneProject')}</p> : null}
    {homeRules.data?.config.lockMoves === true ? <p className="text-xs text-muted">{t('placements.transfer.locked')}</p> : null}
    {task.parentTaskId !== null ? <p className="text-xs text-muted">{t('placements.transfer.subtask')}</p> : null}
  </div>;
}
