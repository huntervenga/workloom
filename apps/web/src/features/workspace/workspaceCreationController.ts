import { workspaceHref, type WorkspaceAddress } from './workspaceRouting';
import type { QueryClient } from '@tanstack/react-query';
import type { MeDto, WorkspaceDto } from '@workloom/contracts';
import { isUncertainOutcome } from '../../lib/api';
import { createIdempotencyKey } from '../../lib/idempotency';
import { protectedCommandsFor, type ProtectedCommandEntry } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { queryKeys } from '../../lib/queryKeys';
import {
  prepareWorkspaceCreation,
  sendWorkspaceCreation,
  WORKSPACE_NAME_MAX,
  WORKSPACE_TIMEZONE_MAX,
  type WorkspaceCreationCommand,
} from './workspaceCreationApi';

export interface WorkspaceDraft {
  name: string;
  timezone: string;
}

export interface DraftProblems {
  name: 'empty' | 'tooLong' | null;
  timezone: 'invalid' | null;
}

/**
 * `editing`: nothing is in flight and the draft is editable. `pending`: `sent` is being sent.
 * `uncertain`: `sent` got no confirmed answer and may have been applied; only an explicit retry
 * resends it, unchanged.
 */
export type CreationPhase = 'editing' | 'pending' | 'uncertain';

export interface WorkspaceCreationState {
  open: boolean;
  draft: WorkspaceDraft;
  phase: CreationPhase;
  sent: WorkspaceCreationCommand | null;
  /** A confirmed rejection (draft stays editable) or the failure that left `sent` uncertain. */
  error: Error | null;
  /** Field problems, shown once the user has tried to submit. */
  problems: DraftProblems | null;
  /**
   * The workspace this owner just created, until the app is inside it. While the navigation to its
   * projects waits on another owner's guard, the home page sends the same target, not its default.
   */
  created: string | null;
}

/**
 * The server answered, but by then this tab's identity was no longer the confirmed actor that sent
 * it (for example an expired session behind the sign-in gate). Nothing was published; the same
 * command is kept for an explicit retry.
 */
export class CreationIdentityChangedError extends Error {
  constructor() {
    super('The workspace answer arrived after the session changed.');
    this.name = 'CreationIdentityChangedError';
  }
}

/** Where a newly created workspace opens: its empty projects page. */
export function createdWorkspacePath(workspaceId: string | WorkspaceAddress): string {
  return workspaceHref(workspaceId, '/projects');
}

export function isKnownTimezone(timezone: string): boolean {
  if (timezone === '' || timezone.length > WORKSPACE_TIMEZONE_MAX) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The browser's own zone when it is a valid IANA name the contract accepts, else UTC. */
export function browserTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone === 'string' && isKnownTimezone(zone)) return zone;
  } catch {
    // fall through
  }
  return 'UTC';
}

/** Friendly checks only; the shared schema and then the server remain the authority. */
export function draftProblems(draft: WorkspaceDraft): DraftProblems | null {
  const name = draft.name.trim();
  const problems: DraftProblems = {
    name: name === '' ? 'empty' : name.length > WORKSPACE_NAME_MAX ? 'tooLong' : null,
    timezone: isKnownTimezone(draft.timezone.trim()) ? null : 'invalid',
  };
  return problems.name || problems.timezone ? problems : null;
}

/**
 * Only a confirmed shared session of this same real actor may send or publish anything. A covered
 * frame (the identity read failed or the session expired) keeps its state but cannot write.
 */
export function isCurrentCreator(client: QueryClient, actorId: string): boolean {
  const state = client.getQueryState<MeDto>(queryKeys.me);
  const me = state?.data;
  return (
    state?.status === 'success' &&
    me !== undefined &&
    me.authMode === 'shared' &&
    me.actor.kind === 'real' &&
    me.actor.id.toLowerCase() === actorId.toLowerCase()
  );
}

/**
 * Owns the new-workspace draft and its single create command for one actor. It lives in a provider
 * above the shell frame, so closing the dialog or the mobile menu that opened it forgets nothing.
 * A new actor gets a new controller; a detached one never writes a cache or navigates.
 */
export class WorkspaceCreationController {
  private state: WorkspaceCreationState;
  private readonly listeners = new Set<() => void>();
  private commandEntry: ProtectedCommandEntry | null = null;
  private draftEntry: ProtectedCommandEntry | null = null;
  private navigate: ((path: string) => void) | null = null;

