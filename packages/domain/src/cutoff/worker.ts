import { CUTOFF_LIMITS, cutoffJobSchema, cutoffWorkerOutcomeSchema, type CutoffBlockedCode, type CutoffJob, type CutoffWorkerOutcome } from '@workloom/contracts';
import { DomainError, notFoundError } from '../errors.js';
import { performFreeze } from '../planning/freeze.js';
import type { RecurrenceTools } from '../recurrence/ports.js';
import { canonicalJson } from '../tasks/service.js';
import type { CutoffWorkerFacade } from './application.js';
import type { CutoffJobUnitOfWork } from './ports.js';
import { cutoffAuthority, cutoffSources, requireCutoffPeriod, requestCutoffForPeriod } from './service.js';
export function cutoffOutcome(job: CutoffJob, processedAt: string, status: CutoffWorkerOutcome['status'], extra: Partial<CutoffWorkerOutcome> = {}): CutoffWorkerOutcome {
  return cutoffWorkerOutcomeSchema.parse({ schemaVersion: 1, requestId: job.requestId, periodId: job.periodId, processedAt, status, createdCount: 0, remainingCount: 0, baselineId: null, frozenAt: null, nextRequestId: null, blockedCode: null, ...extra });
}
export function blockedCutoffOutcome(job: CutoffJob, at: string, code: CutoffBlockedCode): CutoffWorkerOutcome { return cutoffOutcome(job, at, 'blocked', { blockedCode: code }); }
/** One target, one workspace UOW; no global freeze guard or nested public command. */
export function createCutoffWorkerFacade(writer: CutoffJobUnitOfWork, tools: RecurrenceTools): CutoffWorkerFacade {
  return { async freezeDuePeriod(rawJob) {
    const parsed = cutoffJobSchema.safeParse(rawJob);
    if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid cutoff processing job.');
    const job = parsed.data;
    return writer.run(job, async scope => {
      if (scope.context.workspaceId !== job.workspaceId || scope.context.source !== 'job') throw new Error('Cutoff jobs require their own workspace job scope.');
      const repo = scope.cutoff, period = await requireCutoffPeriod(repo, job.workspaceId, job.periodId), at = scope.barrierAt.toISOString();
      if (period.projectId !== job.projectId) throw notFoundError();
      const grant = await repo.currentGrant(job.workspaceId, job.periodId);
      // Stronger than public command replay: current exact delegation precedes every delivery receipt.
      if (!grant) return blockedCutoffOutcome(job, at, 'automation_not_configured');
      if (grant.id !== job.grantId || grant.revision !== job.grantRevision) return blockedCutoffOutcome(job, at, 'cutoff_grant_stale');
      const authority = await cutoffAuthority(repo, grant);
      if (authority) return blockedCutoffOutcome(job, at, authority);
      if (grant.authorizerUserId !== scope.context.actor.userId || grant.authorizerMembershipId !== scope.access.membership.id) return blockedCutoffOutcome(job, at, 'cutoff_authorizer_inactive');
      const payloadHash = tools.digest(canonicalJson(job)), stored = await repo.request(job.workspaceId, job.requestId);
      if (!stored) throw notFoundError();
      if (stored.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'The cutoff request was reused with different inputs.');
      if (stored.result) return cutoffWorkerOutcomeSchema.parse(stored.result);
      let outcome: CutoffWorkerOutcome;
      if (period.state === 'frozen') {
        const baseline = period.projectBaselineId ? await repo.baselineHeader(job.workspaceId, period.projectBaselineId) : null;
        if (!baseline) throw new Error('A frozen cutoff period lost its baseline.');
        outcome = cutoffOutcome(job, at, 'already_frozen', { baselineId: baseline.id, frozenAt: baseline.frozenAt });
      } else {
        const sources = await cutoffSources(repo, tools, period, scope.barrierAt);
        if (stored.supersededAt !== null || job.periodRevision !== period.revision || job.cutoffAt !== period.cutoffAt || job.sourceManifestHash !== sources.sourceManifestHash) {
          const nextRequestId = await requestCutoffForPeriod(scope, period, 'stale_job', tools);
          outcome = cutoffOutcome(job, at, 'stale', { nextRequestId, remainingCount: sources.assessment.missingCount });
        } else if (Date.parse(period.cutoffAt) > scope.barrierAt.getTime()) {
          const nextRequestId = await requestCutoffForPeriod(scope, period, 'early_job', tools, true);
          outcome = cutoffOutcome(job, at, 'not_due', { nextRequestId, remainingCount: sources.assessment.missingCount });
        } else if (sources.assessment.status === 'blocked') {
          outcome = cutoffOutcome(job, at, 'blocked', { remainingCount: sources.assessment.missingCount, blockedCode: sources.assessment.bindings.find(binding => binding.state === 'blocked')?.blockedCode ?? 'source_unavailable' });
        } else {
          const progress = await scope.recurrenceCensus.ensurePeriod(period, { maxCreates: CUTOFF_LIMITS.maxCreates, reason: 'freeze', cursor: null, bindingId: null });
          if (progress.status === 'blocked') {
            outcome = cutoffOutcome(job, at, 'blocked', { createdCount: progress.createdCount, remainingCount: progress.remainingCount, blockedCode: progress.bindings.find(binding => binding.state === 'blocked')?.blockedCode ?? 'source_unavailable' });
          } else if (progress.status === 'pending') {
            const nextRequestId = await requestCutoffForPeriod(scope, period, 'continuation', tools, true);
            if (!nextRequestId) throw new Error('A pending cutoff chunk lost its durable continuation.');
            outcome = cutoffOutcome(job, at, 'pending', { createdCount: progress.createdCount, remainingCount: progress.remainingCount, nextRequestId });
          } else {
            const baseline = await performFreeze(scope, period, 'project', null, 'cutoff', tools);
            outcome = cutoffOutcome(job, at, 'frozen', { createdCount: progress.createdCount, baselineId: baseline.id, frozenAt: baseline.frozenAt });
          }
        }
      }
      await repo.completeRequest(job.workspaceId, job.requestId, payloadHash, outcome, scope.context.actor.userId, scope.access.membership.id);
      return outcome;
    });
  } };
}
