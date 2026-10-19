import { reportMutationObserverFailure } from './mutationDiagnostics';
import type { QueryClient } from '@tanstack/react-query';
/** Neutral confirmed-write event. Feature listeners may use it as a keyboard history boundary. */
export interface MutationAcknowledgement { fingerprint: string; path: string; actorId: string | null; idempotencyKey: string; receipt: string; observerFailed?: boolean }
const listeners = new WeakMap<QueryClient, Set<(ack: MutationAcknowledgement) => void>>();
export function subscribeMutationAcknowledgements(client: QueryClient, listener: (ack: MutationAcknowledgement) => void) {
  let entries = listeners.get(client); if (!entries) { entries = new Set(); listeners.set(client, entries); }
  entries.add(listener); return () => entries.delete(listener);
}
export function publishMutationAcknowledgement(client: QueryClient, ack: MutationAcknowledgement) {
  for (const listener of listeners.get(client) ?? []) {
    try { listener(ack); } catch { reportMutationObserverFailure(); }
  }
}