  constructor(
    private readonly client: QueryClient,
    readonly actorId: string,
    private readonly defaultTimezone: string = browserTimezone(),
  ) {
    this.state = { open: false, draft: this.emptyDraft(), phase: 'editing', sent: null, error: null, problems: null, created: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WorkspaceCreationState => this.state;

  /** Registers this owner's protection; the returned detach stops every later write. */
  attach(navigate: (path: string) => void): () => void {
    const commands = protectedCommandsFor(this.client).register();
    const drafts = protectedDraftsFor(this.client).register();
    this.commandEntry = commands;
    this.draftEntry = drafts;
    this.navigate = navigate;
    this.protect();
    return () => {
      commands.dispose();
      drafts.dispose();
      if (this.commandEntry === commands) {
        this.commandEntry = null;
        this.draftEntry = null;
        this.navigate = null;
      }
    };
  }

  get dirty(): boolean {
    return isDirtyDraft(this.state.draft, this.defaultTimezone);
  }

  show(): void {
    if (!this.state.open) this.update({ open: true });
  }

  /** Close, Cancel and Escape only hide: the draft and any sent command stay. */
  hide(): void {
    if (this.state.open) this.update({ open: false });
  }

  edit(patch: Partial<WorkspaceDraft>): void {
    if (this.state.phase !== 'editing') return;
    const draft = { ...this.state.draft, ...patch };
    this.update({ draft, error: null, problems: this.state.problems ? draftProblems(draft) : null });
  }

  /** Resets only this owner's unsent draft; a sent command is never discarded here. */
  discard(): void {
    if (this.state.phase !== 'editing') return;
    this.update({ open: false, draft: this.emptyDraft(), error: null, problems: null });
  }

  /** Returns the field to focus when the draft has a problem. */
  submit(): keyof DraftProblems | null {
    // Synchronous: a second click while pending or uncertain sends nothing.
    if (this.state.phase !== 'editing') return null;
    const problems = draftProblems(this.state.draft);
    if (problems) {
      this.update({ problems });
      return problems.name ? 'name' : 'timezone';
    }
    if (!this.canWrite()) {
      this.update({ error: new CreationIdentityChangedError() });
      return null;
    }
    let command: WorkspaceCreationCommand;
    try {
      command = prepareWorkspaceCreation(
        { name: this.state.draft.name, timezone: this.state.draft.timezone.trim() },
        this.actorId,
        createIdempotencyKey(),
      );
    } catch (error) {
      this.update({ error: error instanceof Error ? error : new Error(String(error)), problems: null });
      return null;
    }
    void this.send(command);
    return null;
  }

  /** Resends the uncertain command exactly, with its key and actor; only on an explicit action. */
  retry(): void {
    const { phase, sent } = this.state;
    if (phase !== 'uncertain' || sent === null || !this.canWrite()) return;
    void this.send(sent);
  }

  private canWrite(): boolean {
    return this.commandEntry !== null && isCurrentCreator(this.client, this.actorId);
  }

  private async send(command: WorkspaceCreationCommand): Promise<void> {
    this.update({ phase: 'pending', sent: command, error: null, problems: null });
    let workspace: WorkspaceDto;
    try {
      workspace = await sendWorkspaceCreation(command);
    } catch (error) {
      if (this.commandEntry === null) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      if (isUncertainOutcome(failure)) {
        this.update({ phase: 'uncertain', error: failure });
      } else {
        // Confirmed rejection: the trimmed sent values become the editable draft again.
        this.update({ phase: 'editing', sent: null, error: failure, draft: { ...command.input } });
      }
      return;
    }
    if (!this.canWrite()) {
      this.holdForRetry();
      return;
    }
    // Older list reads were started before this workspace existed; they must not overwrite it.
    await this.client.cancelQueries({ queryKey: queryKeys.workspaces(this.actorId), exact: true });
    if (!this.canWrite()) {
      this.holdForRetry();
      return;
    }
    const navigate = this.navigate;
    // Own protection is released synchronously, so the guard does not stop this navigation;
    // other owners' drafts and unconfirmed commands still ask first. `created` is set before the
    // list changes, so the home page never sees the new workspace without its projects target.
    this.update({ open: false, draft: this.emptyDraft(), phase: 'editing', sent: null, error: null, problems: null, created: workspace.id });
    this.publish(workspace);
    navigate?.(createdWorkspacePath(workspace));
  }

  /** The app has opened the created workspace; later visits to home use its normal target again. */
  forgetCreated(workspaceId: string): void {
    const { created } = this.state;
    if (created !== null && created.toLowerCase() === workspaceId.toLowerCase()) this.update({ created: null });
  }

  private holdForRetry(): void {
    if (this.commandEntry === null) return;
    this.update({ phase: 'uncertain', error: new CreationIdentityChangedError() });
  }

  private publish(workspace: WorkspaceDto): void {
    const { client, actorId } = this;
    client.setQueryData<WorkspaceDto>(queryKeys.workspace(actorId, workspace.id), workspace);
    client.setQueryData<WorkspaceDto[]>(queryKeys.workspaces(actorId), (list) =>
      list === undefined || list.some((known) => known.id.toLowerCase() === workspace.id.toLowerCase()) ? list : [...list, workspace],
    );
    void client.invalidateQueries({ queryKey: queryKeys.workspaces(actorId), exact: true });
  }

  private emptyDraft(): WorkspaceDraft {
    return { name: '', timezone: this.defaultTimezone };
  }

  private update(patch: Partial<WorkspaceCreationState>): void {
    this.state = { ...this.state, ...patch };
    this.protect();
    for (const listener of this.listeners) listener();
  }

  private protect(): void {
    const { phase, draft } = this.state;
    this.commandEntry?.set(phase !== 'editing');
    this.draftEntry?.set(phase === 'editing' && isDirtyDraft(draft, this.defaultTimezone));
  }
}

function isDirtyDraft(draft: WorkspaceDraft, defaultTimezone: string): boolean {
  return draft.name.trim() !== '' || draft.timezone.trim() !== defaultTimezone;
}
