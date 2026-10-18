import { describe, expect, it } from 'vitest';
import { edgeEmphasis, graphEdgeState, graphEdgeStyle, graphNeighborhood, graphNodeTone, nodeEmphasis, presentGraphEdges } from './graphPresentation';

const edges = [
  { id: 'e-ab', source: 'a', target: 'b' },
  { id: 'e-db', source: 'd', target: 'b' },
  { id: 'e-bc', source: 'b', target: 'c' },
  { id: 'e-ea', source: 'e', target: 'a' },
];

describe('graph edge resolution follows the domain rule', () => {
  it('resolves only a predecessor in the done group; cancelled, active and unknown stay unresolved', () => {
    expect(graphEdgeState('done')).toBe('resolved');
    for (const group of ['todo', 'in_progress', 'cancelled', undefined] as const) expect(graphEdgeState(group)).toBe('unresolved');
  });
  it('reads the predecessor status, never the successor, and treats a missing predecessor as unresolved', () => {
    const presented = presentGraphEdges(edges, [
      { id: 'a', statusGroup: 'todo', blocked: false },
      { id: 'b', statusGroup: 'done', blocked: true },
      { id: 'd', statusGroup: 'done', blocked: false },
    ]);
    expect(Object.fromEntries(presented.map(edge => [edge.id, edge.state]))).toEqual({ 'e-ab': 'unresolved', 'e-db': 'resolved', 'e-bc': 'resolved', 'e-ea': 'unresolved' });
    expect(presented.map(({ id, source, target }) => ({ id, source, target }))).toEqual(edges);
  });
});

describe('selected-task neighborhood', () => {
  const presented = presentGraphEdges(edges, []);
  it('contains direct predecessors and successors only', () => {
    const focus = graphNeighborhood('b', presented);
    expect(focus?.predecessors.map(edge => edge.source)).toEqual(['a', 'd']);
    expect(focus?.successors.map(edge => edge.target)).toEqual(['c']);
    expect([...(focus?.nodeIds ?? [])].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...(focus?.edgeIds ?? [])].sort()).toEqual(['e-ab', 'e-bc', 'e-db']);
    expect(nodeEmphasis('b', focus ?? null)).toBe('focused');
    expect(nodeEmphasis('a', focus ?? null)).toBe('normal');
    expect(nodeEmphasis('e', focus ?? null)).toBe('dimmed');
    expect(edgeEmphasis('e-ab', focus ?? null)).toBe('focused');
    expect(edgeEmphasis('e-ea', focus ?? null)).toBe('dimmed');
  });
  it('dims nothing without a selection', () => {
    expect(graphNeighborhood(null, presented)).toBeNull();
    expect(nodeEmphasis('e', null)).toBe('normal');
    expect(edgeEmphasis('e-ea', null)).toBe('normal');
  });
});

describe('non-color cues and measurement parity', () => {
  it('dashes resolved edges, keeps unresolved solid, and widens or dims by emphasis', () => {
    expect(graphEdgeStyle('resolved', 'normal')).toMatchObject({ strokeDasharray: '6 4', strokeWidth: 1.5, opacity: 1 });
    expect(graphEdgeStyle('unresolved', 'normal')).not.toHaveProperty('strokeDasharray');
    expect(graphEdgeStyle('unresolved', 'focused').strokeWidth).toBe(3.5);
    expect(graphEdgeStyle('unresolved', 'dimmed').opacity).toBe(0.2);
    expect(graphEdgeStyle('unresolved', 'normal').stroke).toBe('var(--color-graph-edge-unresolved)');
    expect(graphEdgeStyle('resolved', 'normal').stroke).toBe('var(--color-graph-edge-resolved)');
  });
  it('gives a violation priority over blocking and done, and never changes the measured border width', () => {
    const violation = graphNodeTone({ id: 'c', statusGroup: 'done', blocked: true, violatesCurrentStatus: true }, 'normal');
    expect(violation).toMatchObject({ borderColor: 'var(--color-danger-line)', background: 'var(--color-success-soft)' });
    expect(violation.boxShadow).toBe('0 0 0 2px var(--color-danger-soft)');
    expect(graphNodeTone({ id: 'b', statusGroup: 'done', blocked: true }, 'normal').borderColor).toBe('var(--color-warning-line)');
    expect(graphNodeTone({ id: 'a', statusGroup: 'done', blocked: false }, 'normal').borderColor).toBe('var(--color-success-line)');
    expect(graphNodeTone({ id: 'x', blocked: false }, 'normal')).toMatchObject({ borderColor: 'var(--color-line)', background: 'var(--color-surface)', boxShadow: 'none' });
    expect(graphNodeTone({ id: 'x', blocked: false }, 'focused').boxShadow).toBe('0 0 0 4px var(--color-focus)');
    expect(graphNodeTone({ id: 'x', blocked: false }, 'dimmed').opacity).toBe(0.35);
    for (const tone of [violation, graphNodeTone({ id: 'x', blocked: false }, 'focused')]) {
      expect(tone).not.toHaveProperty('borderWidth');
      expect(tone).not.toHaveProperty('padding');
    }
  });
});
