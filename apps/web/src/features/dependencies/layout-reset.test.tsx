import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { layout, PROJECT_ID, rootPath, taskAt } from './test/fixtures';
import { useDependencyWorkspace } from './useDependencyWorkspace';

const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });

describe('saving positions after a complete layout reset', () => {
  it.each([false, true])('retires the reset intent after a nonempty save (lost response: %s)', async lostResponse => {
    const client = createQueryClient({ retry: false });
    clients.push(client);
    const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const visible = taskAt(1), hidden = taskAt(2);
    const savedPositions = [{ taskId: visible.id, x: 120, y: 240 }];
    let sends = 0;
    const { calls } = installFakeApi({
      [`PUT ${rootPath}/projects/${PROJECT_ID}/graph-layout`]: () => {
        sends += 1;
        if (lostResponse && sends === 1) throw new TypeError('Response lost after commit');
        return ok(layout(savedPositions, 4));
      },
    });
    const view = renderHook(() => useDependencyWorkspace(anna.id, alpha.id, PROJECT_ID), { wrapper: Wrapper });
    act(() => view.result.current.adoptLayout(layout([{ taskId: hidden.id, x: 5, y: 10 }], 3)));
    act(() => view.result.current.resetLayout());
    act(() => view.result.current.move(visible.id, { x: 120, y: 240 }));
    const input = view.result.current.layoutInput;
    if (!input) throw new Error('Expected loaded layout');
    expect(input).toEqual({ expectedRevision: 3, positions: savedPositions });
    expect(view.result.current.layout.reset).toBe(true);
    act(() => view.result.current.commands.layout.mutate({ input }));
    if (lostResponse) {
      await waitFor(() => expect(view.result.current.commands.layout.uncertain).not.toBeNull());
      expect(view.result.current.layout.reset).toBe(true);
      act(() => view.result.current.commands.layout.retryUncertain());
    }
    await waitFor(() => expect(view.result.current.commands.layout.isSuccess).toBe(true));
    await waitFor(() => expect(view.result.current.layoutDirty).toBe(false));
    expect(view.result.current.layout.reset).toBe(false);
    expect(view.result.current.layout.moves).toEqual({});
    // The next full replacement remains the saved layout, never an accidental clear.
    expect(view.result.current.layoutInput).toEqual({ expectedRevision: 4, positions: savedPositions });
    expect(calls).toHaveLength(lostResponse ? 2 : 1);
    expect(calls.every(call => JSON.stringify(call.body) === JSON.stringify(input))).toBe(true);
    if (lostResponse) expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
  });
});
