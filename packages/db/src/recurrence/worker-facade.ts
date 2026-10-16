import { randomUUID } from 'node:crypto';
import { recurrenceMaterializationJobSchema, type RecurrenceBlockedCode, type RecurrenceMaterializationJob } from '@workloom/contracts';
import {
  DomainError,
  createRecurrenceWorkerFacade as createDomainRecurrenceWorkerFacade,
  isDomainError,
  notFoundError,
  roleHasCapability,
  temporarilyUnavailableError,
  type CommandContext,
  type RecurrenceAuthorityCheck,
  type RecurrenceGenerationAuthorizationRecord,
  type RecurrenceJobUnitOfWork,
  type RecurrencePeriodBindingRecord,
  type RecurrenceWorkerFacade,
  type UserRecord,
} from '@workloom/domain';
import { sql } from 'drizzle-orm';

import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { createRecurrenceRepository } from '../repositories/recurrence-repository.js';
import { createWorkspaceWriteRunner, type WorkspaceWriteOptions } from '../transactions/workspace-write.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime, type DbRecurrenceCensusScope } from './census-scope.js';

export interface RecurrenceWorkerFacadeOptions extends WorkspaceWriteOptions {
  /** HMAC key (≥32 bytes) for the codecs of the shared recurrence tools. */
  readonly cursorSecret?: string;
}

/** The stored grant requires exactly this capability of its authorizer, revalidated under the barrier. */
const GENERATION_CAPABILITY = 'task.edit' as const;
const MAX_GRANT_RESOLUTIONS = 2;

/** Thrown by the job UOW when the stored authorizer cannot run; never reaches the domain or the queue. */
class GenerationBlocked extends Error {
  override readonly name = 'GenerationBlocked';
  constructor(
    readonly job: RecurrenceMaterializationJob,
    readonly periodId: string,
    readonly code: RecurrenceBlockedCode,
  ) {
    super(`Recurrence generation blocked: ${code}.`);
  }
}

/** The grant moved to another authorizer between resolution and the barrier: roll back and re-resolve. */
class GrantMoved extends Error {
  override readonly name = 'GrantMoved';
}

interface ResolvedGrant {
  readonly binding: RecurrencePeriodBindingRecord;
  readonly authorization: RecurrenceGenerationAuthorizationRecord;
  readonly user: UserRecord;
}

function parseJob(job: RecurrenceMaterializationJob): RecurrenceMaterializationJob {
  const parsed = recurrenceMaterializationJobSchema.safeParse(job);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', 'Malformed recurrence materialization job.', { details: { fields: ['job'] } });
  }
  return parsed.data;
}

function mapUnavailable(error: unknown): unknown {
  return !isDomainError(error) && isDatabaseUnavailableError(error) ? temporarilyUnavailableError(error) : error;
}

/**
 * Worker job facade. The job carries IDs only; the actor is never taken from the payload. The server
 * resolves the binding, series and stored generation grant, then runs ONE workspace write as the stored
 * authorizer (source `job`, server request ID) whose membership and task.edit are re-authorized by the
 * runner under the workspace barrier; the grant itself is re-read under the same barrier and handed to
 * the domain as a separate ValidatedGenerationAuthority. A revoked/inactive authorizer yields a controlled
 * `blocked` outcome with no writes (outside the runner); nobody else is impersonated. Paused, stale and
 * pending outcomes, including same-TX continuation outbox rows, belong to the domain facade. This factory
 * never touches the queue.
 */
