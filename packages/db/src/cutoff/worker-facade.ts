import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { cutoffJobSchema, type CutoffBlockedCode, type CutoffJob } from '@workloom/contracts';
import { blockedCutoffOutcome, createCutoffWorkerFacade as createDomainWorker, cutoffAuthority, requireCutoffPeriod, requestCutoffForPeriod, isDomainError, temporarilyUnavailableError, notFoundError, type CutoffJobUnitOfWork, type CutoffWorkerFacade, type CutoffDiscoveryTarget, type CutoffGrantRecord, type UserRecord } from '@workloom/domain';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createWorkspaceWriteRunner, type WorkspaceWriteOptions } from '../transactions/workspace-write.js';
import { createCutoffRepository } from './repository.js';
class CutoffBlocked extends Error {
  constructor(readonly code: CutoffBlockedCode, readonly at: string) { super('Current cutoff delegation is unavailable.'); }
}
interface Resolved { grant: CutoffGrantRecord; user: UserRecord; at: string }
async function resolve(source: WorkloomExecutor, workspaceId: string, periodId: string, job?: CutoffJob, options: WorkspaceWriteOptions = {}): Promise<Resolved> {
  try { return await source.transaction(async tx => {
    await tx.execute(sql`select set_config('lock_timeout',${`${Math.max(1, Math.trunc(options.lockTimeoutMs ?? 5_000))}ms`},true), set_config('statement_timeout',${`${Math.max(1, Math.trunc(options.statementTimeoutMs ?? 15_000))}ms`},true)`);
    const repo = createCutoffRepository(tx, true), period = await requireCutoffPeriod(repo, workspaceId, periodId);
    const [clock] = await tx.execute<{ at: string }>(sql`select clock_timestamp()::text as at`);
    if (!clock) throw new Error('Database clock unavailable.');
    const at = new Date(clock.at).toISOString(), grant = await repo.currentGrant(workspaceId, periodId);
    if (job && period.projectId !== job.projectId) throw notFoundError();
    if (!grant) throw new CutoffBlocked('automation_not_configured', at);
    if (job && (grant.id !== job.grantId || grant.revision !== job.grantRevision)) throw new CutoffBlocked('cutoff_grant_stale', at);
    const blocked = await cutoffAuthority(repo, grant); if (blocked) throw new CutoffBlocked(blocked, at);
    const user = await repo.access.findUser(grant.authorizerUserId); if (!user) throw new CutoffBlocked('cutoff_authorizer_inactive', at);
    return { grant, user, at };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' }); } catch (error) { throw !isDomainError(error) && isDatabaseUnavailableError(error) ? temporarilyUnavailableError(error) : error; }
}
export function createCutoffWorkerFacade(source: Database | WorkloomExecutor, options: WorkspaceWriteOptions = {}): CutoffWorkerFacade {
  const db = isDatabase(source) ? source.db : source, runner = createWorkspaceWriteRunner(source, options), runtime = createRecurrenceRuntime();
  const writer: CutoffJobUnitOfWork = {
    async run(rawJob, work) {
      const job = cutoffJobSchema.parse(rawJob), resolved = await resolve(db, job.workspaceId, job.periodId, job, options);
      let entered = false;
      try {
        return await runner.run({ workspaceId: job.workspaceId, actor: { userId: resolved.user.id, displayName: resolved.user.displayName, kind: resolved.user.kind }, source: 'job', requestId: `cutoff:${job.requestId}` }, 'plan.freeze_project', scope => {
          entered = true;
          const attributed = { ...scope, recordChange: (event: Parameters<typeof scope.recordChange>[0]) => scope.recordChange({ ...event, diff: { ...event.diff, cutoffJob: { requestId: job.requestId, grantId: job.grantId, grantRevision: job.grantRevision } } }) };
          return work(composeRecurrenceCensusScope(attributed, runtime));
        });
      } catch (error) {
        if (!entered && isDomainError(error) && (error.code === 'NOT_FOUND' || error.code === 'CAPABILITY_REQUIRED')) throw new CutoffBlocked(error.code === 'NOT_FOUND' ? 'cutoff_authorizer_inactive' : 'cutoff_authorizer_capability_revoked', resolved.at);
        throw error;
      }
    },
  };
  const facade = createDomainWorker(writer, runtime.tools);
  return { async freezeDuePeriod(job) { try { return await facade.freezeDuePeriod(job); } catch (error) { if (error instanceof CutoffBlocked) return blockedCutoffOutcome(job, error.at, error.code); throw error; } } };
}
/** Discovery requests work under the stored current authorizer; it never freezes or runs a user guard. */
export function createCutoffDueRequester(source: Database | WorkloomExecutor, options: WorkspaceWriteOptions = {}) {
  const db = isDatabase(source) ? source.db : source, runner = createWorkspaceWriteRunner(source, options), runtime = createRecurrenceRuntime();
  return async (target: CutoffDiscoveryTarget): Promise<'requested' | 'unchanged' | 'blocked'> => {
    try {
      const resolved = await resolve(db, target.workspaceId, target.periodId, undefined, options);
      return await runner.run({ workspaceId: target.workspaceId, actor: { userId: resolved.user.id, displayName: resolved.user.displayName, kind: resolved.user.kind }, source: 'job', requestId: `cutoff-discovery:${randomUUID()}` }, 'plan.freeze_project', async rawScope => {
        const scope = composeRecurrenceCensusScope(rawScope, runtime), period = await requireCutoffPeriod(scope.cutoff, target.workspaceId, target.periodId), grant = await scope.cutoff.currentGrant(target.workspaceId, target.periodId);
        if (!grant || grant.id !== resolved.grant.id || grant.revision !== resolved.grant.revision || await cutoffAuthority(scope.cutoff, grant) !== null || grant.authorizerUserId !== scope.context.actor.userId || grant.authorizerMembershipId !== scope.access.membership.id) return 'blocked';
        if (period.state !== 'planning' || Date.parse(period.cutoffAt) > scope.barrierAt.getTime()) return 'unchanged';
        const before = await scope.cutoff.liveRequest(target.workspaceId, target.periodId), requestId = await requestCutoffForPeriod(scope, period, 'discovery', runtime.tools);
        return requestId && requestId !== before?.job.requestId ? 'requested' : 'unchanged';
      });
    } catch (error) {
      if (error instanceof CutoffBlocked || (isDomainError(error) && (error.code === 'NOT_FOUND' || error.code === 'CAPABILITY_REQUIRED'))) return 'blocked';
      throw error;
    }
  };
}
