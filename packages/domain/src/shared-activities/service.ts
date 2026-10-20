import * as C from '@workloom/contracts';
import { roleHasCapability } from '../access/capabilities.js';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { capabilityRequiredError, DomainError, notFoundError } from '../errors.js';
import { setTaskFieldValueInScope } from '../fields/service.js';
import { isCommittedPlanningRejection, unwrapPlanningOutcome } from '../planning/freeze.js';
import { canonicalJson, createTaskInScope } from '../tasks/service.js';
import type { PlanningMutationIntent } from '../planning/ports.js';
import type { SharedActivityApplication, SharedActivityDependencies, SharedActivityScope } from './ports.js';

type Parser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
function parse<T>(schema: Parser<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new DomainError('VALIDATION_FAILED', 'Invalid shared activity input.'); return result.data; }
function found<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw notFoundError(); return value; }
function rule(message: string): never { throw new DomainError('DOMAIN_VALIDATION_FAILED', message); }
function revision(actual: number, expected: number): void { if (actual !== expected) throw new DomainError('REVISION_CONFLICT', 'The shared activity source changed. Reload before saving.'); }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function createSharedActivityService(deps: SharedActivityDependencies): SharedActivityApplication {
  const normalize = (ctx: CommandContext): CommandContext => ({ ...ctx, workspaceId: C.idSchema.parse(ctx.workspaceId), actor: { ...ctx.actor, userId: C.idSchema.parse(ctx.actor.userId) } });
  const emptyCategory = (): C.SharedActivityCategorySnapshotDto => ({ fieldId: null, optionId: null, label: null, color: null, definitionVersionId: null, valueRevision: null });
  async function task(scope: SharedActivityScope, taskId: string, write = false) {
    const row = found(await scope.repository.tasks.findTask(scope.context.workspaceId, taskId));
    if (row.visibility !== 'workspace') throw notFoundError();
    const project = found(await scope.repository.tasks.findProject(scope.context.workspaceId, row.projectId));
    if (write && (row.archivedAt !== null || project.archivedAt !== null)) rule('Restore the task and project before editing the shared activity.');
    return row;
  }
  async function binding(scope: SharedActivityScope, projectId: string, config: Pick<C.SharedActivityConfiguration, 'planFieldId' | 'factFieldId' | 'categoryFieldId'>) {
    for (const [fieldId, type] of [[config.planFieldId, 'duration'], [config.factFieldId, 'duration'], ...(config.categoryFieldId ? [[config.categoryFieldId, 'single_select']] : [])] as const) {
      const field = found(await scope.repository.findField(scope.context.workspaceId, fieldId));
      if (!same(field.projectId, projectId) || field.archivedAt !== null || field.type !== type) rule('Choose available fields of the task home project with compatible types.');
    }
    if (same(config.planFieldId, config.factFieldId)) rule('Choose different plan and actual duration fields.');
  }
  async function duration(scope: SharedActivityScope, activity: Pick<C.SharedActivityDto, 'taskId' | 'planFieldId' | 'factFieldId'>, which: 'plan' | 'fact') {
    const value = await scope.repository.findValue(scope.context.workspaceId, activity.taskId, which === 'plan' ? activity.planFieldId : activity.factFieldId);
    if (value && value.value.type !== 'duration') rule('A shared activity duration has an incompatible type.');
    const raw = value?.value.value;
    return { minutes: typeof raw === 'number' ? raw : null, revision: value?.revision ?? 0 };
  }
  async function category(scope: SharedActivityScope, activity: C.SharedActivityDto): Promise<C.SharedActivityCategorySnapshotDto> {
    if (!activity.categoryFieldId) return emptyCategory();
    const field = found(await scope.repository.findField(scope.context.workspaceId, activity.categoryFieldId));
    if (field.type !== 'single_select' || field.projectId !== activity.projectId || field.archivedAt !== null) rule('The activity category field is unavailable.');
    const value = await scope.repository.findValue(scope.context.workspaceId, activity.taskId, field.id);
    if (value && value.value.type !== 'single_select') rule('The category value has an incompatible type.');
    const optionId = typeof value?.value.value === 'string' ? value.value.value : null;
    const option = optionId ? found(field.options.find(item => item.id === optionId)) : null;
    return { fieldId: field.id, optionId, label: option?.name ?? null, color: option?.color ?? null, definitionVersionId: field.definitionVersionId, valueRevision: value?.revision ?? null };
  }
  async function record(scope: SharedActivityScope, activity: C.SharedActivityDto): Promise<C.SharedActivityRecordDto> {
    const [plan, fact, rows] = await Promise.all([duration(scope, activity, 'plan'), duration(scope, activity, 'fact'), scope.activities.contributions(activity.id)]);
    return { activity, contributions: rows.map(row => row.rosterActive && !row.plannedOverride ? { ...row, currentPlannedMinutes: plan.minutes } : row),
      plannedDurationMinutes: plan.minutes, actualDurationMinutes: fact.minutes, planValueRevision: plan.revision, factValueRevision: fact.revision,
      permissions: { selfMembershipId: scope.access.membership.id, canWriteSelf: roleHasCapability(scope.access.membership.role, 'time.write_self'),
        canWriteOthers: roleHasCapability(scope.access.membership.role, 'time.write_others'), canEditActivity: roleHasCapability(scope.access.membership.role, 'task.edit') } };
  }
  async function writeContribution(scope: SharedActivityScope, contribution: C.SharedActivityContributionDto, changeSeq: bigint) {
    await scope.activities.saveContribution(contribution);
    await scope.activities.insertContributionVersion({ id: deps.newId(), contribution, actorUserId: scope.context.actor.userId, recordedAt: scope.barrierAt.toISOString(), changeSeq: changeSeq.toString() });
  }
  async function configureInScope(scope: SharedActivityScope, taskId: string, input: C.ConfigureSharedActivityInput): Promise<C.SharedActivityRecordDto> {
    if(input.configuration.plannedOverrides.length)rule('Personal plan overrides are not supported. Edit the bound ordinary plan field.');
    const currentTask = await task(scope, taskId, true), old = await scope.activities.findByTask(taskId), config = input.configuration;
    if (currentTask.meetingId) rule('Legacy native meetings retain their existing attendance sources.');
    revision(currentTask.revision, input.expectedTaskRevision); revision(old?.revision ?? 0, input.expectedActivityRevision);
    await binding(scope, currentTask.projectId, config);
    const plan = await duration(scope, { taskId, ...config }, 'plan'); revision(plan.revision, input.expectedPlanValueRevision);
    const members = await scope.repository.tasks.access.listActiveMemberships(scope.context.workspaceId), allowed = new Set(members.map(member => member.id));
    const previous = old ? await scope.activities.contributions(old.id) : [];
    for (const memberId of [...config.attendeeMembershipIds, config.organizerMembershipId]) if (!allowed.has(memberId) && !previous.some(row => row.membershipId === memberId && row.rosterActive)) throw notFoundError();
    if (previous.some(row => row.confirmedActivityRevision !== null) && old && (old.planFieldId !== config.planFieldId || old.factFieldId !== config.factFieldId)) rule('Confirmed attendance retains its original duration field bindings.');
    const activity: C.SharedActivityDto = { id: old?.id ?? deps.newId(), workspaceId: scope.context.workspaceId, projectId: currentTask.projectId, taskId,
      revision: (old?.revision ?? 0) + 1, planFieldId: config.planFieldId, factFieldId: config.factFieldId, categoryFieldId: config.categoryFieldId,
      organizerMembershipId: config.organizerMembershipId, occurrenceDate: config.occurrenceDate, startAt: config.startAt, recordingUrl: config.recordingUrl,
      summaryUrl: config.summaryUrl, summaryText: config.summaryText, createdAt: old?.createdAt ?? scope.barrierAt.toISOString(), updatedAt: scope.barrierAt.toISOString() };
    if (new Set([...previous.map(row => row.membershipId), ...config.attendeeMembershipIds]).size > 1000) rule('A shared activity supports at most 1000 historical participants.');
    const overrides = new Map(config.plannedOverrides.map(row => [row.membershipId, row.minutes]));
    await scope.activities.saveActivity(activity);
    const change = await scope.recordChange({ entityType: 'shared_activity', entityId: activity.id, entityRevision: activity.revision, action: old ? 'updated' : 'created',
      diff: { taskId, revision: activity.revision, participantCount: config.attendeeMembershipIds.length }, outbox: { type: 'shared_activity.changed', payload: { taskId, activityId: activity.id, revision: activity.revision } } });
    await scope.activities.insertActivityVersion(activity, scope.context.actor.userId, change.changeSeq.toString());
    for (const membershipId of new Set([...previous.map(row => row.membershipId), ...config.attendeeMembershipIds])) {
      const prior = previous.find(row => row.membershipId === membershipId), active = config.attendeeMembershipIds.includes(membershipId), planned = overrides.has(membershipId) ? overrides.get(membershipId) ?? null : plan.minutes;
      const contribution: C.SharedActivityContributionDto = prior ? { ...prior, rosterActive: active, currentPlannedMinutes: active ? planned : prior.currentPlannedMinutes,
        plannedOverride: active ? overrides.has(membershipId) : prior.plannedOverride, plannedActivityRevision: activity.revision, revision: prior.revision + 1, updatedAt: activity.updatedAt }
        : { id: deps.newId(), workspaceId: activity.workspaceId, activityId: activity.id, taskId, membershipId, revision: 1, rosterActive: true,
          originalPlannedMinutes: planned, currentPlannedMinutes: planned, plannedOverride: overrides.has(membershipId), originalActivityRevision: activity.revision, plannedActivityRevision: activity.revision,
          attendance: 'unconfirmed', postingState: 'unconfirmed', minutes: null, confirmedActivityRevision: null, confirmedFactValueRevision: null,
          confirmedDurationMinutes: null, confirmedOccurrenceDate: null, category: null, reason: null, updatedAt: activity.updatedAt };
      await writeContribution(scope, contribution, change.changeSeq);
    }
    return record(scope, activity);
  }
  async function authorizeAttendance(scope: SharedActivityScope, taskId: string, input: C.ConfirmSharedActivityAttendanceInput) {
    await task(scope, taskId, true); const activity = found(await scope.activities.findByTask(taskId)), rows = await scope.activities.contributions(activity.id);
    for (const item of input.rows) {
      const row = found(rows.find(row => row.id === item.contributionId));
      if (row.membershipId !== scope.access.membership.id && !roleHasCapability(scope.access.membership.role, 'time.write_others')) throw capabilityRequiredError();
    }
  }
  async function mutate<T>(ctx: CommandContext, cap: Capability, intent: Extract<PlanningMutationIntent, { family: 'shared_activity' }>, schema: Parser<T>, work: (scope: SharedActivityScope) => Promise<T>, beforeReplay?: (scope: SharedActivityScope) => Promise<void>): Promise<T> {
    const context = normalize(ctx), key = context.idempotencyKey;
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
    const hash = deps.digest(canonicalJson(intent));
    const outcome = await deps.write(context, cap, async scope => {
      if (intent.target.taskId) await task(scope, intent.target.taskId, true);
      else { const project = found(await scope.repository.tasks.findProject(context.workspaceId, found(intent.target.projectId))); if (project.archivedAt) rule('Restore the project first.'); }
      if (beforeReplay) await beforeReplay(scope);
      const repository = scope.repository.tasks, prior = await repository.findIdempotency(context.workspaceId, context.actor.userId, intent.command, key);
      if (prior) { if (prior.payloadHash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key was used for another request.'); return isCommittedPlanningRejection(prior.result) ? prior.result : parse(schema, prior.result); }
      const rejected = await scope.planningGuard.check(intent), result = rejected ?? await work(scope);
      await repository.insertIdempotency({ workspaceId: context.workspaceId, actorUserId: context.actor.userId, command: intent.command, idempotencyKey: key, payloadHash: hash, result, createdAt: scope.barrierAt.toISOString() }); return result;
    });
    return unwrapPlanningOutcome(outcome);
  }
  return {
    get(ctx, taskId) { const tid = C.idSchema.parse(taskId); return deps.read(normalize(ctx), 'task.read', async scope => { await task(scope, tid); return record(scope, found(await scope.activities.findByTask(tid))); }); },
    configure(ctx, taskId, input) {
      const tid = C.idSchema.parse(taskId), parsed = parse(C.configureSharedActivityInputSchema, input);
      return mutate(ctx, 'task.edit', { family: 'shared_activity', command: 'shared_activity.configure', target: { projectId: null, taskId: tid }, input: parsed, fieldPolicyCandidates: [] }, C.sharedActivityRecordSchema, scope => configureInScope(scope, tid, parsed));
    },
    create(ctx, projectId, input) {
      const pid = C.idSchema.parse(projectId), parsed = parse(C.createSharedActivityInputSchema, input);
      if (parsed.task.projectId !== pid || parsed.task.parentTaskId) rule('Shared activity creation requires one root task in the selected project.');
      const candidates = [{ fieldId: parsed.configuration.planFieldId, expectedDefinitionRevision: parsed.plan.expectedDefinitionRevision, value: { type: 'duration' as const, value: parsed.plan.minutes } }, { fieldId: parsed.configuration.factFieldId, expectedDefinitionRevision: parsed.fact.expectedDefinitionRevision, value: { type: 'duration' as const, value: parsed.fact.minutes } }];
      return mutate(ctx, 'task.edit', { family: 'shared_activity', command: 'shared_activity.create', target: { projectId: pid, taskId: null }, input: parsed, fieldPolicyCandidates: candidates }, C.createSharedActivityResultSchema, async scope => {
        await binding(scope, pid, parsed.configuration);
        const created = await createTaskInScope(scope.taskScope, { ...parsed.task, responsibleMembershipId: parsed.configuration.organizerMembershipId, dueDate: parsed.configuration.occurrenceDate }, deps, candidates);
        for (const candidate of candidates) await setTaskFieldValueInScope(scope, created.id, candidate.fieldId, { expectedDefinitionRevision: candidate.expectedDefinitionRevision, expectedRevision: 0, value: candidate.value }, deps);
        const currentTask=await task(scope,created.id,true),currentPlan=await duration(scope,{taskId:created.id,...parsed.configuration},'plan');
        return { task: currentTask, sharedActivity: await configureInScope(scope, created.id, { expectedTaskRevision: currentTask.revision, expectedActivityRevision: 0, expectedPlanValueRevision: currentPlan.revision, configuration: parsed.configuration }) };
      });
    },
    confirm(ctx, taskId, input) {
      const tid = C.idSchema.parse(taskId), parsed = parse(C.confirmSharedActivityAttendanceInputSchema, input);
      return mutate(ctx, 'time.write_self', { family: 'shared_activity', command: 'shared_activity.attendance', target: { projectId: null, taskId: tid }, input: parsed, fieldPolicyCandidates: [] }, C.sharedActivityRecordSchema, async scope => {
        const activity = found(await scope.activities.findByTask(tid)); revision(activity.revision, parsed.expectedActivityRevision);
        await binding(scope, activity.projectId, activity); const fact = await duration(scope, activity, 'fact'); revision(fact.revision, parsed.expectedFactValueRevision);
        const rows = await scope.activities.contributions(activity.id), prepared: C.SharedActivityContributionDto[] = [];
        for (const item of parsed.rows) {
          const previous = found(rows.find(row => row.id === item.contributionId)); revision(previous.revision, item.expectedRevision);
          if (!previous.rosterActive && previous.confirmedActivityRevision === null) rule('An unconfirmed former participant cannot receive new attendance.');
          const postingState = item.void ? 'void' : item.attendance === 'unconfirmed' ? 'unconfirmed' : 'active';
          let minutes: number | null = null;
          if (postingState === 'active') {
            if (item.attendance === 'absent') minutes = 0;
            else if (fact.minutes === null) rule('Set the actual event duration before confirming attendance.');
            else if (item.attendance === 'present') minutes = fact.minutes;
            else { if (item.minutes === undefined || item.minutes > fact.minutes) rule('Partial attendance needs explicit minutes within the event duration.'); minutes = item.minutes; }
          }
          if ((previous.confirmedActivityRevision !== null || previous.postingState === 'void' || item.recategorize || item.void) && !item.reason) rule('A correction, void, restore or recategorization requires a reason.');
          const categorySnapshot = previous.category && !item.recategorize ? previous.category : postingState === 'active' ? await category(scope, activity) : previous.category;
          prepared.push({ ...previous, revision: previous.revision + 1, attendance: item.attendance, postingState, minutes,
            confirmedActivityRevision: postingState === 'active' ? activity.revision : previous.confirmedActivityRevision,
            confirmedFactValueRevision: postingState === 'active' ? fact.revision : previous.confirmedFactValueRevision,
            confirmedDurationMinutes: postingState === 'active' ? fact.minutes : previous.confirmedDurationMinutes,
            confirmedOccurrenceDate: previous.confirmedOccurrenceDate ?? (postingState === 'active' ? activity.occurrenceDate : null),
            category: categorySnapshot, reason: item.reason ?? null, updatedAt: scope.barrierAt.toISOString() });
        }
        for (const row of prepared) {
          const change = await scope.recordChange({ entityType: 'shared_attendance', entityId: row.id, action: 'confirmed', entityRevision: row.revision,
            diff: { taskId: tid, activityId: activity.id, membershipId: row.membershipId, revision: row.revision, status: row.attendance, state: row.postingState }, ...(row.reason ? { reason: row.reason } : {}),
            outbox: { type: 'shared_activity.attendance_changed', payload: { taskId: tid, activityId: activity.id, contributionId: row.id, revision: row.revision } } });
          await writeContribution(scope, row, change.changeSeq);
        }
        return record(scope, activity);
      }, scope => authorizeAttendance(scope, tid, parsed));
    },
    history(ctx, taskId, contributionId) {
      const tid = C.idSchema.parse(taskId), cid = C.idSchema.parse(contributionId);
      return deps.read(normalize(ctx), 'task.read', async scope => { await task(scope, tid); const activity = found(await scope.activities.findByTask(tid)); found((await scope.activities.contributions(activity.id)).find(row => row.id === cid)); return scope.activities.history(activity.id, cid); });
    },
  };
}
