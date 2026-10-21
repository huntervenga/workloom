import type { QueryClient } from '@tanstack/react-query';
import { updateWorkspaceSlugInputSchema, workspaceResponseSchema, type WorkspaceDto } from '@workloom/contracts';
import { apiRequest, ApiError, isUncertainOutcome, prepareMutation, type MutationRequest } from '../../lib/api';
import { createIdempotencyKey } from '../../lib/idempotency';
import { protectedCommandsFor, type ProtectedCommandEntry } from '../../lib/protectedCommands';
import { queryKeys } from '../../lib/queryKeys';
import { workspaceHeadDenial } from '../../lib/workspaceHeadDenial';
import { ACTOR_HEADER } from './workspaceCreationApi';
import { isCurrentCreator } from './workspaceCreationController';
import { workspacePath } from './queries';

type SlugResponse = { data: WorkspaceDto };
interface Command { request: MutationRequest<SlugResponse>; key: string }
export interface WorkspaceSlugState { phase: 'editing' | 'pending' | 'uncertain'; error: unknown; saved: WorkspaceDto | null }

/** Owns one immutable request until a confirmed answer; no background retries or new keys. */
export class WorkspaceSlugController {
  private state: WorkspaceSlugState = { phase: 'editing', error: null, saved: null };
  private command: Command | null = null;
  private entry: ProtectedCommandEntry | null = null;
  private listeners = new Set<() => void>();
  constructor(private client: QueryClient, private actorId: string, private workspaceId: string) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate() { this.entry = protectedCommandsFor(this.client).register(); }
  dispose() { this.entry?.dispose(); this.entry = null; }
  private current() {
    const root = this.client.getQueryState<WorkspaceDto>(queryKeys.workspace(this.actorId, this.workspaceId));
    return this.entry !== null && isCurrentCreator(this.client, this.actorId) && root?.status === 'success' && root.data?.role === 'owner' && workspaceHeadDenial(this.client, this.actorId, this.workspaceId) === null;
  }
  private publish(next: WorkspaceSlugState) { this.state = next; for (const listener of this.listeners) listener(); }
  async save(slug: string, expectedSlugRevision: number) {
    if (this.state.phase !== 'editing' || !this.current()) return;
    try {
      const request = prepareMutation({ method: 'PATCH', path: `${workspacePath(this.workspaceId)}/slug`, input: { slug, expectedSlugRevision }, inputSchema: updateWorkspaceSlugInputSchema, responseSchema: workspaceResponseSchema });
      this.command = { request, key: createIdempotencyKey() };
      await this.send(this.command);
    } catch (error) { this.publish({ phase: 'editing', error, saved: null }); }
  }
  async retry() { if (this.state.phase === 'uncertain' && this.command && this.current()) await this.send(this.command); }
  private async send(command: Command) {
    this.entry?.set(true);
    this.publish({ phase: 'pending', error: null, saved: null });
    try {
      const response = await apiRequest(command.request.path, { method: command.request.method, body: command.request.body, headers: { 'Idempotency-Key': command.key, [ACTOR_HEADER]: this.actorId } });
      const parsed = workspaceResponseSchema.safeParse(response.payload);
      if (!parsed.success || parsed.data.data.id !== this.workspaceId || parsed.data.data.slugRevision === undefined) throw new ApiError({ kind: 'invalid_response', status: response.status });
      if (!this.current()) {
        // An expired/changed identity cannot publish a late answer. Keep the exact command.
        this.publish({ phase: 'uncertain', error: new ApiError({ kind: 'network', status: null }), saved: null });
        return;
      }
      const answer = parsed.data.data;
      const known = this.client.getQueryData<WorkspaceDto>(queryKeys.workspace(this.actorId, this.workspaceId));
      const workspace = known && (known.slugRevision ?? 0) > (answer.slugRevision ?? 0) ? known : answer;
      this.client.setQueryData(queryKeys.workspace(this.actorId, this.workspaceId), workspace);
      this.client.setQueryData<WorkspaceDto[]>(queryKeys.workspaces(this.actorId), old => old?.map(item => item.id === workspace.id ? workspace : item));
      this.command = null;
      this.entry?.set(false);
      this.publish({ phase: 'editing', error: null, saved: workspace });
    } catch (error) {
      if (!this.entry) return;
      const uncertain = isUncertainOutcome(error);
      if (!uncertain) { this.command = null; this.entry.set(false); }
      this.publish({ phase: uncertain ? 'uncertain' : 'editing', error, saved: null });
      if (!uncertain && error instanceof ApiError && error.kind === 'conflict') {
        // Refresh revision for an explicit resubmission; never silently overwrite another owner.
        void this.client.invalidateQueries({ queryKey: queryKeys.workspace(this.actorId, this.workspaceId) });
        void this.client.invalidateQueries({ queryKey: queryKeys.workspaces(this.actorId) });
      }
    }
  }
}
