import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  createWorkspaceCreateService,
  isDomainError,
  temporarilyUnavailableError,
  type WorkspaceCreateApplication,
  type WorkspaceCreateScope,
} from '@workloom/domain';

import type { Database, WorkloomTransaction } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { auditEvents, memberships, users, workspaceCreationReceipts, workspaces } from '../schema.js';

const LOCK_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 15_000;

function createScope(tx: WorkloomTransaction): WorkspaceCreateScope {
  const access = createAccessRepository(tx);
  return {
    async findActor(userId) {
      // FOR SHARE keeps the persisted principal stable until commit.
      const [row] = await tx.select({ id: users.id, displayName: users.displayName, kind: users.kind })
        .from(users).where(eq(users.id, userId)).for('share');
      return row ?? null;
    },

    async findReceipt(actorUserId, idempotencyKey) {
      const [row] = await tx.select({ workspaceId: workspaceCreationReceipts.workspaceId, payloadHash: workspaceCreationReceipts.payloadHash })
        .from(workspaceCreationReceipts)
        .where(and(eq(workspaceCreationReceipts.actorUserId, actorUserId), eq(workspaceCreationReceipts.idempotencyKey, idempotencyKey)));
      return row ?? null;
    },

    async lockWorkspaceAccess(workspaceId, userId) {
      const locked = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('update');
      if (locked.length === 0) return null;
      // Read under the barrier: a revocation or demotion committed before the lock is visible.
      return access.findWorkspaceAccess(workspaceId, userId);
    },

    async insertWorkspace(plan) {
      const { context } = plan;
      const [clock] = await tx.execute<{ epoch_ms: number }>(
        sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as epoch_ms`,
      );
      const now = new Date(Number(clock?.epoch_ms));
      if (!Number.isFinite(now.getTime())) throw new Error('Database clock is unavailable.');

      await tx.insert(workspaces).values({
        id: plan.workspaceId, name: plan.name, timezone: plan.timezone,
        weekStart: 1, changeSeq: 0n, permissionEpoch: 0n, createdAt: now, updatedAt: now,
      });
      await tx.insert(memberships).values({
        id: plan.membershipId, workspaceId: plan.workspaceId, userId: context.actor.userId,
        role: 'owner', state: 'active', revision: 1, createdAt: now, updatedAt: now,
      });
      const [head] = await tx.update(workspaces).set({ changeSeq: sql`${workspaces.changeSeq} + 1` })
        .where(eq(workspaces.id, plan.workspaceId)).returning({ changeSeq: workspaces.changeSeq });
      if (head?.changeSeq !== 1n) throw new Error('New workspace change head must start at 1.');
      await tx.insert(auditEvents).values({
        workspaceId: plan.workspaceId,
        changeSeq: head.changeSeq,
        eventOrdinal: 1,
        actorUserId: context.actor.userId,
        credentialId: null,
        actorMembershipId: plan.membershipId,
        source: context.source,
        requestId: context.requestId,
        entityType: 'workspace',
        entityId: plan.workspaceId,
        entityRevision: null,
        action: 'created',
        diff: { name: plan.name, timezone: plan.timezone, weekStart: 1 },
        reason: null,
        recordedAt: now,
      });
      await tx.insert(workspaceCreationReceipts).values({
        actorUserId: context.actor.userId, idempotencyKey: plan.idempotencyKey,
        workspaceId: plan.workspaceId, payloadHash: plan.payloadHash, createdAt: now,
      });
      const created = await access.findWorkspaceAccess(plan.workspaceId, context.actor.userId);
      if (created === null) throw new Error('Created workspace membership is not readable inside its transaction.');
      return created;
    },
  };
}

/**
 * Workspace creation is its own bounded transaction, not a workspace barrier command:
 * there is no membership to authorize until it commits. Concurrent requests for the
 * same (actor, Idempotency-Key) serialize on a transaction-scoped advisory lock.
 */
export function createWorkspaceCreateApplication(source: Database): WorkspaceCreateApplication {
  return createWorkspaceCreateService({
    newId: () => randomUUID(),
    digest: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
    unitOfWork: {
      async run(actorUserId, idempotencyKey, work) {
        try {
          return await source.db.transaction(async (tx) => {
            await tx.execute(sql`
              select set_config('lock_timeout', ${`${LOCK_TIMEOUT_MS}ms`}, true),
                     set_config('statement_timeout', ${`${STATEMENT_TIMEOUT_MS}ms`}, true)
            `);
            const lockKey = JSON.stringify(['workspace.create', actorUserId.toLowerCase(), idempotencyKey]);
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
            return work(createScope(tx));
          });
        } catch (error) {
          if (!isDomainError(error) && isDatabaseUnavailableError(error)) throw temporarilyUnavailableError(error);
          throw error;
        }
      },
    },
  });
}
