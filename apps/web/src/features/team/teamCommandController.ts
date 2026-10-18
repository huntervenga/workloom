import type { QueryClient } from '@tanstack/react-query';
import { ApiError, isUncertainOutcome } from '../../lib/api';
import { protectedCommandsFor, type ProtectedCommandEntry } from '../../lib/protectedCommands';
import { queryKeys } from '../../lib/queryKeys';
import { workspaceHeadDenial } from '../../lib/workspaceHeadDenial';
import { isCurrentCreator } from '../workspace/workspaceCreationController';
import { sendTeamCommand, teamQueryKey, type TeamCommand, type TeamCommandKind } from './teamApi';

/**
 * `idle`: nothing is in flight. `pending`: `sent` is being sent. `uncertain`: `sent` got no
 * confirmed answer and may have been applied; only an explicit retry resends it, unchanged.
 */
export type TeamCommandPhase = 'idle' | 'pending' | 'uncertain';

/** What the UI may show about the held command; the command itself (and any secret) stays private. */
export interface SentTeamCommand {
  readonly kind: TeamCommandKind;
  readonly workspaceId: string | null;
  readonly targetId: string | null;
}

export interface TeamCommandState {
  readonly phase: TeamCommandPhase;
  readonly sent: SentTeamCommand | null;
  /** A confirmed rejection, the failure that left `sent` uncertain, or a failed success callback. */
  readonly error: Error | null;
  /** The confirmed answer's metadata (never a secret) until consumed or the next command; else null. */
  readonly result: unknown;
}

export type TeamCommandSuccess = (result: unknown, command: TeamCommand<unknown>) => void | Promise<void>;

/**
 * The session or workspace access no longer allows this command, or changed before its confirmed
 * answer could be published. Deliberately generic: it carries nothing from the response.
 */
export class TeamCommandAccessError extends Error {
  constructor() {
    super('TEAM_ACCESS_CHANGED');
    this.name = 'TeamCommandAccessError';
  }
}

/** The owner detached or was replaced while the command was in flight; its answer is ignored. */
export class TeamCommandInterruptedError extends Error {
  constructor() {
    super('TEAM_COMMAND_INTERRUPTED');
    this.name = 'TeamCommandInterruptedError';
  }
}

/**
 * Only a confirmed owner or admin of a readable, undenied workspace, in a confirmed shared session
 * of this real actor, may read the team or send a workspace team command.
 */
export function canManageTeam(client: QueryClient, actorId: string, workspaceId: string): boolean {
  if (!isCurrentCreator(client, actorId)) return false;
  const state = client.getQueryState(queryKeys.workspace(actorId, workspaceId));
  const workspace = state?.data as { id?: unknown; role?: unknown } | undefined;
  return (
    state?.status === 'success' &&
    typeof workspace?.id === 'string' &&
    workspace.id.toLowerCase() === workspaceId.toLowerCase() &&
    (workspace.role === 'owner' || workspace.role === 'admin') &&
    workspaceHeadDenial(client, actorId, workspaceId) === null
  );
}

interface Owner {
  readonly entry: ProtectedCommandEntry;
  readonly onSuccess: TeamCommandSuccess;
}

interface Flight {
  readonly owner: Owner;
  readonly command: TeamCommand<unknown>;
}

const IDLE: TeamCommandState = Object.freeze({ phase: 'idle', sent: null, error: null, result: null });

/**
 * Sends one team command at a time for one actor. A new actor gets a new controller. Nothing runs
 * on attach, so a StrictMode attach/detach/attach replays safely; commands start only from explicit
 * user actions after a stable mount. A detached or replaced owner never receives an answer, and no
 * cache is touched for it.
 */
export class TeamCommandController {
  private state: TeamCommandState = IDLE;
  private readonly listeners = new Set<() => void>();
  private owner: Owner | null = null;
  private flight: Flight | null = null;
  /** The command `sent` describes, kept out of the snapshot so an accept secret never reaches it. */
  private command: TeamCommand<unknown> | null = null;

