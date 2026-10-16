import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { setGraphLayoutInputSchema } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna } from '../../test/fakeApi';
import { arrangeGraph, fitAutomaticPositions } from './layout';
import { layout, PROJECT_ID, taskAt } from './test/fixtures';
import { useDependencyWorkspace } from './useDependencyWorkspace';

function chain(count: number) {
  const ids = Array.from({ length: count }, (_, index) => taskAt(index + 1).id);
  const edges = ids.slice(1).map((target, index) => ({ id: String(index).padStart(4, '0'), source: ids[index] ?? '', target }));
  return { ids, edges };
}

describe('automatic graph layout at the supported node limit', () => {
  it('keeps all 500 real Dagre chain positions valid and accepted by the complete-layout controller', () => {
    const { ids, edges } = chain(500);
    const positions = arrangeGraph(ids, edges);
    expect(Object.keys(positions)).toHaveLength(500);
    expect(Object.values(positions).every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 100000 && Math.abs(point.y) <= 100000)).toBe(true);
    const client = createQueryClient({ retry: false });
    const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useDependencyWorkspace(anna.id, alpha.id, PROJECT_ID), { wrapper: Wrapper });
    try {
      act(() => view.result.current.adoptLayout(layout()));
      act(() => { for (const [id, position] of Object.entries(positions)) view.result.current.move(id, position); });
      expect(view.result.current.layoutInput?.positions).toHaveLength(500);
      expect(setGraphLayoutInputSchema.safeParse(view.result.current.layoutInput).success).toBe(true);
      expect(view.result.current.layoutInput?.positions).toEqual(ids.map(taskId => ({ taskId, ...positions[taskId] })));
    } finally { view.unmount(); client.clear(); }
  });

  it('keeps deterministic positions and stable ID order when graph inputs arrive in a different order', () => {
    const { ids, edges } = chain(500);
    const forward = arrangeGraph(ids, edges);
    const reverse = arrangeGraph([...ids].reverse(), [...edges].reverse());
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
  });
});


describe('automatic-coordinate normalization', () => {
  it('translates an outlying layout without changing distances when its span fits', () => {
    const input = { b: { x: 150000, y: 400 }, a: { x: 100000, y: 200 } };
    expect(fitAutomaticPositions(input)).toEqual({ a: { x: -25000, y: -100 }, b: { x: 25000, y: 100 } });
    expect(input.a.x).toBe(100000);
  });

  it('uniformly scales an oversized bounding box without clipping individual nodes or changing aspect ratio', () => {
    expect(fitAutomaticPositions({ a: { x: 0, y: 0 }, b: { x: 400000, y: 160000 }, c: { x: 200000, y: 80000 } })).toEqual({
      a: { x: -100000, y: -40000 }, b: { x: 100000, y: 40000 }, c: { x: 0, y: 0 },
    });
  });

  it('leaves a small generated layout unchanged and rejects nonfinite generation explicitly', () => {
    expect(fitAutomaticPositions({ a: { x: 24, y: 24 } })).toEqual({ a: { x: 24, y: 24 } });
    expect(() => fitAutomaticPositions({ a: { x: Infinity, y: 0 } })).toThrow();
  });
});
