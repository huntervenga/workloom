import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { ApiError } from './api';

export interface WorkspaceHeadDenial { readonly error: ApiError }
interface Denials { values: Map<string, WorkspaceHeadDenial>; listeners: Set<() => void> }
const clients = new WeakMap<QueryClient, Denials>();
function denials(client: QueryClient): Denials {
  let state = clients.get(client);
  if (!state) { state = { values: new Map(), listeners: new Set() }; clients.set(client, state); }
  return state;
}
const key = (actorId: string, workspaceId: string) => JSON.stringify([actorId, workspaceId]);

/** A head denial survives root query state changes; only explicit access recovery releases it. */
export function workspaceHeadDenial(client: QueryClient, actorId: string, workspaceId: string): WorkspaceHeadDenial | null {
  return denials(client).values.get(key(actorId, workspaceId)) ?? null;
}
export function setWorkspaceHeadDenial(client: QueryClient, actorId: string, workspaceId: string, error: ApiError): void {
  const state = denials(client);
  state.values.set(key(actorId, workspaceId), { error });
  for (const listener of state.listeners) listener();
}
export function clearWorkspaceHeadDenial(client: QueryClient, actorId: string, workspaceId: string, expected: WorkspaceHeadDenial): void {
  if (workspaceHeadDenial(client, actorId, workspaceId) !== expected) return;
  const state = denials(client); state.values.delete(key(actorId, workspaceId));
  for (const listener of state.listeners) listener();
}
export function useWorkspaceHeadDenial(client: QueryClient, actorId: string, workspaceId: string): WorkspaceHeadDenial | null {
  const state = denials(client);
  return useSyncExternalStore(listener => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
    () => workspaceHeadDenial(client, actorId, workspaceId));
}
