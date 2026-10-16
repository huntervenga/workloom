import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useState } from 'react';
import { arrangeGraph, type LayoutEdge } from './layout';
import type { Point } from './useDependencyWorkspace';
export interface GraphCanvasTask { id: string; title: string; projectName: string; statusName: string; blocked: boolean; archived: boolean }
export interface GraphCanvasProps {
  tasks: readonly GraphCanvasTask[];
  edges: readonly LayoutEdge[];
  positions: Readonly<Record<string, Point>>;
  movable: boolean;
  connectable: boolean;
  onMove: (id: string, position: Point) => void;
  onConnect: (source: string, target: string) => void;
  onOpen: (id: string) => void;
}
const labels = {
  'controls.ariaLabel': 'Управление графом', 'controls.zoomIn.ariaLabel': 'Приблизить', 'controls.zoomOut.ariaLabel': 'Отдалить',
  'controls.fitView.ariaLabel': 'Показать весь выбранный граф', 'controls.interactive.ariaLabel': 'Переключить перемещение',
  'node.a11yDescription.default': 'Выберите задачу. Стрелки меняют только положение; кнопка внутри открывает карточку. Escape снимает выделение.',
  'node.a11yDescription.keyboardDisabled': 'Кнопка внутри узла открывает задачу. Escape снимает выделение.',
  'edge.a11yDescription.default': 'Связь: следующая задача начинается после предыдущей. Для изменения используйте список связей.',
};
export default function GraphCanvas(p: GraphCanvasProps) {
  const onOpen = p.onOpen;
  const [selected, setSelected] = useState<string | null>(null);
  const automatic = useMemo(() => p.tasks.every(task => p.positions[task.id] !== undefined) ? {} : arrangeGraph(p.tasks.map(task => task.id), p.edges), [p.tasks, p.edges, p.positions]);
  const nodes: Node[] = useMemo(() => p.tasks.map(task => ({
    id: task.id, position: p.positions[task.id] ?? automatic[task.id] ?? { x: 0, y: 0 }, selected: task.id === selected,
    sourcePosition: Position.Right, targetPosition: Position.Left, deletable: false,
    style: { width: 240, minHeight: 128, background: '#fff', borderColor: task.blocked ? '#f59e0b' : '#e2e8f0', borderRadius: 12 },
    ariaLabel: `${task.title}, ${task.projectName}, ${task.statusName}${task.blocked ? ', есть незавершённые предшественники' : ''}`,
    data: { label: <div className="space-y-2 text-left"><button type="button" className="nodrag nopan line-clamp-2 w-full rounded text-left text-sm font-semibold text-accent-ink" onClick={e => { e.stopPropagation(); onOpen(task.id); }}>{task.title}</button><p className="text-xs text-muted [overflow-wrap:anywhere]">{task.projectName} · {task.statusName}{task.archived ? ' · в архиве' : ''}</p>{task.blocked ? <p className="text-xs text-amber-800">Есть незавершённые предшественники</p> : null}</div> },
  })), [p.tasks, p.positions, onOpen, automatic, selected]);
  const edges: Edge[] = useMemo(() => p.edges.map(edge => ({ ...edge, deletable: false, markerEnd: { type: MarkerType.ArrowClosed }, ariaLabel: 'Следующая задача начинается после завершения предыдущей' })), [p.edges]);
  const move = p.onMove;
  const changes = useCallback((items: NodeChange[]) => {
    for (const change of items) {
      if (change.type === 'position' && change.position && p.movable) move(change.id, change.position);
      if (change.type === 'select') setSelected(current => change.selected ? change.id : current === change.id ? null : current);
    }
  }, [move, p.movable]);
  return <div role="region" aria-label="Граф зависимостей" className="relative h-[34rem] w-full min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
    <ReactFlow nodes={nodes} edges={edges} onNodesChange={changes} nodesDraggable={p.movable} nodesConnectable={p.connectable} nodesFocusable edgesFocusable deleteKeyCode={null} onNodeDoubleClick={(_event, node) => p.onOpen(node.id)} onConnect={connection => { if (connection.source && connection.target && connection.source !== connection.target) p.onConnect(connection.source, connection.target); }} fitView minZoom={0.15} maxZoom={2} ariaLabelConfig={labels}>
      <Background /><Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
