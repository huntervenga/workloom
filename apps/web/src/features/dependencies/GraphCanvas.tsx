import { useTranslation } from '../../i18n';
import { Background, Controls, MarkerType, Position, ReactFlow, type AriaLabelConfig, type Edge, type Node, type NodeChange, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button } from '@workloom/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutEdge } from './layout';
import { GraphNodeContent, graphNodeBoxStyle, type GraphCanvasTask } from './GraphNodeContent';
import { edgeEmphasis, graphEdgeColor, graphEdgeStyle, graphNeighborhood, graphNodeTone, nodeEmphasis, presentGraphEdges, type GraphEdgeState } from './graphPresentation';
export type { GraphCanvasTask } from './GraphNodeContent';
import type { Point } from './useDependencyWorkspace';
export interface GraphCanvasProps {
  tasks: readonly GraphCanvasTask[];
  edges: readonly LayoutEdge[];
  positions: Readonly<Record<string, Point>>;
  movable: boolean;
  connectable: boolean;
  /** Each increment refits the viewport once; it never moves nodes or saves the layout. */
  fitRequest?: number;
  onMove: (id: string, position: Point) => void;
  onConnect: (source: string, target: string) => void;
  onOpen: (id: string) => void;
  onViewBlockers: (id: string) => void;
}
const FOCUS_NAME_LIMIT = 5;
function LegendLine({ state }: { state: GraphEdgeState }) {
  const style = graphEdgeStyle(state, 'normal');
  return <svg aria-hidden="true" width="28" height="8" className="shrink-0"><line x1="0" y1="4" x2="28" y2="4" stroke={graphEdgeColor(state)} strokeWidth={style.strokeWidth} strokeDasharray={style.strokeDasharray} /></svg>;
}
export default function GraphCanvas(p: GraphCanvasProps) {
  const { t, locale } = useTranslation();
  const onOpen = p.onOpen;
  const onViewBlockers = p.onViewBlockers;
  const [selected, setSelected] = useState<string | null>(null);
  const focusId = selected !== null && p.tasks.some(task => task.id === selected) ? selected : null;
  const presented = useMemo(() => presentGraphEdges(p.edges, p.tasks), [p.edges, p.tasks]);
  const focus = useMemo(() => graphNeighborhood(focusId, presented), [focusId, presented]);
  const titles = useMemo(() => new Map(p.tasks.map(task => [task.id, task.title])), [p.tasks]);
  // A fresh object per locale: React Flow re-merges ariaLabelConfig only when its identity changes.
  const labels = useMemo((): Partial<AriaLabelConfig> => {
    const coordinate = new Intl.NumberFormat(locale);
    // React Flow passes lowercase arrow-key tokens; never announce them raw.
    const direction = (token: string) => token === 'left' ? t('dependencies.graphCanvas.directionLeft') : token === 'right' ? t('dependencies.graphCanvas.directionRight')
      : token === 'up' ? t('dependencies.graphCanvas.directionUp') : token === 'down' ? t('dependencies.graphCanvas.directionDown') : t('dependencies.graphCanvas.directionUnknown');
    return {
      'controls.ariaLabel': t('dependencies.graphCanvas.graphControls'), 'controls.zoomIn.ariaLabel': t('dependencies.graphCanvas.zoomIn'), 'controls.zoomOut.ariaLabel': t('dependencies.graphCanvas.zoomOut'),
      'controls.fitView.ariaLabel': t('dependencies.graphCanvas.fitSelectedGraph'), 'controls.interactive.ariaLabel': t('dependencies.graphCanvas.toggleMovement'),
      'node.a11yDescription.default': t('dependencies.graphCanvas.selectATaskArrowKeysChangeItsPosition'),
      'node.a11yDescription.keyboardDisabled': t('dependencies.graphCanvas.theButtonInsideANodeOpensTheTask'),
      'node.a11yDescription.ariaLiveMessage': moved => t('dependencies.graphCanvas.nodeMoved', { direction: direction(moved.direction), x: coordinate.format(moved.x), y: coordinate.format(moved.y) }),
      'edge.a11yDescription.default': t('dependencies.graphCanvas.dependencyTheNextTaskStartsAfterThePrevious'),
      'minimap.ariaLabel': t('dependencies.graphCanvas.miniMap'), 'handle.ariaLabel': t('dependencies.graphCanvas.handle'),
    };
  }, [t, locale]);
  const nodes: Node[] = useMemo(() => p.tasks.map(task => {
    const emphasis = nodeEmphasis(task.id, focus);
    const suffix = [task.blocked ? t('dependencies.graphCanvas.unfinishedPredecessorsSuffix') : '', task.statusGroup === 'done' ? t('dependencies.graphCanvas.doneSuffix') : '', task.violatesCurrentStatus ? t('dependencies.graphCanvas.statusConflictSuffix') : ''].join('');
    return {
      id: task.id, position: p.positions[task.id] ?? { x: 0, y: 0 }, selected: task.id === focusId,
      sourcePosition: Position.Right, targetPosition: Position.Left, deletable: false,
      style: { ...graphNodeBoxStyle, ...graphNodeTone(task, emphasis) },
      ariaLabel: t('dependencies.graphCanvas.valueValueValuevalue', { p0: task.title, p1: task.projectName, p2: task.statusName, p3: suffix }),
      domAttributes: { 'aria-roledescription': t('dependencies.graphCanvas.nodeRoleDescription') },
      data: { label: <GraphNodeContent task={task} onOpen={onOpen} onViewBlockers={onViewBlockers} /> },
    };
  }), [p.tasks, p.positions, onOpen, onViewBlockers, focus, focusId, t]);
  const edges: Edge[] = useMemo(() => presented.map(edge => {
    const emphasis = edgeEmphasis(edge.id, focus);
    const names = { predecessor: titles.get(edge.source) ?? t('dependencies.graphView.predecessorTask'), successor: titles.get(edge.target) ?? t('dependencies.graphView.successorTask') };
    return {
      id: edge.id, source: edge.source, target: edge.target, deletable: false, zIndex: emphasis === 'focused' ? 1 : 0,
      markerEnd: { type: MarkerType.ArrowClosed, color: graphEdgeColor(edge.state) }, style: graphEdgeStyle(edge.state, emphasis),
      ariaLabel: t('dependencies.graphCanvas.edgeLabel', { relation: t('dependencies.graphCanvas.theNextTaskStartsAfterThePreviousTask'), state: t(edge.state === 'resolved' ? 'dependencies.graphCanvas.edgeResolved' : 'dependencies.graphCanvas.edgeUnresolved', names) }),
      domAttributes: { 'aria-roledescription': t('dependencies.graphCanvas.edgeRoleDescription') },
    };
  }), [presented, focus, titles, t]);
  const move = p.onMove;
  const changes = useCallback((items: NodeChange[]) => {
    for (const change of items) {
      if (change.type === 'position' && change.position && p.movable) move(change.id, change.position);
      if (change.type === 'select') setSelected(current => change.selected ? change.id : current === change.id ? null : current);
    }
  }, [move, p.movable]);
  const instance = useRef<ReactFlowInstance | null>(null);
  const fitRequest = p.fitRequest ?? 0;
  const seenFit = useRef(fitRequest);
  useEffect(() => {
    if (seenFit.current === fitRequest) return undefined;
    seenFit.current = fitRequest;
    // Wait for React Flow to adopt the new node positions before fitting the viewport.
    const frame = requestAnimationFrame(() => { void instance.current?.fitView(); });
    return () => cancelAnimationFrame(frame);
  }, [fitRequest]);
  const listFormat = new Intl.ListFormat(locale, { type: 'conjunction' });
  const names = (items: readonly string[]) => listFormat.format(items.length > FOCUS_NAME_LIMIT ? [...items.slice(0, FOCUS_NAME_LIMIT), t('dependencies.graphCanvas.focusMore', { count: items.length - FOCUS_NAME_LIMIT })] : items);
  const focusTask = focus === null ? undefined : p.tasks.find(task => task.id === focus.focusId);
  const unresolvedInGraph = focus?.predecessors.filter(edge => edge.state === 'unresolved').length ?? 0;
  // Same rule as the server's outside count: authoritative total minus unresolved predecessors shown here.
  const outsideUnresolved = focusTask ? Math.max(0, focusTask.unresolvedCount - unresolvedInGraph) : 0;
  return <div className="min-w-0 space-y-2">
    <ul aria-label={t('dependencies.graphCanvas.legend')} className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <li className="flex items-center gap-2"><LegendLine state="unresolved" />{t('dependencies.graphCanvas.legendUnresolved')}</li>
      <li className="flex items-center gap-2"><LegendLine state="resolved" />{t('dependencies.graphCanvas.legendResolved')}</li>
    </ul>
    <div className="flex flex-wrap items-start gap-2 rounded-lg border border-line bg-canvas p-3 text-xs">
      <div role="status" aria-live="polite" aria-label={t('dependencies.graphCanvas.focusRegion')} className="min-w-0 flex-1 space-y-1 [overflow-wrap:anywhere]">
        {focus && focusTask ? <>
          <p className="font-medium">{t('dependencies.graphCanvas.focusTitle', { title: focusTask.title })}</p>
          <p>{focus.predecessors.length ? t('dependencies.graphCanvas.focusPredecessors', { count: focus.predecessors.length, unresolved: unresolvedInGraph, names: names(focus.predecessors.map(edge => t(edge.state === 'resolved' ? 'dependencies.graphCanvas.focusDone' : 'dependencies.graphCanvas.focusNotDone', { title: titles.get(edge.source) ?? t('dependencies.graphView.predecessorTask') }))) }) : t('dependencies.graphCanvas.focusNoPredecessors')}</p>
          {outsideUnresolved > 0 ? <p>{t('dependencies.graphCanvas.focusOutside', { count: outsideUnresolved })}</p> : null}
          <p>{focus.successors.length ? t('dependencies.graphCanvas.focusSuccessors', { count: focus.successors.length, names: names(focus.successors.map(edge => titles.get(edge.target) ?? t('dependencies.graphView.successorTask'))) }) : t('dependencies.graphCanvas.focusNoSuccessors')}</p>
        </> : <p className="text-muted">{t('dependencies.graphCanvas.legendFocus')}</p>}
      </div>
      {focus ? <Button size="sm" onClick={() => setSelected(null)}>{t('dependencies.graphCanvas.clearFocus')}</Button> : null}
    </div>
    <div role="region" aria-label={t('dependencies.graphCanvas.dependencyGraph')} className="relative h-[34rem] w-full min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
      <ReactFlow nodes={nodes} edges={edges} onNodesChange={changes} onInit={flow => { instance.current = flow; }} nodesDraggable={p.movable} nodesConnectable={p.connectable} nodesFocusable edgesFocusable deleteKeyCode={null} onNodeDoubleClick={(_event, node) => p.onOpen(node.id)} onConnect={connection => { if (connection.source && connection.target && connection.source !== connection.target) p.onConnect(connection.source, connection.target); }} fitView minZoom={0.15} maxZoom={2} ariaLabelConfig={labels}>
        <Background /><Controls showInteractive={false} />
      </ReactFlow>
    </div>
  </div>;
}
