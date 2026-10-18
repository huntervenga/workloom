import type { TaskStatusGroup } from '@workloom/contracts';
import type { CSSProperties } from 'react';
import type { LayoutEdge } from './layout';

/** Graph edges are active finish-to-start edges; only a predecessor in the done group resolves one. */
export type GraphEdgeState = 'unresolved' | 'resolved';
export interface PresentedGraphEdge extends LayoutEdge { state: GraphEdgeState }
export interface GraphPresentationTask { id: string; statusGroup?: TaskStatusGroup | undefined; blocked: boolean; violatesCurrentStatus?: boolean | undefined }
export interface GraphNeighborhood {
  focusId: string;
  predecessors: PresentedGraphEdge[];
  successors: PresentedGraphEdge[];
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
}
export type GraphEmphasis = 'normal' | 'focused' | 'dimmed';

/** Only the done status group resolves an edge, including for archived predecessors; unknown stays unresolved. */
export function graphEdgeState(predecessorGroup: TaskStatusGroup | undefined): GraphEdgeState {
  return predecessorGroup === 'done' ? 'resolved' : 'unresolved';
}

export function presentGraphEdges(edges: readonly LayoutEdge[], tasks: readonly GraphPresentationTask[]): PresentedGraphEdge[] {
  const groups = new Map(tasks.map(task => [task.id, task.statusGroup]));
  return edges.map(edge => ({ ...edge, state: graphEdgeState(groups.get(edge.source)) }));
}

/** Direct predecessors and successors inside the loaded graph only; never a workspace-wide claim. */
export function graphNeighborhood(focusId: string | null, edges: readonly PresentedGraphEdge[]): GraphNeighborhood | null {
  if (focusId === null) return null;
  const predecessors = edges.filter(edge => edge.target === focusId);
  const successors = edges.filter(edge => edge.source === focusId);
  return {
    focusId, predecessors, successors,
    nodeIds: new Set([focusId, ...predecessors.map(edge => edge.source), ...successors.map(edge => edge.target)]),
    edgeIds: new Set([...predecessors, ...successors].map(edge => edge.id)),
  };
}

export function nodeEmphasis(id: string, focus: GraphNeighborhood | null): GraphEmphasis {
  return focus === null ? 'normal' : id === focus.focusId ? 'focused' : focus.nodeIds.has(id) ? 'normal' : 'dimmed';
}
export function edgeEmphasis(id: string, focus: GraphNeighborhood | null): GraphEmphasis {
  return focus === null ? 'normal' : focus.edgeIds.has(id) ? 'focused' : 'dimmed';
}

// Theme tokens from @workloom/ui/styles.css, so light and dark each get a readable stroke.
const edgeColors: Record<GraphEdgeState, string> = { unresolved: 'var(--color-graph-edge-unresolved)', resolved: 'var(--color-graph-edge-resolved)' };
export function graphEdgeColor(state: GraphEdgeState): string { return edgeColors[state]; }

/** Dash pattern and width carry the state too, so it never depends on color alone. */
export function graphEdgeStyle(state: GraphEdgeState, emphasis: GraphEmphasis): CSSProperties {
  const width = state === 'unresolved' ? 2 : 1.5;
  return {
    stroke: edgeColors[state],
    strokeWidth: emphasis === 'focused' ? width + 1.5 : width,
    ...(state === 'resolved' ? { strokeDasharray: '6 4' } : {}),
    opacity: emphasis === 'dimmed' ? 0.2 : 1,
  };
}

/** Border, background and ring only; borderWidth stays shared with the measurement host. */
export function graphNodeTone(task: GraphPresentationTask, emphasis: GraphEmphasis): CSSProperties {
  const violation = task.violatesCurrentStatus === true;
  const done = task.statusGroup === 'done';
  const rings = [violation ? '0 0 0 2px var(--color-danger-soft)' : null, emphasis === 'focused' ? '0 0 0 4px var(--color-focus)' : null].filter(ring => ring !== null);
  return {
    borderColor: violation ? 'var(--color-danger-line)' : task.blocked ? 'var(--color-warning-line)' : done ? 'var(--color-success-line)' : 'var(--color-line)',
    background: done ? 'var(--color-success-soft)' : 'var(--color-surface)',
    boxShadow: rings.length ? rings.join(', ') : 'none',
    opacity: emphasis === 'dimmed' ? 0.35 : 1,
  };
}
