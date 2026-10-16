import dagre from '@dagrejs/dagre';
import type { Point } from './useDependencyWorkspace';

export interface LayoutEdge { id: string; source: string; target: string }
const COORDINATE_LIMIT = 100000;

/** Only generated positions pass through here; saved and user-moved coordinates are untouched. */
export function fitAutomaticPositions(positions: Readonly<Record<string, Point>>): Record<string, Point> {
  const entries = Object.entries(positions).sort(([a], [b]) => a.localeCompare(b));
  if (entries.some(([, point]) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error('Не удалось вычислить конечные координаты графа.');
  }
  if (entries.every(([, point]) => Math.abs(point.x) <= COORDINATE_LIMIT && Math.abs(point.y) <= COORDINATE_LIMIT)) {
    return Object.fromEntries(entries);
  }
  const xs = entries.map(([, point]) => point.x);
  const ys = entries.map(([, point]) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX, spanY = maxY - minY;
  if (!Number.isFinite(spanX) || !Number.isFinite(spanY)) {
    throw new Error('Не удалось вычислить конечные границы графа.');
  }
  const centerX = minX + spanX / 2;
  const centerY = minY + spanY / 2;
  const scale = Math.min(1, COORDINATE_LIMIT * 2 / Math.max(spanX, spanY));
  // Clamping only absorbs floating-point rounding at the normalized bounding-box edge.
  const bounded = (value: number) => Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, value));
  return Object.fromEntries(entries.map(([id, point]) => [id, {
    x: bounded((point.x - centerX) * scale),
    y: bounded((point.y - centerY) * scale),
  }]));
}

/** A deterministic view layout; coordinates have no task-date or scheduling meaning. */
export function arrangeGraph(ids: readonly string[], edges: readonly LayoutEdge[]): Record<string, Point> {
  const orderedIds = [...ids].sort();
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 90, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const id of orderedIds) graph.setNode(id, { width: 240, height: 128 });
  const known = new Set(ids);
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (known.has(edge.source) && known.has(edge.target)) graph.setEdge(edge.source, edge.target);
  }
  dagre.layout(graph);
  const positions = Object.fromEntries(orderedIds.map(id => {
    const node = graph.node(id);
    return [id, { x: node.x - 120, y: node.y - 64 }];
  }));
  return fitAutomaticPositions(positions);
}
