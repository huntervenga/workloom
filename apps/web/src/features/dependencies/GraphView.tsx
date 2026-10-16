import { t, useTranslation } from '../../i18n';
import type { ProjectDto, TaskDto, WorkspaceDto } from '@workloom/contracts';
import { Button, inputClassName } from '@workloom/ui';
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useGraphQuery, useLayoutQuery, usePolicyQuery } from './queries';
import { fetchGraphLayout } from './api';
import type { DependencyWorkspace, Point } from './useDependencyWorkspace';
const Canvas = lazy(() => import('./GraphCanvas'));
class CanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <p role="alert" className="text-sm text-red-800">{t('dependencies.graphView.theDiagramCouldNotLoadTheDependencyList')}</p> : this.props.children; }
}
export function GraphView({ actorId, workspace, project, controller: c, loadedTasks, onOpen }: {
  actorId: string; workspace: WorkspaceDto; project: ProjectDto; controller: DependencyWorkspace;
  loadedTasks: readonly TaskDto[]; onOpen: (task: TaskDto) => void;
}) {
  const { t } = useTranslation();
  const roots = c.roots ?? [];
  const graph = useGraphQuery(actorId, workspace.id, project.id, roots, c.depth);
  const layout = useLayoutQuery(actorId, workspace.id, project.id);
  const policy = usePolicyQuery(actorId, workspace.id, project.id);
  const adopt = c.adoptLayout;
  useEffect(() => { if (layout.isSuccess) adopt(layout.data); }, [layout.isSuccess, layout.data, adopt]);
  const [automatic, setAutomatic] = useState<{ source: string; positions: Record<string, Point> } | null>(null);
  const [arranging, setArranging] = useState(false);
  const [visibleNodes, setVisibleNodes] = useState(20);
  const [visibleEdges, setVisibleEdges] = useState(20);
  const [localError, setLocalError] = useState<Error | null>(null);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const generation = useRef(0);
  const fingerprint = `${actorId}:${workspace.id}:${project.id}:${roots.join(',')}:${c.depth}:${graph.data?.asOfChangeSeq ?? ''}`;
  const current = useRef(fingerprint); current.current = fingerprint;
  useEffect(() => () => { generation.current += 1; }, []);
  const deniedCommands = Object.values(c.commands).filter(command => isAccessDenied(command.error));
  const denied = [graph.error, layout.error, policy.error].some(isAccessDenied) || deniedCommands.length > 0;
  const checkAccess = async () => {
    setCheckingAccess(true);
    try {
      const reads = await Promise.all([layout.refetch(), policy.refetch(), ...(roots.length ? [graph.refetch()] : [])]);
      if (reads.every(read => read.isSuccess)) {
        for (const command of deniedCommands) command.reset();
      }
    } finally { setCheckingAccess(false); }
  };
  const held = c.commands.layout.pendingCommand?.variables ?? c.commands.layout.uncertain?.variables;
  const heldPolicy = c.commands.policy.pendingCommand?.variables ?? c.commands.policy.uncertain?.variables;
  const data = graph.data;
  const tasks = useMemo(() => data?.nodes.map(node => ({ id: node.task.id, title: node.task.title, projectName: node.context.project.name, statusName: node.context.status.name, blocked: node.blocking.isBlocked, archived: node.task.archivedAt !== null })) ?? [], [data]);
  const edges = useMemo(() => data?.edges.map(edge => ({ id: edge.id, source: edge.predecessorTaskId, target: edge.successorTaskId })) ?? [], [data]);
  useEffect(() => {
    if (!data) return;
    let active = true;
    const source = fingerprint;
    void import('./layout').then(async ({ arrangeGraph }) => {
      const positions = await arrangeGraph(data.nodes.map(node => node.task.id), edges);
      if (active && current.current === source) setAutomatic({ source, positions });
    }).catch(() => { if (active) setLocalError(new Error(t('dependencies.graphView.automaticLayoutCouldNotLoadSavedPositionsAre'))); });
    return () => { active = false; };
  }, [data, edges, fingerprint, t]);
  const positions = useMemo(() => ({ ...(automatic?.source === fingerprint ? automatic.positions : {}), ...Object.fromEntries((c.layout.reset ? [] : c.layout.base?.positions ?? []).map(position => [position.taskId, { x: position.x, y: position.y }])), ...c.layout.moves }), [c.layout, automatic, fingerprint]);
  const open = useCallback((id: string) => { const task = data?.nodes.find(node => node.task.id === id)?.task; if (task) onOpen(task); }, [data, onOpen]);
  const connect = (source: string, target: string) => {
    const anchor = data?.nodes.find(node => node.task.id === source)?.task;
    const other = data?.nodes.find(node => node.task.id === target)?.task;
    if (anchor && other) c.openCreate(anchor, other, 'outgoing');
  };
  const arrange = async () => {
    if (!data || held || arranging) return;
    const stamp = ++generation.current;
    const source = fingerprint;
    setArranging(true); setLocalError(null);
    try {
      const { arrangeGraph } = await import('./layout');
      const result = await arrangeGraph(data.nodes.map(node => node.task.id), edges);
      if (stamp !== generation.current || current.current !== source) return;
      for (const [id, point] of Object.entries(result)) c.move(id, point);
    } catch { setLocalError(new Error(t('dependencies.graphView.couldNotCalculateTheLayout'))); }
    finally { setArranging(false); }
  };
  if (denied) return <section className="space-y-3 rounded-xl border border-line p-4"><p role="alert" className="text-sm text-muted">{t('dependencies.graphView.graphAndPersonalPositionsAreHiddenBecauseAccess')}</p><Button disabled={checkingAccess} onClick={() => void checkAccess()}>{t('dependencies.graphView.checkGraphAccess')}</Button></section>;
  const knownTasks = [...new Map([...loadedTasks, ...(data?.nodes.map(node => node.task) ?? [])].map(task => [task.id, task])).values()].filter(task => task.projectId === project.id);
  return <section aria-label={t('dependencies.graphView.projectDependencies')} className="space-y-4">
    <header className="space-y-2"><h2 className="text-lg font-semibold">{t('dependencies.graphView.dependencyGraph')}</h2><p className="text-sm text-muted">{c.rootOrigin === 'loaded' ? t('dependencies.graphView.startingTasksTakenFromTheLoadedTaskTable') : c.rootOrigin === 'selected' ? t('dependencies.graphView.startingTasksTakenFromYourSelection') : t('dependencies.graphView.startingTasksChosenManually')} · {roots.length} {t('dependencies.graphView.of100MaximumFiltersAndNewPagesDo')}</p></header>
    <details className="rounded-xl border border-line p-4"><summary className="cursor-pointer text-sm font-medium">{t('dependencies.graphView.chooseStartingTasks')}{roots.length})</summary><fieldset className="mt-3 max-h-64 space-y-2 overflow-y-auto"><legend className="sr-only">{t('dependencies.graphView.graphStartingTasks')}</legend>{knownTasks.map(task => <label key={task.id} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={roots.includes(task.id)} disabled={!roots.includes(task.id) && roots.length >= 100} onChange={e => { c.setRoots(e.target.checked ? [...roots, task.id] : roots.filter(id => id !== task.id)); c.setRootOrigin('manual'); }} /><span className="min-w-0 [overflow-wrap:anywhere]">{task.title}</span></label>)}</fieldset></details>
    <div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-sm">{t('dependencies.graphView.neighborDepth')}<select aria-label={t('dependencies.graphView.neighborDepth')} className={inputClassName('w-auto')} value={c.depth} onChange={e => c.setDepth(Number(e.target.value))}><option value={0}>{t('dependencies.graphView.startingTasksOnly')}</option><option value={1}>1</option><option value={2}>2</option></select></label><Button aria-pressed={!c.canvas} onClick={() => c.setCanvas(false)}>{t('dependencies.graphView.dependencyList')}</Button><Button aria-pressed={c.canvas} onClick={() => c.setCanvas(true)}>{t('dependencies.graphView.diagram')}</Button><Button disabled={graph.isFetching} onClick={() => void graph.refetch()}>{t('dependencies.graphView.refreshGraph')}</Button></div>
    {roots.length === 0 ? <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">{t('dependencies.graphView.chooseAtLeastOneStartingTaskTheGraph')}</p> : graph.isError ? <><QueryErrorState error={graph.error} subject="tasks" headingLevel={3} />{graph.error instanceof ApiError && graph.error.status === 422 ? <p className="text-sm text-muted">{t('dependencies.graphView.reduceStartingTasksOrDepthTheLimitIs')}</p> : null}</> : !data ? <p role="status" className="text-sm text-muted">{t('dependencies.graphView.loadingDependenciesForSelectedTasks')}</p> : <>
      <p className="text-xs text-muted">{t('dependencies.graphView.inThisSelection')}{data.nodes.length} {t('dependencies.graphView.tasks')}{data.edges.length} {t('dependencies.graphView.dependenciesBlockingChecksIncludeAllWorkspaceDependenciesIncluding')}</p>
      {c.canvas ? <CanvasBoundary><Suspense fallback={<p role="status" className="text-sm text-muted">{t('dependencies.graphView.loadingDiagram')}</p>}><Canvas tasks={tasks} edges={edges} positions={positions} movable={!held && !arranging && layout.isSuccess} connectable={workspace.role !== 'viewer' && project.archivedAt === null} onMove={c.move} onConnect={connect} onOpen={open} /></Suspense></CanvasBoundary> : null}
      <ul aria-label={t('dependencies.graphView.graphTasksAndDependencies')} className="space-y-3">{data.nodes.slice(0, visibleNodes).map(node => <li key={node.task.id} className="space-y-2 rounded-xl border border-line bg-surface p-4"><button type="button" className="rounded text-left font-medium text-accent-ink underline [overflow-wrap:anywhere]" onClick={() => onOpen(node.task)}>{node.task.title}</button><p className="text-xs text-muted">{node.context.project.name} · {node.context.status.name}{node.task.archivedAt ? t('dependencies.graphView.archived') : ''}</p><p className="text-xs text-muted">{t('dependencies.graphView.unfinishedPredecessors')}{node.blocking.unresolvedCount}{node.outsideUnresolvedPredecessorCount ? t('dependencies.graphView.outsideThisGraphValue', { p0: node.outsideUnresolvedPredecessorCount }) : ''}{node.hasOutsideDependencies ? t('dependencies.graphView.moreDependenciesOutsideThisSelection') : ''}</p><details><summary className="cursor-pointer text-xs font-medium">{t('dependencies.graphView.positionInMyLayout')}</summary><div className="mt-2 flex flex-wrap gap-2">{([[t('dependencies.graphView.left'), -20, 0], [t('dependencies.graphView.right'), 20, 0], [t('dependencies.graphView.up'), 0, -20], [t('dependencies.graphView.down'), 0, 20]] as const).map(([label, dx, dy]) => <Button key={label} size="sm" aria-label={`${label}: ${node.task.title}`} disabled={!!held || arranging || !layout.isSuccess || positions[node.task.id] === undefined} onClick={() => { const point = positions[node.task.id]; if (!point) return; c.move(node.task.id, { x: point.x + dx, y: point.y + dy }); }}>{label}</Button>)}</div></details>{workspace.role !== 'viewer' && !node.task.archivedAt ? <Button size="sm" onClick={() => c.openCreate(node.task)}>{t('dependencies.graphView.addTaskDependency')}</Button> : null}</li>)}</ul>
      {data.nodes.length > visibleNodes ? <Button onClick={() => setVisibleNodes(count => count + 20)}>{t('dependencies.graphView.moreGraphTasks')}</Button> : null}
      <section aria-label={t('dependencies.graphView.dependenciesInThisSelection')} className="space-y-3"><h3 className="font-semibold">{t('dependencies.graphView.dependenciesInThisSelection')}</h3>{data.edges.length === 0 ? <p className="text-sm text-muted">{t('dependencies.graphView.noDependenciesBetweenTheseTasksYet')}</p> : <ul className="space-y-2">{data.edges.slice(0, visibleEdges).map(edge => <li key={edge.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3 text-sm"><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{data.nodes.find(node => node.task.id === edge.predecessorTaskId)?.task.title ?? t('dependencies.graphView.predecessorTask')} → {data.nodes.find(node => node.task.id === edge.successorTaskId)?.task.title ?? t('dependencies.graphView.successorTask')}</span>{workspace.role !== 'viewer' ? <Button size="sm" disabled={!!(c.commands.update.pendingCommand || c.commands.update.uncertain)} onClick={() => c.commands.update.mutate({ anchorTaskId: edge.successorTaskId, edge, input: { expectedRevision: edge.revision, state: 'removed' } })}>{t('dependencies.graphView.removeDependency')}</Button> : null}</li>)}</ul>}{data.edges.length > visibleEdges ? <Button onClick={() => setVisibleEdges(count => count + 20)}>{t('dependencies.graphView.moreGraphDependencies')}</Button> : null}<SaveFeedback subject="taskSave" error={c.commands.update.error} uncertainError={c.commands.update.uncertain?.error ?? null} /></section>
      <section aria-label={t('dependencies.graphView.myGraphLayout')} className="space-y-3 rounded-xl border border-line p-4"><h3 className="font-semibold">{t('dependencies.graphView.myLayout')}</h3><p className="text-xs text-muted">{t('dependencies.graphView.onlyYouSeeThesePositionsTheyDoNot')}</p><div className="flex flex-wrap gap-2"><Button disabled={!!held || arranging || !layout.isSuccess} onClick={() => void arrange()}>{t('dependencies.graphView.applyAutomaticLayout')}</Button><Button disabled={!!held || arranging || !c.layoutDirty || c.layoutInput === null || c.layoutInput.positions.length > 500} variant="primary" onClick={() => { if (!arranging && c.layoutInput) c.commands.layout.mutate({ input: c.layoutInput }); }}>{t('dependencies.graphView.saveMyLayout')}</Button><Button disabled={!!held || arranging || !c.layoutDirty} onClick={c.discardLayout}>{t('dependencies.graphView.discardMoves')}</Button><Button disabled={!!held || arranging || !layout.isSuccess} onClick={c.resetLayout}>{t('dependencies.graphView.resetAllMyPositions')}</Button></div>{c.layout.reset ? <p role="status" className="text-sm text-amber-900">{t('dependencies.graphView.savingWillResetAllYourPositionsInThis')}</p> : null}{c.layoutInput && c.layoutInput.positions.length > 500 ? <p role="alert" className="text-sm text-red-800">{t('dependencies.graphView.limit500PositionsResetYourLayoutOrReduce')}</p> : null}
        {layout.isError ? <QueryErrorState error={layout.error} subject="tasks" headingLevel={3} /> : null}<SaveFeedback subject="taskSave" error={c.commands.layout.error ?? localError} uncertainError={c.commands.layout.uncertain?.error ?? null} />
        {c.commands.layout.error instanceof ApiError && c.commands.layout.error.kind === 'conflict' && !held ? <Button disabled={arranging} onClick={() => void fetchGraphLayout(workspace.id, project.id).then(c.rebaseLayout).catch(error => setLocalError(error instanceof Error ? error : new Error(t('dependencies.graphView.readFailed'))))}>{t('dependencies.graphView.reloadLayoutAndKeepMoves')}</Button> : null}
      </section>
    </>}
    {policy.isSuccess ? <section aria-label={t('dependencies.graphView.projectBlockingRule')} className="space-y-3 rounded-xl border border-line p-4"><h3 className="font-semibold">{t('dependencies.graphView.projectBlockingRule')}</h3><p className="text-xs text-muted">{t('dependencies.graphView.appliesToTasksInThisProjectIncludingPredecessors')}</p><label className="block space-y-1.5 text-sm font-medium">{t('dependencies.graphView.dependencyMode')}<select className={inputClassName()} disabled={workspace.role !== 'owner' && workspace.role !== 'admin' || !!heldPolicy} value={heldPolicy?.input.mode ?? c.policyMode ?? policy.data.mode} onChange={e => { const mode = e.target.value === 'enforce' ? 'enforce' : 'warn'; c.setPolicyMode(mode === policy.data.mode ? null : mode); }}><option value="warn">{t('dependencies.graphView.warnAndAllowStatusChanges')}</option><option value="enforce">{t('dependencies.graphView.blockStartAndCompletionUntilPredecessorsFinish')}</option></select></label>{workspace.role === 'owner' || workspace.role === 'admin' ? <div className="flex flex-wrap gap-2"><Button disabled={!!heldPolicy || c.policyMode === null} onClick={() => { if (c.policyMode !== null) c.commands.policy.mutate({ input: { expectedRevision: policy.data.revision, mode: c.policyMode } }); }}>{t('dependencies.graphView.saveBlockingRule')}</Button>{c.policyMode !== null && !heldPolicy ? <Button onClick={() => c.setPolicyMode(null)}>{t('dependencies.graphView.discardRuleChange')}</Button> : null}<Button disabled={!!heldPolicy} onClick={() => void policy.refetch()}>{t('dependencies.graphView.refreshRule')}</Button></div> : null}<SaveFeedback subject="taskSave" error={c.commands.policy.error} uncertainError={c.commands.policy.uncertain?.error ?? null} /></section> : null}
  </section>;
}
