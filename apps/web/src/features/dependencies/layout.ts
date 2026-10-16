import { t } from '../../i18n';
import dagre from '@dagrejs/dagre';
import { GraphLayoutBoundsError, type GraphNodeSize } from './GraphNodeContent';
import type { Point } from './useDependencyWorkspace';

export interface LayoutEdge { id: string; source: string; target: string }
const COORDINATE_LIMIT = 100000;

/** Only generated positions pass through here; saved and user-moved coordinates are untouched. */
export function fitAutomaticPositions(positions: Readonly<Record<string, Point>>): Record<string, Point> {
  const entries = Object.entries(positions).sort(([a], [b]) => a.localeCompare(b));
  if (entries.some(([, point]) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error(t('dependencies.layout.couldNotCalculateFiniteGraphPositions'));
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
    throw new Error(t('dependencies.layout.couldNotCalculateFiniteGraphBounds'));
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
export function arrangeGraph(ids: readonly string[], edges: readonly LayoutEdge[], sizes?: Readonly<Record<string, GraphNodeSize>>): Record<string, Point> {
  const orderedIds = [...ids].sort();
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 90, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const id of orderedIds) {
    const size = sizes ? sizes[id] : { width: 240, height: 128 };
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw new Error(t('dependencies.layout.couldNotMeasureNodes'));
    // Dagre mutates its node labels; never let it mutate React-owned measurements.
    graph.setNode(id, { width: size.width, height: size.height });
  }
  const known = new Set(ids);
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (known.has(edge.source) && known.has(edge.target)) graph.setEdge(edge.source, edge.target);
  }
  dagre.layout(graph);
  const positions = Object.fromEntries(orderedIds.map(id => {
    const node = graph.node(id);
    return [id, { x: node.x - node.width / 2, y: node.y - node.height / 2 }];
  }));
  if (!sizes || orderedIds.length === 0) return fitAutomaticPositions(positions);
  const rectangles = orderedIds.map(id => {
    const point = positions[id], size = sizes[id];
    if (!point || !size) throw new Error(t('dependencies.layout.couldNotMeasureNodes'));
    return { id, ...point, width: size.width, height: size.height };
  });
  const minX = Math.min(...rectangles.map(rect => rect.x)), minY = Math.min(...rectangles.map(rect => rect.y));
  const maxX = Math.max(...rectangles.map(rect => rect.x + rect.width)), maxY = Math.max(...rectangles.map(rect => rect.y + rect.height));
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX - minX > COORDINATE_LIMIT * 2 || maxY - minY > COORDINATE_LIMIT * 2) throw new GraphLayoutBoundsError(t('dependencies.layout.measuredLayoutTooLarge'));
  // Translate complete rectangles only; scaling coordinates would compress the gaps between cards.
  const dx = minX < -COORDINATE_LIMIT || maxX > COORDINATE_LIMIT ? -(minX + maxX) / 2 : 0;
  const dy = minY < -COORDINATE_LIMIT || maxY > COORDINATE_LIMIT ? -(minY + maxY) / 2 : 0;
  return Object.fromEntries(rectangles.map(rect => [rect.id, { x: rect.x + dx, y: rect.y + dy }]));
}
