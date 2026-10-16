import {
  CUTOFF_LIMITS, CUTOFF_REQUESTED_EVENT, configureCutoffInputSchema, cutoffCommandResultSchema, cutoffGrantSchema,
  cutoffJobSchema, cutoffReadinessSchema, idSchema, retryCutoffInputSchema,
  type ConfigureCutoffInput, type CutoffBlockedCode, type CutoffCommandResultDto, type CutoffGrantDto,
  type CutoffReadinessDto, type PlanningPeriodDto, type RetryCutoffInput,
} from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import { roleHasCapability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError, unauthenticatedError } from '../errors.js';
import { createPlanningMutationGuard } from '../planning/freeze.js';
import { assessmentOf, evaluatePeriodCensus, periodManifestHash } from '../recurrence/materializer.js';
import type { RecurrenceTools } from '../recurrence/ports.js';
import { canonicalJson } from '../tasks/service.js';
import type { CutoffApplication } from './application.js';
import type { CutoffGrantRecord, CutoffReadScope, CutoffRepository, CutoffRequestReason, CutoffSources, CutoffUnitOfWork, CutoffWriteScope } from './ports.js';

export function canonicalCutoffContext(value: CommandContext): CommandContext {
  const ws = idSchema.safeParse(value.workspaceId), actor = idSchema.safeParse(value.actor.userId);
  if (!ws.success) throw notFoundError(); if (!actor.success) throw unauthenticatedError();
  return { ...value, workspaceId: ws.data, actor: { ...value.actor, userId: actor.data } };
}
export function cutoffPeriodId(value: string): string { const p = idSchema.safeParse(value); if (!p.success) throw notFoundError(); return p.data; }
export function cutoffRule(message: string): DomainError { return new DomainError('DOMAIN_VALIDATION_FAILED', message); }
export function cutoffConflict(message: string): DomainError { return new DomainError('REVISION_CONFLICT', message); }
export async function cutoffAuthority(repo: CutoffRepository, grant: CutoffGrantDto | null): Promise<CutoffBlockedCode | null> {
  if (!grant) return 'automation_not_configured';
  if (grant.state !== 'active') return 'cutoff_grant_revoked';
  const access = await repo.access.findWorkspaceAccess(grant.workspaceId, grant.authorizerUserId);
  if (!access || access.membership.id !== grant.authorizerMembershipId || access.membership.userId !== grant.authorizerUserId || access.membership.state !== 'active') return 'cutoff_authorizer_inactive';
  return (access.membership.role === 'owner' || access.membership.role === 'admin') && roleHasCapability(access.membership.role, 'plan.freeze_project') ? null : 'cutoff_authorizer_capability_revoked';
}
export async function cutoffSources(repo: CutoffRepository, tools: Pick<RecurrenceTools, 'digest' | 'resolver'>, period: PlanningPeriodDto, at: Date): Promise<CutoffSources> {
  // Existing census checks generation authority only for actual missing creations, including paused series.
  const evaluated = await evaluatePeriodCensus(repo.recurrence, tools, period, at);
  return { assessment: assessmentOf(period.id, evaluated), sourceManifestHash: periodManifestHash(tools, period.id, evaluated.map(item => ({ bindingId: item.binding.id, hash: item.hash }))) };
}
export async function requireCutoffPeriod(repo: CutoffRepository, workspaceId: string, periodId: string): Promise<PlanningPeriodDto> {
  const period = await repo.planning.findPeriod(workspaceId, periodId);
  if (!period || !await repo.planning.tasks.findProject(workspaceId, period.projectId)) throw notFoundError();
  return period;
}
/** Internal metadata request only, on the caller's already authorized open workspace transaction. */
export async function requestCutoffForPeriod(scope: CutoffWriteScope, period: PlanningPeriodDto, reason: CutoffRequestReason, tools: RecurrenceTools, force = false): Promise<string | null> {
  if (period.workspaceId !== scope.context.workspaceId) throw new Error('A cutoff request must remain in its workspace.');
  if (period.state !== 'planning') return null;
  // Public commands retain their original input/hash; internal jobs use the same millisecond instant persisted by repositories.
  const cutoffAt = new Date(period.cutoffAt).toISOString();
  const repo = scope.cutoff, ws = period.workspaceId, grant = await repo.currentGrant(ws, period.id);
  if (!grant || await cutoffAuthority(repo, grant) !== null) return null;
  const { sourceManifestHash } = await cutoffSources(repo, tools, period, scope.barrierAt);
  const latest = await repo.latestRequest(ws, period.id, grant);
  const sameSource = latest && latest.job.periodRevision === period.revision && latest.job.cutoffAt === cutoffAt && latest.job.sourceManifestHash === sourceManifestHash;
  // Historical blocked/processed requests suppress automatic hot retries until explicit recovery or changed inputs.
  if (!force && sameSource) {
    const stillLive = latest.processedAt === null && latest.supersededAt === null;
    // Normal early delivery installs its replacement atomically; discovery can also repair a retained terminal early receipt.
    const dueEarlyCatchup = reason === 'discovery' && latest.result?.status === 'not_due' && Date.parse(cutoffAt) <= scope.barrierAt.getTime() && !await repo.liveRequest(ws, period.id);
    if (!dueEarlyCatchup) return stillLive ? latest.job.requestId : null;
  }
  const at = scope.barrierAt.toISOString();
  await repo.supersedeLive(ws, period.id, at);
  const job = cutoffJobSchema.parse({ schemaVersion: 1, requestId: tools.newId(), workspaceId: ws, projectId: period.projectId, periodId: period.id, grantId: grant.id, grantRevision: grant.revision, periodRevision: period.revision, cutoffAt, sourceManifestHash });
  const { workspaceId: _workspaceId, schemaVersion: _version, ...payload } = job;
  const change = await scope.recordChange({ entityType: 'planning_cutoff_request', entityId: job.requestId, action: 'requested', entityRevision: 1, diff: { periodId: period.id, grantId: grant.id, grantRevision: grant.revision, reason }, outbox: { type: CUTOFF_REQUESTED_EVENT, schemaVersion: 1, payload } });
  await repo.insertRequest({ job, payloadHash: tools.digest(canonicalJson(job)), reason, createdAt: at, requestedByUserId: scope.context.actor.userId, source: scope.context.source, changeSeq: change.changeSeq.toString(), supersededAt: null, processedAt: null, result: null });
  return job.requestId;
}

