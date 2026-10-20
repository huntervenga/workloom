import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import type { MeDto, MembershipDto, ProjectDto, WorkspaceChangeHeadDto, WorkspaceDto } from '@workloom/contracts';
import { queryKeys } from '../../lib/queryKeys';

export interface WorkspacePresentationProof { appliedHead: WorkspaceChangeHeadDto | null; targetHead: WorkspaceChangeHeadDto }
const sameAuthority = (a: WorkspaceChangeHeadDto, b: WorkspaceChangeHeadDto) => a.actorUserId === b.actorUserId && a.workspaceId === b.workspaceId && a.membershipId === b.membershipId && a.membershipRevision === b.membershipRevision && a.role === b.role && a.permissionEpoch === b.permissionEpoch;
const clean = (query: Query | undefined): query is Query => !!query && query.state.status === 'success' && query.state.fetchStatus === 'idle' && query.state.fetchFailureCount === 0 && !query.state.isInvalidated && query.state.data !== undefined;
const fingerprint = (data: unknown) => JSON.stringify(data);
interface Captured { query: Query; fingerprint: string; promise: Promise<unknown> | undefined }
interface Lease {
 actorId: string; workspaceId: string; projects: Map<string, Captured>; workspace: Captured; me: Captured; members: Captured;
 head: WorkspaceChangeHeadDto; safe: () => boolean; signal: AbortSignal;
 invalidations: Set<Query>; starting: Set<Query>; sealed: boolean; invalidating: boolean;
}
class PresentationStore {
 private leases = new Set<Lease>();
 private listeners = new Set<() => void>();
 constructor(private client: QueryClient) { client.getQueryCache().subscribe(event => {
  let changed = false;
  for (const lease of this.leases) {
   const authority = this.captures(lease).find(item => item.query === event.query);
   if (authority && event.type === 'updated' && event.action.type === 'invalidate') {
    if (!lease.invalidating || !lease.invalidations.delete(event.query)) { this.leases.delete(lease); changed = true; continue; }
   }
   if (authority && event.type === 'updated' && event.action.type === 'fetch' && !lease.starting.has(event.query)) { this.leases.delete(lease); changed = true; continue; }
   if (!this.valid(lease)) { this.leases.delete(lease); changed = true; }
  }
  // Query state and lease ownership both affect the snapshot, including strict access rechecks.
  if (changed || this.leases.size) this.emit();
 }); }
 private captures = (lease: Lease) => [lease.me, lease.workspace, lease.members, ...lease.projects.values()];
 private emit = () => { for (const listener of this.listeners) listener(); };
 subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
 private valid(lease: Lease): boolean {
  if (lease.signal.aborted || !lease.safe()) return false;
  const cache = this.client.getQueryCache(), head = this.client.getQueryState<WorkspaceChangeHeadDto>(queryKeys.workspaceChangeHead(lease.actorId, lease.workspaceId));
  if (head?.status !== 'success' || head.isInvalidated || head.fetchFailureCount > 0 || head.fetchStatus === 'paused' || !head.data || !sameAuthority(head.data, lease.head)) return false;
  return this.captures(lease).every(captured => cache.get(captured.query.queryHash) === captured.query && captured.query.state.status === 'success' && captured.query.state.fetchFailureCount === 0 && captured.query.state.fetchStatus !== 'paused' && fingerprint(captured.query.state.data) === captured.fingerprint &&
   (lease.starting.has(captured.query) || captured.query.state.fetchStatus === 'idle' || captured.query.promise === captured.promise));
 }
 allows = (actorId: string, workspaceId: string, projectId: string) => [...this.leases].some(lease => lease.actorId === actorId && lease.workspaceId === workspaceId && lease.projects.has(projectId) && this.valid(lease));
 revoke = (actorId: string, workspaceId: string) => { let changed = false; for (const lease of this.leases) if (lease.actorId === actorId && lease.workspaceId === workspaceId) { this.leases.delete(lease); changed = true; } if (changed) this.emit(); };
 begin(actorId: string, workspaceId: string, initialized: readonly Query[], proof: WorkspacePresentationProof | undefined, signal: AbortSignal, safe: () => boolean) {
  const empty = { retaining: () => false, invalidate: (work: () => Promise<void>) => work(), start: <T,>(_: Query, work: () => T): T => work(), seal: () => undefined, end: () => undefined };
  if (!proof?.appliedHead || !sameAuthority(proof.appliedHead, proof.targetHead) || proof.targetHead.actorUserId !== actorId || proof.targetHead.workspaceId !== workspaceId || signal.aborted || !safe()) return empty;
  const cache = this.client.getQueryCache(), find = (key: readonly unknown[]) => cache.find({ queryKey: key, exact: true });
  const me = find(queryKeys.me), workspace = find(queryKeys.workspace(actorId, workspaceId)), members = find(queryKeys.memberships(actorId, workspaceId)), head = find(queryKeys.workspaceChangeHead(actorId, workspaceId));
  if (!clean(me) || !clean(workspace) || !clean(members) || !clean(head) || (me.state.data as MeDto).actor.id !== actorId || (workspace.state.data as WorkspaceDto).id !== workspaceId || (workspace.state.data as WorkspaceDto).role !== proof.targetHead.role || !sameAuthority(head.state.data as WorkspaceChangeHeadDto, proof.targetHead) || (head.state.data as WorkspaceChangeHeadDto).changeSeq !== proof.targetHead.changeSeq) return empty;
  if (!(members.state.data as MembershipDto[]).some(member => member.id === proof.targetHead.membershipId && member.userId === actorId && member.workspaceId === workspaceId && member.role === proof.targetHead.role)) return empty;
  if (!initialized.includes(workspace)) return empty;
  const capture = (query: Query): Captured => ({ query, fingerprint: fingerprint(query.state.data), promise: query.promise });
  const projects = new Map<string, Captured>(), prefix = queryKeys.workspace(actorId, workspaceId);
  for (const query of initialized) {
   const key = query.queryKey;
   if (key.length !== prefix.length + 2 || !prefix.every((part, index) => key[index] === part) || key[prefix.length] !== 'project' || !clean(query)) continue;
   const project = query.state.data as ProjectDto;
   if (project.id === key[prefix.length + 1] && project.workspaceId === workspaceId && project.archivedAt === null) projects.set(project.id, capture(query));
  }
  if (!projects.size) return empty;
  this.revoke(actorId, workspaceId);
  const lease: Lease = { actorId, workspaceId, projects, workspace: capture(workspace), me: capture(me), members: capture(members), head: proof.targetHead, safe, signal, invalidations: new Set([workspace, members, ...[...projects.values()].map(item => item.query)]), starting: new Set(), sealed: false, invalidating: false };
  const end = () => { signal.removeEventListener('abort', end); if (this.leases.delete(lease)) this.emit(); };
  signal.addEventListener('abort', end, { once: true }); this.leases.add(lease); this.emit();
  return {
   retaining: () => this.leases.has(lease) && this.valid(lease),
   // This call and start() calls must run in the same synchronous startup turn.
   invalidate: (work: () => Promise<void>) => { if (lease.sealed) { end(); return work(); } lease.invalidating = true; try { return work(); } finally { lease.invalidating = false; } },
   start: <T,>(query: Query, work: () => T): T => {
    const authority = this.captures(lease).find(item => item.query === query);
    if (!authority || !this.leases.has(lease)) return work();
    if (lease.sealed || lease.starting.has(query)) { end(); return work(); }
    lease.starting.add(query);
    try { return work(); } finally { authority.promise = query.promise; lease.starting.delete(query); if (!this.valid(lease)) end(); }
   },
   seal: () => { lease.sealed = true; lease.invalidations.clear(); if (!this.valid(lease)) end(); }, end,
  };
 }
}
const stores = new WeakMap<QueryClient, PresentationStore>();
export function workspaceReadPresentationFor(client: QueryClient) { let store = stores.get(client); if (!store) { store = new PresentationStore(client); stores.set(client, store); } return store; }
export function revokeWorkspaceReadPresentation(client: QueryClient, actorId: string, workspaceId: string): void { workspaceReadPresentationFor(client).revoke(actorId, workspaceId); }
/** Read decorations only. Never use this lease for enabling an editor, command or query authority. */
export function useWorkspaceReadPresentation(actorId: string, workspaceId: string, projectId: string): boolean {
 const client = useQueryClient(), store = workspaceReadPresentationFor(client);
 const snapshot = useCallback(() => store.allows(actorId, workspaceId, projectId), [store, actorId, workspaceId, projectId]);
 return useSyncExternalStore(store.subscribe, snapshot, () => false);
}
