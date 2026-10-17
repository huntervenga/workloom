import type { WorkspaceChangeHeadDto } from '@workloom/contracts';
import { ApiError, isAccessDenied } from '../../lib/api';
import { sameWorkspaceHead, workspaceAccessChanged } from './workspaceChangeHead';
import type { WorkspaceRefreshResult } from './workspaceLiveQueries';

export const WORKSPACE_HEAD_POLL_MS = 5_000;

interface RefreshDependencies {
  readHead: (signal: AbortSignal, previous: WorkspaceChangeHeadDto | null) => Promise<WorkspaceChangeHeadDto>;
  refresh: (signal: AbortSignal, safe: () => boolean) => Promise<WorkspaceRefreshResult>;
  protected: () => boolean;
  recheckAccess: () => void;
  rejectedHead: (error: unknown) => void;
}

/** One visible, non-overlapping GET cycle and one coalesced content catch-up per mounted scope. */
export class WorkspaceLiveRefreshController {
  observedHead: WorkspaceChangeHeadDto | null = null;
  appliedHead: WorkspaceChangeHeadDto | null = null;
  pending = false;
  private running = true;
  private visible = false;
  private authorized = false;
  private denied = false;
  private head: AbortController | null = null;
  private refresh: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wasProtected: boolean;

  constructor(private readonly dependencies: RefreshDependencies) {
    this.wasProtected = dependencies.protected();
  }

  setVisible(visible: boolean): void {
    if (!this.running || this.visible === visible) return;
    this.visible = visible;
    this.wasProtected = this.dependencies.protected();
    this.authorized = false;
    this.clearTimer();
    if (!visible) {
      this.head?.abort();
      this.refresh?.abort();
      this.head = null;
      this.refresh = null;
    } else this.poll();
  }

  /** Focus/visibility events coalesce behind the same pending head request. */
  wake = (): void => {
    if (this.canPoll()) {
      this.clearTimer();
      this.poll();
    }
  };

  interactionChanged = (): void => {
    const protectedNow = this.dependencies.protected();
    if (protectedNow === this.wasProtected) return;
    this.wasProtected = protectedNow;
    this.authorized = false;
    this.clearTimer();
    if (protectedNow) {
      this.head?.abort();
      this.refresh?.abort();
      this.head = null;
      this.refresh = null;
    } else this.poll();
  };

  stop(): void {
    this.running = false;
    this.authorized = false;
    this.clearTimer();
    this.head?.abort();
    this.refresh?.abort();
  }

  private canPoll(): boolean { return this.running && this.visible && !this.denied && !this.dependencies.protected(); }
  private safe = (): boolean => this.canPoll() && this.authorized && !this.dependencies.protected();

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private poll(): void {
    if (!this.canPoll() || this.head !== null) return;
    const request = new AbortController();
    this.head = request;
    void (async () => {
      try {
        const head = await this.dependencies.readHead(request.signal, this.observedHead);
        if (!this.canPoll() || request.signal.aborted) return;
        const previous = this.observedHead;
        if (previous !== null && (BigInt(head.changeSeq) < BigInt(previous.changeSeq) ||
          BigInt(head.permissionEpoch) < BigInt(previous.permissionEpoch))) {
          throw new ApiError({ kind: 'invalid_response', status: 200 });
        }
        this.observedHead = head;
        this.authorized = true;
        if (!sameWorkspaceHead(this.appliedHead, head)) this.pending = true;
        if (workspaceAccessChanged(previous, head)) this.dependencies.recheckAccess();
        this.catchUp();
      } catch (error) {
        if (!this.running || request.signal.aborted || this.dependencies.protected()) return;
        this.authorized = false;
        // A transient head failure preserves loaded data and pending catch-up. A later equal
        // successful head retries it; a denial requires a fresh root-authorized generation.
        if (isAccessDenied(error) || (error instanceof ApiError && error.kind === 'unauthenticated')) {
          this.denied = true;
          this.authorized = false;
          this.refresh?.abort();
        }
        this.dependencies.rejectedHead(error);
      } finally {
        if (this.head === request) {
          this.head = null;
          if (this.canPoll()) this.timer = setTimeout(() => { this.timer = null; this.poll(); }, WORKSPACE_HEAD_POLL_MS);
        }
      }
    })();
  }

  private catchUp(): void {
    if (!this.pending || !this.safe() || this.refresh !== null || this.observedHead === null) return;
    const target = this.observedHead;
    const request = new AbortController();
    this.refresh = request;
    void (async () => {
      let again = false;
      try {
        const result = await this.dependencies.refresh(request.signal, this.safe);
        if (!this.running || request.signal.aborted || this.denied) return;
        if (result.complete) {
          this.appliedHead = target;
          this.pending = result.followUp || !sameWorkspaceHead(this.observedHead, target);
          again = this.pending;
        } else {
          // A newer observation is coalesced once; failed equal-head refreshes wait for the
          // next bounded head cycle or an interaction transition, never a rejection loop.
          again = !sameWorkspaceHead(this.observedHead, target);
        }
      } catch {
        // Feature queries own their normal recovery presentation; do not announce every poll.
      } finally {
        if (this.refresh === request) this.refresh = null;
        if (again) this.catchUp();
      }
    })();
  }
}