async function readiness(context: CommandContext, periodId: string, scope: CutoffReadScope, tools: RecurrenceTools): Promise<CutoffReadinessDto> {
  const repo = scope.repository, ws = context.workspaceId;
  const access = await authorizeWorkspace(repo.access, context, 'task.read');
  const period = await requireCutoffPeriod(repo, ws, periodId), grant = await repo.currentGrant(ws, periodId);
  const authority = await cutoffAuthority(repo, grant);
  const canConfigure = (access.membership.role === 'owner' || access.membership.role === 'admin') && roleHasCapability(access.membership.role, 'plan.freeze_project');
  const latest = grant ? await repo.latestRequest(ws, periodId, grant) : null;
  const completed = grant ? await repo.latestCompletedRequest(ws, periodId, grant) : null;
  const baseline = period.projectBaselineId ? await repo.baselineHeader(ws, period.projectBaselineId) : null;
  if (period.state === 'frozen' && !baseline) throw new Error('A frozen period lost its persisted baseline.');
  const assessment = period.state === 'frozen' ? { missingCount: 0, bindings: [] } : (await cutoffSources(repo, tools, period, scope.serverAt)).assessment;
  const blockers: CutoffReadinessDto['blockers'] = period.state !== 'frozen' && authority && authority !== 'automation_not_configured' ? [{ kind: 'cutoff', code: authority, bindingId: null, seriesId: null }] : [];
  for (const binding of assessment.bindings) if (binding.state === 'blocked') blockers.push({ kind: 'recurrence', code: binding.blockedCode ?? 'source_unavailable', seriesId: binding.seriesId, bindingId: binding.bindingId });
  const due = Date.parse(period.cutoffAt) <= scope.serverAt.getTime();
  const state: CutoffReadinessDto['readiness'] = period.state === 'frozen' ? 'frozen' : !due ? 'planning' : (authority !== null && authority !== 'automation_not_configured') || assessment.bindings.some(b => b.state === 'blocked') ? 'blocked' : completed?.result?.status === 'pending' && assessment.missingCount > 0 ? 'preparing_calendar' : 'overdue_waiting';
  const latestRequest: CutoffReadinessDto['latestRequest'] = latest ? { id: latest.job.requestId, state: latest.processedAt ? 'completed' : latest.supersededAt ? 'superseded' : Date.parse(latest.job.cutoffAt) > scope.serverAt.getTime() ? 'scheduled' : 'pending', createdAt: latest.createdAt, notBefore: latest.job.cutoffAt, processedAt: latest.processedAt } : null;
  return cutoffReadinessSchema.parse({ periodId, periodRevision: period.revision, persistedState: period.state, serverNow: scope.serverAt.toISOString(), cutoffAt: period.cutoffAt, baseline, automation: { state: !grant ? 'not_configured' : grant.state === 'active' ? 'enabled' : 'revoked', grant: grant ? cutoffGrantSchema.parse(grant) : null }, readiness: state, missingCount: assessment.missingCount, blockedCount: blockers.length, blockers: blockers.slice(0, CUTOFF_LIMITS.maxReadinessBlockers), truncated: blockers.length > CUTOFF_LIMITS.maxReadinessBlockers, latestRequest, latestOutcome: completed?.result ?? null, actions: { canConfigure, canRetry: canConfigure && period.state === 'planning' && authority === null, canFreezeProject: canConfigure && period.state === 'planning' } });
}

