import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import type { WorkspaceAccessRecord } from '../access/ports.js';

/**
 * Write protocol of docs/03-domain-and-data.md §2: every workspace mutation
 * takes the workspace row barrier (SELECT … FOR UPDATE), re-checks the active
 * membership and capability under that lock, reads the server clock after the
 * wait, and commits state + audit + outbox atomically. Any thrown error rolls
 * the whole unit back.
 */
export interface OutboxEventInput {
  /** Event type, for example `task.completed`. */
  readonly type: string;
  readonly schemaVersion?: number;
  /** Minimal payload; never include private content or secrets. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ChangeEventInput {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly entityRevision?: number;
  /** Safe diff for the audit trail; never include credentials. */
  readonly diff?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  /** When present, an outbox event is committed together with the audit event. */
  readonly outbox?: OutboxEventInput;
}

export interface RecordedChange {
  /** Commit-ordered workspace sequence; identical for all events of one transaction. */
  readonly changeSeq: bigint;
  /** 1-based ordinal of the event inside the transaction. */
  readonly eventOrdinal: number;
}

export interface WorkspaceWriteScope {
  readonly context: CommandContext;
  /** Membership and workspace as re-read under the barrier. */
  readonly access: WorkspaceAccessRecord;
  /** Server clock (clock_timestamp) read after the barrier was acquired. */
  readonly barrierAt: Date;
  /**
   * Records an audit event (and optional outbox event). The first call of a
   * transaction advances `workspaces.change_seq` exactly once.
   */
  recordChange(event: ChangeEventInput): Promise<RecordedChange>;
}

export interface WorkspaceWriteRunner<Scope extends WorkspaceWriteScope = WorkspaceWriteScope> {
  run<T>(context: CommandContext, capability: Capability, work: (scope: Scope) => Promise<T>): Promise<T>;
}
