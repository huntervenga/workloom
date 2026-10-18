import { useTranslation } from '../../i18n';
import type { ProjectDto, TaskDependencyDto, TaskDto } from '@workloom/contracts';
import { Badge, Button } from '@workloom/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { isAccessDenied } from '../../lib/api';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { useProjectQuery } from '../projects/queries';
import { useTaskQuery } from '../tasks/queries';
import { useBlockingQuery, useDependenciesQuery } from './queries';
import type { DependencyWorkspace } from './useDependencyWorkspace';

export interface DependencyPanelProps {
  actorId: string;
  workspaceId: string;
  project: ProjectDto;
  task: TaskDto;
  controller: DependencyWorkspace;
  writable: boolean;
  /** Flat parameter-style presentation in the saved task pane; other callers keep the card. */
  compact?: boolean | undefined;
  onOpenTask: (taskId: string) => void;
}
export function DependencyPanel(p: DependencyPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const blocking = useBlockingQuery(p.actorId, p.workspaceId, p.task.id);
  const dependencies = useDependenciesQuery(p.actorId, p.workspaceId, p.task.id, expanded);
  const deniedCommands = [p.controller.commands.create, p.controller.commands.update].filter(command => isAccessDenied(command.error));
  const denied = [blocking.error, dependencies.error, ...deniedCommands.map(command => command.error)].find(isAccessDenied);
  const checkAccess = async () => {
    setCheckingAccess(true);
    try {
      const reads = await Promise.all([blocking.refetch(), dependencies.refetch()]);
      if (reads.every(read => read.isSuccess)) {
        for (const command of deniedCommands) command.reset();
      }
    } finally { setCheckingAccess(false); }
  };
  const summary = blocking.data?.pages[0]?.data.summary;
  const edges = [...new Map((dependencies.data?.pages ?? []).flatMap(page => page.data).map(edge => [edge.id, edge])).values()];
  const blockedRows = (blocking.data?.pages ?? []).flatMap(page => page.data.blockers);
  if (denied) return <section aria-label={t('dependencies.dependencyPanel.taskDependencies')} className={p.compact ? 'space-y-2' : 'rounded-xl border border-line p-4'}><QueryErrorState error={denied} subject="task" headingLevel={3} /><Button disabled={checkingAccess} onClick={() => void checkAccess()}>{t('dependencies.dependencyPanel.checkDependencyAccess')}</Button></section>;
  return <section aria-label={t('dependencies.dependencyPanel.taskDependencies')} className={p.compact ? 'space-y-1.5' : 'space-y-3 rounded-xl border border-line p-4'}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className={p.compact ? 'text-sm font-medium' : 'font-semibold'}>{t('dependencies.dependencyPanel.taskDependencies')}</h3>{p.writable && !p.task.archivedAt ? <Button size="sm" onClick={() => p.controller.openCreate(p.task)}>{t('dependencies.dependencyPanel.addDependency')}</Button> : null}</div>
    {blocking.isError ? <QueryErrorState error={blocking.error} subject="task" headingLevel={3} onRetry={() => void blocking.refetch({ cancelRefetch: true })} /> : summary ? <div className="space-y-2">
      <div className="flex flex-wrap gap-2"><Badge tone={summary.isBlocked ? 'warning' : 'muted'}>{summary.isBlocked ? t('dependencies.dependencyPanel.unfinishedPredecessorsValue', { p0: summary.unresolvedCount }) : t('dependencies.dependencyPanel.noUnfinishedPredecessors')}</Badge><Badge tone="muted">{summary.policy.mode === 'enforce' ? t('dependencies.dependencyPanel.startingAndCompletionBlocked') : t('dependencies.dependencyPanel.warning')}</Badge></div>
      {summary.isBlocked ? <p className="text-xs leading-relaxed text-muted">{summary.policy.mode === 'enforce' ? t('dependencies.dependencyPanel.completeAllPredecessorsBeforeStartingOrCompletingThis') : t('dependencies.dependencyPanel.checkPredecessorsBeforeStartingOrCompletingThisTask')} {t('dependencies.dependencyPanel.theCheckIncludesDependenciesOutsideTheCurrentList')}</p> : null}
      {summary.violatesCurrentStatus ? <p className="text-xs text-amber-900">{t('dependencies.dependencyPanel.theCurrentStatusConflictsWithTheBlockingRules')}</p> : null}
      {blockedRows.length ? <ul className="space-y-2">{blockedRows.map(row => <li key={row.dependency.id} className="text-sm"><TaskLink task={row.predecessor} projectId={p.project.id} workspaceId={p.workspaceId} onOpen={p.onOpenTask} /> <span className="text-xs text-muted">· {row.predecessorContext.project.name} · {row.predecessorContext.status.name}{row.predecessor.archivedAt ? t('dependencies.dependencyPanel.archived') : ''}</span></li>)}</ul> : null}
      {blocking.hasNextPage ? <Button size="sm" disabled={blocking.isFetchingNextPage} onClick={() => void blocking.fetchNextPage()}>{t('dependencies.dependencyPanel.morePredecessors')}</Button> : null}
    </div> : <p role="status" className="text-xs text-muted">{t('dependencies.dependencyPanel.checkingPredecessors')}</p>}
    {p.controller.commands.update.variables?.anchorTaskId === p.task.id ? <SaveFeedback subject="taskSave" error={p.controller.commands.update.error} uncertainError={p.controller.commands.update.uncertain?.error ?? null} /> : null}
    <details open={expanded} onToggle={e => setExpanded(e.currentTarget.open)}>
      <summary className={p.compact ? 'cursor-pointer rounded text-xs font-medium text-muted' : 'cursor-pointer rounded text-sm font-medium'}>{t('dependencies.dependencyPanel.allDependenciesIncludingRemoved')}</summary>
      <div className="mt-3 space-y-3">{dependencies.isError ? <><QueryErrorState error={dependencies.error} subject="task" headingLevel={3} /><Button size="sm" onClick={() => { void dependencies.refetch({ cancelRefetch: true }); }}>{t('dependencies.dependencyPanel.restartDependencyList')}</Button></> : dependencies.isPending ? <p role="status" className="text-xs text-muted">{t('dependencies.dependencyPanel.loadingDependencies')}</p> : edges.length === 0 ? <p className="text-sm text-muted">{t('dependencies.dependencyPanel.noDependenciesYet')}</p> : <ul className="space-y-3">{edges.map(edge => <EdgeRow key={edge.id} edge={edge} {...p} />)}</ul>}
        {dependencies.hasNextPage ? <Button size="sm" disabled={dependencies.isFetchingNextPage} onClick={() => void dependencies.fetchNextPage()}>{t('dependencies.dependencyPanel.moreDependencies')}</Button> : null}
      </div>
    </details>
  </section>;
}
function TaskLink({ task, projectId, workspaceId, onOpen }: { task: TaskDto; projectId: string; workspaceId: string; onOpen: (id: string) => void }) {
  useTranslation();
  if (task.projectId !== projectId) return <Link className="rounded font-medium text-accent-ink underline [overflow-wrap:anywhere]" to={`/w/${workspaceId}/projects/${task.projectId}?task=${task.id}`}>{task.title}</Link>;
  return <button type="button" className="rounded text-left font-medium text-accent-ink underline [overflow-wrap:anywhere]" onClick={() => onOpen(task.id)}>{task.title}</button>;
}
function Endpoint({ id, p }: { id: string; p: DependencyPanelProps }) {
  const { t } = useTranslation();
  const task = useTaskQuery(p.actorId, p.workspaceId, id);
  const project = useProjectQuery(p.actorId, p.workspaceId, task.data?.projectId ?? '');
  if (task.isError || project.isError) return <span className="text-muted">{t('dependencies.dependencyPanel.relatedTaskUnavailable')}</span>;
  if (!task.data) return <span className="text-muted">{t('dependencies.dependencyPanel.loadingRelatedTask')}</span>;
  return <span><TaskLink task={task.data} projectId={p.project.id} workspaceId={p.workspaceId} onOpen={p.onOpenTask} /> <span className="text-xs text-muted">· {project.data?.name ?? t('dependencies.dependencyPanel.loadingProject')}{task.data.archivedAt ? t('dependencies.dependencyPanel.archived') : ''}</span></span>;
}
function EdgeRow(p: DependencyPanelProps & { edge: TaskDependencyDto }) {
  const { t } = useTranslation();
  const { edge, controller: c } = p;
  const incoming = edge.successorTaskId === p.task.id;
  const mutation = c.commands.update;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
  return <li className="space-y-2 border-t border-line pt-3 text-sm"><p><span className="text-muted">{incoming ? t('dependencies.dependencyPanel.dependsOn') : t('dependencies.dependencyPanel.blocks')}</span><Endpoint id={incoming ? edge.predecessorTaskId : edge.successorTaskId} p={p} /></p>
    <div className="flex flex-wrap items-center gap-2"><Badge tone="muted">{edge.state === 'removed' ? t('dependencies.dependencyPanel.dependencyRemoved') : t('dependencies.dependencyPanel.finishToStart')}</Badge>{p.writable ? <Button size="sm" disabled={!!held} onClick={() => mutation.mutate({ anchorTaskId: p.task.id, edge, input: { expectedRevision: edge.revision, state: edge.state === 'active' ? 'removed' : 'active' } })}>{edge.state === 'active' ? t('dependencies.dependencyPanel.removeDependency') : t('dependencies.dependencyPanel.restoreDependency')}</Button> : null}</div>
  </li>;
}