export function createCutoffApplication(unit: CutoffUnitOfWork, tools: RecurrenceTools): CutoffApplication {
  async function mutate(context: CommandContext, periodId: string, input: ConfigureCutoffInput | RetryCutoffInput, command: 'cutoff.configure' | 'cutoff.retry'): Promise<CutoffCommandResultDto> {
    const ctx = canonicalCutoffContext(context), id = cutoffPeriodId(periodId), key = ctx.idempotencyKey;
    const parsed = command === 'cutoff.configure' ? configureCutoffInputSchema.safeParse(input) : retryCutoffInputSchema.safeParse(input);
    if (!parsed.success || !key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new DomainError('VALIDATION_FAILED', 'Invalid cutoff command input.');
    const payloadHash = tools.digest(canonicalJson({ command, target: { periodId: id }, input: parsed.data }));
    return unit.run(ctx, async scope => {
      const repo = scope.cutoff, period = await requireCutoffPeriod(repo, ctx.workspaceId, id);
      // Current target access and capability precede exact public-command replay. Replay requests nothing new.
      const old = await repo.findIdempotency(ctx.workspaceId, ctx.actor.userId, command, key);
      if (old) { if (old.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This operation key belongs to another request.'); return cutoffCommandResultSchema.parse(old.result); }
      if (period.revision !== parsed.data.expectedPeriodRevision) throw cutoffConflict('The period changed. Reload before configuring cutoff processing.');
      let grant = await repo.currentGrant(ctx.workspaceId, id);
      if ((grant?.revision ?? 0) !== parsed.data.expectedGrantRevision) throw cutoffConflict('The cutoff delegation changed. Reload before continuing.');
      const rejected = await createPlanningMutationGuard(scope, tools).check({ family: 'cutoff', command, target: { periodId: id }, input: parsed.data });
      if (rejected) throw new Error('Cutoff recovery entered a global planning prerequisite.');
      const at = scope.barrierAt.toISOString();
      let requestId: string | null = null;
      if (command === 'cutoff.configure') {
        const config = configureCutoffInputSchema.parse(parsed.data), previous = grant;
        const grantId = previous?.id ?? tools.newId(), revision = (previous?.revision ?? 0) + 1;
        const change = await scope.recordChange({ entityType: 'planning_cutoff_grant', entityId: grantId, action: config.enabled ? 'authorized' : 'revoked', entityRevision: revision, diff: { periodId: id, previousRevision: previous?.revision ?? 0, state: config.enabled ? 'active' : 'revoked', authorizerUserId: config.enabled ? ctx.actor.userId : previous?.authorizerUserId ?? ctx.actor.userId } });
        grant = { id: grantId, workspaceId: ctx.workspaceId, projectId: period.projectId, periodId: id, revision, scope: 'project_cutoff', state: config.enabled ? 'active' : 'revoked', authorizerUserId: config.enabled ? ctx.actor.userId : previous?.authorizerUserId ?? ctx.actor.userId, authorizerMembershipId: config.enabled ? scope.access.membership.id : previous?.authorizerMembershipId ?? scope.access.membership.id, activatedAt: config.enabled ? at : previous?.activatedAt ?? null, recordedAt: at, actorUserId: ctx.actor.userId, actorMembershipId: scope.access.membership.id, source: ctx.source, changeSeq: change.changeSeq.toString() } satisfies CutoffGrantRecord;
        await repo.saveGrant(grant, previous?.revision ?? 0);
        await repo.supersedeLive(ctx.workspaceId, id, at);
        if (config.enabled) requestId = await requestCutoffForPeriod(scope, period, previous ? 'replaced' : 'enabled', tools, true);
      } else {
        if (!grant || period.state !== 'planning') throw cutoffRule('Only an enabled planning period can request cutoff processing.');
        const blocked = await cutoffAuthority(repo, grant); if (blocked) throw cutoffRule('Reauthorize the current cutoff delegation before requesting processing.');
        requestId = await requestCutoffForPeriod(scope, period, 'retry', tools, true);
      }
      if (!grant) throw new Error('A cutoff command lost its grant.');
      const result = cutoffCommandResultSchema.parse({ periodId: id, grant: cutoffGrantSchema.parse(grant), requestId });
      await repo.insertIdempotency({ workspaceId: ctx.workspaceId, actorUserId: ctx.actor.userId, command, idempotencyKey: key, payloadHash, result, createdAt: at });
      return result;
    });
  }
  return {
    getReadiness: (context, id) => { const ctx = canonicalCutoffContext(context), periodId = cutoffPeriodId(id); return unit.read(ctx, scope => readiness(ctx, periodId, scope, tools)); },
    configure: (context, id, input) => mutate(context, id, input, 'cutoff.configure'),
    retry: (context, id, input) => mutate(context, id, input, 'cutoff.retry'),
  };
}
