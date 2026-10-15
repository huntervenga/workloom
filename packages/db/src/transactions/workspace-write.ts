import { eq, sql } from 'drizzle-orm';
import {
  authorizeWorkspace,
  isDomainError,
  notFoundError,
  temporarilyUnavailableError,
  type Capability,
  type ChangeEventInput,
  type CommandContext,
  type RecordedChange,
  type WorkspaceWriteRunner,
  type WorkspaceWriteScope,
} from '@workloom/domain';

import { isDatabase, type Database, type WorkloomExecutor, type WorkloomTransaction } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { auditEvents, outboxEvents, workspaces } from '../schema.js';

export interface DbWorkspaceWriteScope extends WorkspaceWriteScope {
  /** The open transaction. Every mutation of the command must use it. */
  readonly tx: WorkloomTransaction;
}

export interface WorkspaceWriteOptions {
  /** Maximum wait for the workspace barrier. Default 5 s. */
  readonly lockTimeoutMs?: number;
  /** Maximum duration of any statement in the transaction. Default 15 s. */
  readonly statementTimeoutMs?: number;
}

const LABEL_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertChangeEvent(event: ChangeEventInput): void {
  if (!LABEL_PATTERN.test(event.entityType) || !LABEL_PATTERN.test(event.action)) {
    throw new TypeError('Change events need lower-case entityType and action labels of at most 64 characters.');
  }
  if (!UUID_PATTERN.test(event.entityId)) {
    throw new TypeError('Change events need a UUID entityId.');
  }
  if (event.outbox !== undefined && (event.outbox.type.length === 0 || event.outbox.type.length > 128)) {
    throw new TypeError('Outbox event type must be 1–128 characters.');
  }
}

/**
 * Runs `work` inside one READ COMMITTED transaction that:
 *  1. bounds lock and statement time;
 *  2. locks the workspace row (SELECT … FOR UPDATE) — the barrier;
 *  3. re-reads the membership under the lock and authorizes `capability`
 *     (absent/revoked → NOT_FOUND, missing capability → CAPABILITY_REQUIRED);
 *  4. reads clock_timestamp() after the wait;
 *  5. lets `work` mutate through `scope.tx` and record audit/outbox events.
 * Any error rolls everything back, including change_seq, audit and outbox rows.
 * Lock/statement timeouts and connection failures surface as TEMPORARILY_UNAVAILABLE.
 */
export async function runWorkspaceWrite<T>(
  source: Database | WorkloomExecutor,
  context: CommandContext,
  capability: Capability,
  work: (scope: DbWorkspaceWriteScope) => Promise<T>,
  options: WorkspaceWriteOptions = {},
): Promise<T> {
  const db: WorkloomExecutor = isDatabase(source) ? source.db : source;
  const lockTimeoutMs = Math.max(1, Math.trunc(options.lockTimeoutMs ?? 5_000));
  const statementTimeoutMs = Math.max(1, Math.trunc(options.statementTimeoutMs ?? 15_000));

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
               set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)
      `);

      const repository = createAccessRepository(tx);
      // Unlocked pre-check: non-members never take the barrier of a foreign workspace.
      await authorizeWorkspace(repository, context, capability);
      const locked = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, context.workspaceId))
        .for('update');
      if (locked.length === 0) {
        throw notFoundError();
      }
      // Authoritative check under the barrier: a concurrent revocation committed
      // before we acquired the lock is visible here (READ COMMITTED).
      const access = await authorizeWorkspace(repository, context, capability);

      const [clock] = await tx.execute<{ epoch_ms: number }>(
        sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as epoch_ms`,
      );
      const barrierAt = new Date(Number(clock?.epoch_ms));

      let changeSeq: bigint | undefined;
      let eventOrdinal = 0;
      let open = true;
      let queue: Promise<unknown> = Promise.resolve();

      async function advanceChangeSeq(): Promise<bigint> {
        const [row] = await tx
          .update(workspaces)
          .set({ changeSeq: sql`${workspaces.changeSeq} + 1` })
          .where(eq(workspaces.id, context.workspaceId))
          .returning({ changeSeq: workspaces.changeSeq });
        if (row === undefined) {
          throw new Error('Workspace barrier row disappeared inside the transaction.');
        }
        return row.changeSeq;
      }

      async function record(event: ChangeEventInput): Promise<RecordedChange> {
        if (!open) {
          throw new Error('recordChange called after the workspace transaction finished.');
        }
        assertChangeEvent(event);
        const seq = changeSeq ?? (await advanceChangeSeq());
        changeSeq = seq;
        eventOrdinal += 1;
        const recorded: RecordedChange = { changeSeq: seq, eventOrdinal };

        await tx.insert(auditEvents).values({
          workspaceId: context.workspaceId,
          changeSeq: seq,
          eventOrdinal: recorded.eventOrdinal,
          actorUserId: context.actor.userId,
          actorMembershipId: access.membership.id,
          source: context.source,
          requestId: context.requestId,
          entityType: event.entityType,
          entityId: event.entityId,
          entityRevision: event.entityRevision ?? null,
          action: event.action,
          diff: event.diff === undefined ? null : { ...event.diff },
          reason: event.reason ?? null,
          recordedAt: barrierAt,
        });

        if (event.outbox !== undefined) {
          await tx.insert(outboxEvents).values({
            workspaceId: context.workspaceId,
            changeSeq: seq,
            eventOrdinal: recorded.eventOrdinal,
            type: event.outbox.type,
            schemaVersion: event.outbox.schemaVersion ?? 1,
            aggregateType: event.entityType,
            aggregateId: event.entityId,
            aggregateRevision: event.entityRevision ?? null,
            payload: { ...event.outbox.payload },
            occurredAt: barrierAt,
          });
        }
        return recorded;
      }

      const scope: DbWorkspaceWriteScope = {
        tx,
        context,
        access,
        barrierAt,
        recordChange(event) {
          // Serialize calls so concurrent invocations cannot race on change_seq.
          const next = queue.then(() => record(event));
          queue = next.catch(() => undefined);
          return next;
        },
      };

      try {
        return await work(scope);
      } finally {
        open = false;
      }
    });
  } catch (error) {
    if (!isDomainError(error) && isDatabaseUnavailableError(error)) {
      throw temporarilyUnavailableError(error);
    }
    throw error;
  }
}

/** Port adapter for domain code that expects a WorkspaceWriteRunner. */
export function createWorkspaceWriteRunner(
  source: Database | WorkloomExecutor,
  options: WorkspaceWriteOptions = {},
): WorkspaceWriteRunner<DbWorkspaceWriteScope> {
  return {
    run(context, capability, work) {
      return runWorkspaceWrite(source, context, capability, work, options);
    },
  };
}
