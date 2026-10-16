import { t, useTranslation } from '../../i18n';
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useState } from 'react';
import type { LayoutEdge } from './layout';
import { GraphNodeContent, graphNodeBoxStyle, type GraphCanvasTask } from './GraphNodeContent';
export type { GraphCanvasTask } from './GraphNodeContent';
import type { Point } from './useDependencyWorkspace';
export interface GraphCanvasProps {
  tasks: readonly GraphCanvasTask[];
  edges: readonly LayoutEdge[];
  positions: Readonly<Record<string, Point>>;
  movable: boolean;
  connectable: boolean;
  onMove: (id: string, position: Point) => void;
  onConnect: (source: string, target: string) => void;
  onOpen: (id: string) => void;
  onViewBlockers: (id: string) => void;
}
const labels = {
  get 'controls.ariaLabel'() { return t('dependencies.graphCanvas.graphControls'); }, get 'controls.zoomIn.ariaLabel'() { return t('dependencies.graphCanvas.zoomIn'); }, get 'controls.zoomOut.ariaLabel'() { return t('dependencies.graphCanvas.zoomOut'); },
  get 'controls.fitView.ariaLabel'() { return t('dependencies.graphCanvas.fitSelectedGraph'); }, get 'controls.interactive.ariaLabel'() { return t('dependencies.graphCanvas.toggleMovement'); },
  get 'node.a11yDescription.default'() { return t('dependencies.graphCanvas.selectATaskArrowKeysChangeItsPosition'); },
  get 'node.a11yDescription.keyboardDisabled'() { return t('dependencies.graphCanvas.theButtonInsideANodeOpensTheTask'); },
  get 'edge.a11yDescription.default'() { return t('dependencies.graphCanvas.dependencyTheNextTaskStartsAfterThePrevious'); },
};
export default function GraphCanvas(p: GraphCanvasProps) {
  const { t } = useTranslation();
  const onOpen = p.onOpen;
  const onViewBlockers = p.onViewBlockers;
  const [selected, setSelected] = useState<string | null>(null);
  const nodes: Node[] = useMemo(() => p.tasks.map(task => ({
    id: task.id, position: p.positions[task.id] ?? { x: 0, y: 0 }, selected: task.id === selected,
    sourcePosition: Position.Right, targetPosition: Position.Left, deletable: false,
    style: { ...graphNodeBoxStyle, borderColor: task.blocked ? '#f59e0b' : '#e2e8f0' },
    ariaLabel: t('dependencies.graphCanvas.valueValueValuevalue', { p0: task.title, p1: task.projectName, p2: task.statusName, p3: task.blocked ? t('dependencies.graphCanvas.unfinishedPredecessorsSuffix') : '' }),
    data: { label: <GraphNodeContent task={task} onOpen={onOpen} onViewBlockers={onViewBlockers} /> },
  })), [p.tasks, p.positions, onOpen, onViewBlockers, selected, t]);
  const edges: Edge[] = useMemo(() => p.edges.map(edge => ({ ...edge, deletable: false, markerEnd: { type: MarkerType.ArrowClosed }, ariaLabel: t('dependencies.graphCanvas.theNextTaskStartsAfterThePreviousTask') })), [p.edges, t]);
  const move = p.onMove;
  const changes = useCallback((items: NodeChange[]) => {
    for (const change of items) {
      if (change.type === 'position' && change.position && p.movable) move(change.id, change.position);
      if (change.type === 'select') setSelected(current => change.selected ? change.id : current === change.id ? null : current);
    }
  }, [move, p.movable]);
  return <div role="region" aria-label={t('dependencies.graphCanvas.dependencyGraph')} className="relative h-[34rem] w-full min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
    <ReactFlow nodes={nodes} edges={edges} onNodesChange={changes} nodesDraggable={p.movable} nodesConnectable={p.connectable} nodesFocusable edgesFocusable deleteKeyCode={null} onNodeDoubleClick={(_event, node) => p.onOpen(node.id)} onConnect={connection => { if (connection.source && connection.target && connection.source !== connection.target) p.onConnect(connection.source, connection.target); }} fitView minZoom={0.15} maxZoom={2} ariaLabelConfig={labels}>
      <Background /><Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
