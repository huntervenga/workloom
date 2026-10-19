import { useRef } from 'react';
import { layoutReceiptKey, newestLayout, reconcileLayoutAck } from './layoutReceiptCache';
import { recordLayoutUndo } from '../undo/recordSpatialUndo';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTaskDependencyInput, UpdateTaskDependencyInput, UpdateDependencyPolicyInput, SetGraphLayoutInput, TaskDependencyDto, GraphLayoutDto, ProjectDependencyPolicyDto, DependencyGraphDto } from '@workloom/contracts';
import { isUuid } from '../../lib/format';
import { invalidateTaskTimelines } from '../task-comments/queries';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { fetchDependencyPage, fetchTaskBlocking, fetchDependencyGraph, fetchDependencyPolicy, fetchGraphLayout, createDependencyRequest, updateDependencyRequest, updatePolicyRequest, setLayoutRequest } from './api';
export const dependencyKeys = {
  root: (a: string, w: string) => [...queryKeys.workspace(a, w), 'dependencies'] as const,
  task: (a: string, w: string, t: string) => [...dependencyKeys.root(a, w), 'task', t.toLowerCase()] as const,
  blocking: (a: string, w: string, t: string) => [...dependencyKeys.task(a, w, t), 'blocking'] as const,
  graph: (a: string, w: string, p: string, roots: readonly string[], depth: number) => [...dependencyKeys.root(a, w), 'graph', p.toLowerCase(), [...roots].sort().join(','), depth] as const,
  policy: (a: string, w: string, p: string) => [...dependencyKeys.root(a, w), 'policy', p.toLowerCase()] as const,
  layout: layoutReceiptKey,
};
export const useDependenciesQuery = (a: string, w: string, t: string, enabled = true) => useInfiniteQuery({ queryKey: dependencyKeys.task(a, w, t), queryFn: ({ signal, pageParam }) => fetchDependencyPage(w, { taskId: t, direction: 'both', state: 'all', limit: 10, ...(pageParam ? { cursor: pageParam } : {}) }, signal), initialPageParam: null as string | null, getNextPageParam: page => page.meta.nextCursor ?? null, enabled: enabled && isUuid(t), retry: false });
export const useBlockingQuery = (a: string, w: string, t: string, enabled = true) => useInfiniteQuery({ queryKey: dependencyKeys.blocking(a, w, t), queryFn: ({ signal, pageParam }) => fetchTaskBlocking(w, t, { limit: 10, ...(pageParam ? { cursor: pageParam } : {}) }, signal), initialPageParam: null as string | null, getNextPageParam: page => page.meta.nextCursor ?? null, enabled: enabled && isUuid(t), retry: false });
export function useGraphQuery(a: string, w: string, p: string, roots: string[], depth: number) {
  const client = useQueryClient();
  const key = dependencyKeys.graph(a, w, p, roots, depth);
  return useQuery({ queryKey: key, queryFn: async ({ signal }) => {
    const incoming = await fetchDependencyGraph(w, p, { rootTaskIds: roots, neighborDepth: depth }, signal);
    const cached = client.getQueryData<DependencyGraphDto>(key);
    return cached !== undefined && BigInt(cached.asOfChangeSeq) > BigInt(incoming.asOfChangeSeq) ? cached : incoming;
  }, enabled: roots.length > 0 && roots.length <= 100, retry: false });
}
export const usePolicyQuery = (a: string, w: string, p: string) => useQuery({ queryKey: dependencyKeys.policy(a, w, p), queryFn: ({ signal }) => fetchDependencyPolicy(w, p, signal), enabled: isUuid(p), retry: false });
export function useLayoutQuery(a: string, w: string, p: string) {
  const client = useQueryClient();
  const queryKey = dependencyKeys.layout(a, w, p);
  return useQuery({ queryKey, queryFn: async ({ signal }) => { const incoming = await fetchGraphLayout(w, p, signal); return newestLayout(client.getQueryData<GraphLayoutDto>(queryKey), incoming); }, enabled: isUuid(p), retry: false });
}
export interface EdgeCreateVariables extends IdempotentVariables { draftId: string; anchorTaskId: string; input: CreateTaskDependencyInput }
export interface EdgeUpdateVariables extends IdempotentVariables { anchorTaskId: string; edge: TaskDependencyDto; input: UpdateTaskDependencyInput }
export interface PolicyVariables extends IdempotentVariables { input: UpdateDependencyPolicyInput }
export interface LayoutVariables extends IdempotentVariables { input: SetGraphLayoutInput }
export function useDependencyCommands(a: string, w: string, p: string, callbacks: {
  onCreate?: ((data: TaskDependencyDto, variables: EdgeCreateVariables) => void) | undefined;
  onLayout?: ((data: GraphLayoutDto, variables: LayoutVariables) => void) | undefined;
  onPolicy?: ((data: ProjectDependencyPolicyDto, variables: PolicyVariables) => void) | undefined;
} = {}) {
  const client = useQueryClient();
  const refresh = () => { void invalidateTaskTimelines(client, a, w); void client.invalidateQueries({ queryKey: dependencyKeys.root(a, w) }); void client.invalidateQueries({ queryKey: queryKeys.tasks(a, w) }); };
  const create = useIdempotentMutation({ prepare: (v: EdgeCreateVariables) => createDependencyRequest(w, v.input), onSuccess: (data, variables) => { callbacks.onCreate?.(data, variables); refresh(); } });
  const update = useIdempotentMutation({ prepare: (v: EdgeUpdateVariables) => updateDependencyRequest(w, v.edge.id, v.input), onSuccess: refresh });
  const policy = useIdempotentMutation({ prepare: (v: PolicyVariables) => updatePolicyRequest(w, p, v.input), onSuccess: (data, variables) => { callbacks.onPolicy?.(data, variables); refresh(); } });
  const layoutSnapshots = useRef(new WeakMap<LayoutVariables, GraphLayoutDto | undefined>()).current;
  const layout = useIdempotentMutation({ prepare: (v: LayoutVariables) => {
    if (!layoutSnapshots.has(v)) {
      const before = client.getQueryData<GraphLayoutDto>(dependencyKeys.layout(a, w, p));
      layoutSnapshots.set(v, before?.revision === v.input.expectedRevision ? structuredClone(before) : undefined);
    }
    return setLayoutRequest(w, p, v.input);
  }, onSuccess: async (data, variables, ack) => {
    if (ack.actorId !== null && ack.actorId !== a) return;
    if (ack.actorId === a) recordLayoutUndo(client, a, w, p, layoutSnapshots.get(variables), data, variables.input, ack.receipt);
    await reconcileLayoutAck(client, a, w, p, data);
    callbacks.onLayout?.(data, variables); void client.invalidateQueries({ queryKey: dependencyKeys.layout(a, w, p) });
  } });
  return { create, update, policy, layout };
}