export function createRecurrenceWorkerFacade(
  source: Database | WorkloomExecutor,
  options: RecurrenceWorkerFacadeOptions = {},
): RecurrenceWorkerFacade {
  const { cursorSecret, ...writeOptions } = options;
  const runner = createWorkspaceWriteRunner(source, writeOptions);
  const db = isDatabase(source) ? source.db : source;
  const runtime = createRecurrenceRuntime(cursorSecret === undefined ? {} : { cursorSecret });
  // Same finite bounds (and defaults) as the workspace write runner, so no job read can hang shutdown.
  const lockTimeoutMs = Math.max(1, Math.trunc(writeOptions.lockTimeoutMs ?? 5_000));
  const statementTimeoutMs = Math.max(1, Math.trunc(writeOptions.statementTimeoutMs ?? 15_000));

  /** Unlocked consistent pre-resolution; the barrier re-checks everything that matters. */
  async function resolveGrant(job: RecurrenceMaterializationJob): Promise<ResolvedGrant> {
    try {
      return await db.transaction(
        async (tx) => {
          await tx.execute(sql`
            select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
                   set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)
          `);
          const repo = createRecurrenceRepository(tx, { readOnly: true });
          const binding = await repo.findBinding(job.workspaceId, job.bindingId);
          if (binding === null || binding.seriesId !== job.seriesId) throw notFoundError();
          const series = await repo.findSeries(job.workspaceId, job.seriesId);
          if (series === null || series.projectId !== binding.projectId) throw notFoundError();
          const blocked = (code: RecurrenceBlockedCode) => new GenerationBlocked(job, binding.periodId, code);
          if (series.authorizationId === null) throw blocked('authorization_missing');
          const authorization = await repo.findAuthorization(job.workspaceId, series.authorizationId);
          if (authorization === null || authorization.seriesId !== series.id) throw blocked('authorization_missing');
          if (authorization.revision !== series.authorizationRevision) throw blocked('authorization_revision_stale');
          const access = repo.planning.tasks.access;
          const user = await access.findUser(authorization.authorizerUserId);
          const membership = user === null ? null : await access.findWorkspaceAccess(job.workspaceId, user.id);
          if (
            user === null ||
            membership === null ||
            membership.membership.state !== 'active' ||
            membership.membership.id !== authorization.authorizerMembershipId
          ) {
            throw blocked('authorizer_inactive');
          }
          if (!roleHasCapability(membership.membership.role, GENERATION_CAPABILITY)) throw blocked('authorizer_capability_revoked');
          return { binding, authorization, user };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } catch (error) {
      throw mapUnavailable(error);
    }
  }

  /** Under the barrier (READ COMMITTED after the lock): the current grant must still name this actor. */
  async function validateGrant(scope: DbRecurrenceCensusScope, job: RecurrenceMaterializationJob): Promise<RecurrenceAuthorityCheck> {
    const binding = await scope.recurrence.findBinding(job.workspaceId, job.bindingId);
    const series = await scope.recurrence.findSeries(job.workspaceId, job.seriesId);
    if (binding === null || series === null || binding.seriesId !== series.id || binding.projectId !== series.projectId) {
      return { kind: 'blocked', code: 'source_unavailable' };
    }
    if (series.authorizationId === null || series.authorizationRevision === null) return { kind: 'blocked', code: 'authorization_missing' };
    const authorization = await scope.recurrence.findAuthorization(job.workspaceId, series.authorizationId);
    if (authorization === null || authorization.seriesId !== series.id) return { kind: 'blocked', code: 'authorization_missing' };
    if (authorization.revision !== series.authorizationRevision) return { kind: 'blocked', code: 'authorization_revision_stale' };
    if (
      authorization.authorizerUserId.toLowerCase() !== scope.context.actor.userId.toLowerCase() ||
      authorization.authorizerMembershipId.toLowerCase() !== scope.access.membership.id.toLowerCase()
    ) {
      throw new GrantMoved();
    }
    return {
      kind: 'valid',
      authority: {
        __workloomGenerationAuthority: 'validated',
        seriesId: series.id,
        authorizationId: authorization.id,
        authorizationRevision: authorization.revision,
        authorizerUserId: authorization.authorizerUserId,
        authorizerMembershipId: authorization.authorizerMembershipId,
        validatedAt: scope.barrierAt,
      },
    };
  }

  const writer: RecurrenceJobUnitOfWork = {
    async run(rawJob, work) {
      const job = parseJob(rawJob);
      for (let attempt = 1; attempt <= MAX_GRANT_RESOLUTIONS; attempt += 1) {
        const resolved = await resolveGrant(job);
        const ctx: CommandContext = {
          actor: { userId: resolved.user.id, displayName: resolved.user.displayName, kind: resolved.user.kind },
          source: 'job',
          requestId: `job:${randomUUID()}`,
          workspaceId: job.workspaceId,
        };
        let entered = false;
        try {
          return await runner.run(ctx, GENERATION_CAPABILITY, async (scope) => {
            entered = true;
            const composed = composeRecurrenceCensusScope(scope, runtime);
            const authorization = await validateGrant(composed, job);
            const jobScope = { ...composed, authorization };
            return work(jobScope);
          });
        } catch (error) {
          if (error instanceof GrantMoved) continue;
          // Authorizer lost membership/capability between resolution and the barrier: nothing was written.
          if (!entered && isDomainError(error) && error.code === 'NOT_FOUND') {
            throw new GenerationBlocked(job, resolved.binding.periodId, 'authorizer_inactive');
          }
          if (!entered && isDomainError(error) && error.code === 'CAPABILITY_REQUIRED') {
            throw new GenerationBlocked(job, resolved.binding.periodId, 'authorizer_capability_revoked');
          }
          throw error;
        }
      }
      const { binding } = await resolveGrant(job);
      throw new GenerationBlocked(job, binding.periodId, 'authorization_revision_stale');
    },
  };

  const facade = createDomainRecurrenceWorkerFacade({ writer, tools: runtime.tools, composer: runtime.composer });
  return {
    async materializeBinding(job) {
      try {
        return await facade.materializeBinding(job);
      } catch (error) {
        if (error instanceof GenerationBlocked) {
          return {
            status: 'blocked',
            bindingId: error.job.bindingId,
            periodId: error.periodId,
            createdCount: 0,
            remainingCount: 0,
            blockedCode: error.code,
          };
        }
        throw error;
      }
    },
  };
}