  constructor(
    private readonly client: QueryClient,
    readonly actorId: string,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TeamCommandState => this.state;

  /** Registers this owner's protection; the returned detach stops every later write and callback. */
  attach(onSuccess: TeamCommandSuccess): () => void {
    this.owner?.entry.dispose();
    this.interrupt();
    const owner: Owner = { entry: protectedCommandsFor(this.client).register(), onSuccess };
    this.owner = owner;
    this.protect();
    return () => {
      owner.entry.dispose();
      if (this.owner !== owner) return;
      this.owner = null;
      this.interrupt();
    };
  }

  /**
   * Claims the controller synchronously and sends `command`; a second click while pending or
   * uncertain sends nothing. Returns whether it was sent. The caller keeps its own input, so on a
   * confirmed rejection it decides what to show and what to edit.
   */
  execute(command: TeamCommand<unknown>): boolean {
    const { owner } = this;
    if (this.state.phase !== 'idle' || owner === null) return false;
    if (!this.authorized(command)) {
      this.update({ error: new TeamCommandAccessError(), result: null });
      return false;
    }
    void this.send(owner, command);
    return true;
  }

  /** Resends the uncertain command exactly, with its key and actor; only on an explicit action. */
  retry(): boolean {
    const { owner, command } = this;
    if (this.state.phase !== 'uncertain' || owner === null || command === null) return false;
    if (!this.authorized(command)) {
      this.update({ error: new TeamCommandAccessError() });
      return false;
    }
    void this.send(owner, command);
    return true;
  }

  /** Forgets the uncertain command without sending it; the team is read again since it may have applied. */
  abandon(): void {
    const { command } = this;
    if (this.state.phase !== 'uncertain' || this.owner === null) return;
    this.command = null;
    this.update({ phase: 'idle', sent: null, error: null, result: null });
    if (command !== null && this.authorized(command)) this.invalidate(command);
  }

  /** Returns the confirmed result once, so it is shown once. */
  consumeResult(): unknown {
    const { result } = this.state;
    if (result !== null) this.update({ result: null });
    return result;
  }

  dismissError(): void {
    if (this.state.phase === 'idle' && this.state.error !== null) this.update({ error: null });
  }

  private authorized(command: TeamCommand<unknown>): boolean {
    if (command.actorId.toLowerCase() !== this.actorId.toLowerCase()) return false;
    return command.workspaceId === null
      ? isCurrentCreator(this.client, this.actorId)
      : canManageTeam(this.client, this.actorId, command.workspaceId);
  }

  private async send(owner: Owner, command: TeamCommand<unknown>): Promise<void> {
    const flight: Flight = { owner, command };
    this.flight = flight;
    this.command = command;
    this.update({ phase: 'pending', sent: describe(command), error: null, result: null });
    let result: unknown;
    try {
      result = await sendTeamCommand(command);
    } catch (error) {
      if (this.flight !== flight || this.owner !== owner) return;
      this.flight = null;
      const failure = error instanceof Error ? error : new Error(String(error));
      const uncertain = unconfirmedFailure(failure);
      if (uncertain) {
        this.update({ phase: 'uncertain', error: failure });
        return;
      }
      // Confirmed rejection: nothing was applied. A stale revision reads the team again.
      this.command = null;
      this.update({ phase: 'idle', sent: null, error: failure });
      if (failure instanceof ApiError && failure.kind === 'conflict' && this.authorized(command)) this.invalidate(command);
      return;
    }
    if (this.flight !== flight || this.owner !== owner) return;
    this.flight = null;
    if (!this.authorized(command)) {
      // Applied, but this tab may no longer show it: hold the same command for an explicit retry.
      this.update({ phase: 'uncertain', error: new TeamCommandAccessError() });
      return;
    }
    // Own protection is released synchronously, before anything the callback may navigate to.
    this.command = null;
    this.update({ phase: 'idle', sent: null, error: null, result });
    this.invalidate(command);
    if (this.owner !== owner || !this.authorized(command)) return;
    // Outside the send's catch: a failing callback never turns a confirmed answer into a retry.
    try {
      await owner.onSuccess(result, command);
    } catch (error) {
      if (this.owner === owner && this.state.result === result) {
        this.update({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  }

  /** The in-flight answer will be ignored, so its outcome is unknown to whoever attaches next. */
  private interrupt(): void {
    if (this.flight === null) return;
    this.flight = null;
    this.update({ phase: 'uncertain', error: new TeamCommandInterruptedError() });
  }

  private invalidate(command: TeamCommand<unknown>): void {
    const { client, actorId } = this;
    const { workspaceId } = command;
    if (workspaceId === null) {
      // An accepted invitation adds (or keeps) a workspace in this actor's list.
      void client.invalidateQueries({ queryKey: queryKeys.workspaces(actorId), exact: true });
      return;
    }
    void client.invalidateQueries({ queryKey: teamQueryKey(actorId, workspaceId), exact: true });
    if (command.kind === 'updateMembership') {
      void client.invalidateQueries({ queryKey: queryKeys.memberships(actorId, workspaceId), exact: true });
    }
  }

  private update(patch: Partial<TeamCommandState>): void {
    this.state = Object.freeze({ ...this.state, ...patch });
    this.protect();
    for (const listener of this.listeners) listener();
  }

  private protect(): void {
    this.owner?.entry.set(this.state.phase !== 'idle');
  }
}

function describe(command: TeamCommand<unknown>): SentTeamCommand {
  return Object.freeze({ kind: command.kind, workspaceId: command.workspaceId, targetId: command.targetId });
}

function unconfirmedFailure(error: Error): boolean {
  return !(error instanceof ApiError) || isUncertainOutcome(error);
}
