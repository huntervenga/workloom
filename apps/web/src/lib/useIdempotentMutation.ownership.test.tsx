import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectRequest } from '../features/projects/api';
import { alpha, deferred, installFakeApi, ok, project } from '../test/fakeApi';
import { UncertainCommandError } from './idempotency';
import { protectedCommandsFor } from './protectedCommands';
import { createQueryClient } from './queryClient';
import { useIdempotentMutation, type IdempotentVariables } from './useIdempotentMutation';
interface Variables extends IdempotentVariables { name: string }
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const url = `/api/v1/workspaces/${alpha.id}/projects`;
const saved = project(alpha.id, 'e0000000-0000-4000-8000-000000000001', 'Created');
function mount() {
  const client = createQueryClient({ retry: false }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useIdempotentMutation({ prepare: (v: Variables) => createProjectRequest(alpha.id, { name: v.name }) }), { wrapper });
  return { client, view, hook: () => view.result.current, registry: protectedCommandsFor(client) };
}

describe('write hook actual command-slot exclusion', () => {
  it('is stable, excludes its pending command, sees another hook, and fails closed after unmount', async () => {
    const reply = deferred<Response>(); installFakeApi({ [`POST ${url}`]: () => reply.promise });
    const s = mount(), probe = s.hook().hasOtherProtectedCommands; let pending: Promise<unknown> | undefined;
    expect(typeof probe).toBe('function');
    act(() => { pending = s.hook().mutateAsync({ name: 'Created' }); });
    await waitFor(() => expect(s.hook().pendingCommand).not.toBeNull());
    expect(s.registry.protecting).toBe(true); expect(probe()).toBe(false);
    const other = s.registry.register(); other.set(true); expect(probe()).toBe(true); other.set(false); expect(probe()).toBe(false);
    expect(s.hook().hasOtherProtectedCommands).toBe(probe);
    await act(async () => { reply.resolve(ok(saved)); await pending; });
    expect(s.registry.protecting).toBe(false); expect(probe()).toBe(false);
    s.view.unmount(); other.set(true); expect(probe()).toBe(true); other.dispose();
  });

  it('does not weaken its own unknown request guard or exact body/key replay', async () => {
    let sends = 0;
    const { calls } = installFakeApi({ [`POST ${url}`]: () => { if (++sends === 1) throw new TypeError('Failed to fetch'); return ok(saved); } });
    const s = mount(); expect(typeof s.hook().hasOtherProtectedCommands).toBe('function');
    await act(async () => { await expect(s.hook().mutateAsync({ name: 'Created' })).rejects.toThrow(); });
    await waitFor(() => expect(s.hook().uncertain?.variables.name).toBe('Created'));
    expect(s.registry.protecting).toBe(true); expect(s.hook().hasOtherProtectedCommands()).toBe(false);
    await act(async () => { await expect(s.hook().mutateAsync({ name: 'Different' })).rejects.toBeInstanceOf(UncertainCommandError); });
    expect(calls.filter(call => call.path === url)).toHaveLength(1);
    const other = s.registry.register(); other.set(true); expect(s.hook().hasOtherProtectedCommands()).toBe(true); other.dispose();
    act(() => s.hook().retryUncertain()); await waitFor(() => expect(s.hook().uncertain).toBeNull());
    const sent = calls.filter(call => call.path === url); expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
    expect(s.registry.protecting).toBe(false);
  });
});
