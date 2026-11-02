import { AsyncLocalStorage } from 'node:async_hooks';

/** One committed workspace write transaction and the change sequence it advanced the workspace to. */
export interface CommittedWorkspaceChange {
  readonly workspaceId: string;
  readonly changeSeq: string;
}

const observers = new AsyncLocalStorage<(change: CommittedWorkspaceChange) => void>();

/**
 * Runs `work` so that every top-level workspace write transaction it commits is reported to `observer`, after the
 * commit. The HTTP layer uses it to tell a client which change sequences its own request produced.
 */
export function observeWorkspaceCommits<T>(observer: (change: CommittedWorkspaceChange) => void, work: () => T): T {
  return observers.run(observer, work);
}

export function reportCommittedWorkspaceChange(change: CommittedWorkspaceChange): void {
  observers.getStore()?.(change);
}
