import { useTranslation } from '../../i18n';
import type { ProjectDto, TaskDto } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { useState } from 'react';
import { isAccessDenied } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useProjectsQuery } from '../projects/queries';
import { dedupeTasks } from '../task-table';
import { loadedTaskScope, useTaskListQuery } from '../tasks/queries';
import type { DependencyWorkspace } from './useDependencyWorkspace';
export function EdgeDialog({ controller: c, actorId, workspaceId, project, writable }: { controller: DependencyWorkspace; actorId: string; workspaceId: string; project: ProjectDto; writable: boolean }) {
  useTranslation();
  const draft = c.activeDraft;
  if (!draft) return null;
  return <EdgeForm key={draft.id} controller={c} actorId={actorId} workspaceId={workspaceId} project={project} writable={writable} draft={draft} />;
}
function EdgeForm({ controller: c, actorId, workspaceId, project, writable, draft }: Parameters<typeof EdgeDialog>[0] & { draft: NonNullable<DependencyWorkspace['activeDraft']> }) {
  const { t } = useTranslation();
  const projects = useProjectsQuery(actorId, workspaceId);
  const search = useTaskListQuery(actorId, workspaceId, { projectId: draft.projectId, search: draft.search, includeArchived: false }, { limit: 20 });
  const mutation = c.commands.create;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const own = held?.draftId === draft.id ? held : null;
  const error = !held && mutation.variables?.draftId === draft.id ? mutation.error : null;
  const denied = [projects.error, search.error, error].some(isAccessDenied);
  const locked = !!held || !writable;
  const [problem, setProblem] = useState(false);
  const options = dedupeTasks(loadedTaskScope(search.data).tasks).filter(task => task.id !== draft.anchor.id);
  const known = draft.other && !options.some(task => task.id === draft.other?.id) ? [draft.other, ...options] : options;
  const projectOptions = projects.data?.projects ?? [];
  const outgoing = own ? own.input.predecessorTaskId === draft.anchor.id : draft.direction === 'outgoing';
  const otherId = own ? outgoing ? own.input.successorTaskId : own.input.predecessorTaskId : draft.other?.id ?? '';
  const submit = () => {
    if (locked || denied) return;
    if (!draft.other || draft.other.id === draft.anchor.id) { setProblem(true); return; }
    setProblem(false);
    mutation.mutate({ draftId: draft.id, anchorTaskId: draft.anchor.id, input: { predecessorTaskId: outgoing ? draft.anchor.id : draft.other.id, successorTaskId: outgoing ? draft.other.id : draft.anchor.id, type: 'finish_to_start', expectedAbsent: true } });
  };
  return <DialogShell variant="drawer" title={t('dependencies.edgeDialog.addTaskDependency')} description={t('dependencies.edgeDialog.theNextTaskStartsAfterThePreviousOne')} open onOpenChange={open => { if (!open) c.setActiveAnchor(null); }}>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-5">{denied ? <p role="alert" className="text-sm text-muted">{t('dependencies.edgeDialog.tasksAreUnavailableFieldsAreHiddenYourDraft')}</p> : <>
      <p className="text-sm font-semibold [overflow-wrap:anywhere]">{draft.anchor.title}</p>
      <fieldset disabled={locked} className="space-y-4">
        <label className="block space-y-1.5 text-sm font-medium">{t('dependencies.edgeDialog.dependencyDirection')}<select className={inputClassName()} value={outgoing ? 'outgoing' : 'incoming'} onChange={e => c.changeDraft(draft.id, { direction: e.target.value === 'outgoing' ? 'outgoing' : 'incoming' })}><option value="incoming">{t('dependencies.edgeDialog.thisTaskDependsOn')}</option><option value="outgoing">{t('dependencies.edgeDialog.thisTaskBlocks')}</option></select></label>
        <label className="block space-y-1.5 text-sm font-medium">{t('dependencies.edgeDialog.relatedTaskProject')}<select className={inputClassName()} value={draft.projectId} onChange={e => c.changeDraft(draft.id, { projectId: e.target.value, other: null, search: '' })}>{!projectOptions.some(item => item.id === project.id) ? <option value={project.id}>{project.name}</option> : null}{projectOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="block space-y-1.5 text-sm font-medium">{t('dependencies.edgeDialog.searchRelatedTasks')}<TextInput value={draft.search} onChange={e => c.changeDraft(draft.id, { search: e.target.value })} /></label>
        <label className="block space-y-1.5 text-sm font-medium">{t('dependencies.edgeDialog.relatedTask')}<select className={inputClassName()} value={otherId} onChange={e => c.changeDraft(draft.id, { other: known.find(task => task.id === e.target.value) ?? null })}><option value="">{t('dependencies.edgeDialog.chooseATask')}</option>{known.map((task: TaskDto) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      </fieldset>
      {search.hasNextPage ? <Button size="sm" disabled={locked || search.isFetchingNextPage} onClick={() => void search.fetchNextPage()}>{t('dependencies.edgeDialog.loadMoreTasks')}</Button> : null}
      {search.isError ? <p role="alert" className="text-sm text-red-800">{t('dependencies.edgeDialog.couldNotLoadTasksChangeYourSearchOr')}</p> : null}
      {draft.other ? <p className="rounded-lg border border-line bg-canvas p-3 text-sm [overflow-wrap:anywhere]">{outgoing ? draft.anchor.title : draft.other.title} → {outgoing ? draft.other.title : draft.anchor.title}</p> : null}
      {problem ? <p role="alert" className="text-sm text-red-800">{t('dependencies.edgeDialog.chooseADifferentTask')}</p> : null}
      <SaveFeedback subject="taskSave" error={error} uncertainError={own ? mutation.uncertain?.error ?? null : null} />
    </>}{held ? <p role="status" className="text-sm text-amber-900">{own ? t('dependencies.edgeDialog.theOriginalTasksStayFixedUntilTheSubmission') : t('dependencies.edgeDialog.anotherDependencyIsUnconfirmedOpenTheOriginalSubmission')}</p> : null}</div>
    <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-surface pt-4"><Button disabled={!!own} onClick={() => c.discardDraft(draft.id)}>{t('dependencies.edgeDialog.discardDependencyDraft')}</Button><Button onClick={() => c.setActiveAnchor(null)}>{t('dependencies.edgeDialog.close')}</Button>{own && mutation.uncertain ? <Button variant="primary" disabled={!!mutation.pendingCommand} onClick={() => mutation.retryUncertain()}>{t('dependencies.edgeDialog.retryAddingDependency')}</Button> : <Button variant="primary" disabled={locked || denied || !draft.other} onClick={submit}>{t('dependencies.edgeDialog.addDependency')}</Button>}</div>
  </DialogShell>;
}
