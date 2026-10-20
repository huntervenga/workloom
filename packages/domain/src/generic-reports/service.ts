import * as C from '@workloom/contracts';
import {roleHasCapability} from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError } from '../errors.js';
import { canonicalJson } from '../tasks/service.js';
import { createTaskFieldInScope } from '../fields/service.js';
import { isCommittedPlanningRejection, unwrapPlanningOutcome } from '../planning/freeze.js';
import {queryHeaderWidgets,validateHeaderWidgets} from './header-widgets.js';
import {workspaceReportSources,queryWorkspaceReport} from './workspace-service.js';
import { calculateGenericReport, usedFieldIds, validateGenericConfig } from './engine.js';
import type { CommittedPlanningRejection } from '../planning/ports.js';
import type { GenericReportDependencies, GenericReportScope, GenericReportSource } from './ports.js';

export interface GenericReportApplication {
  workspaceSources(context: CommandContext): Promise<C.WorkspaceReportSourcesDto>;
  workspaceQuery(context: CommandContext, input: C.WorkspaceReportQueryInput): Promise<C.WorkspaceReportResultDto>;
  list(context: CommandContext, projectId: string): Promise<C.GenericReportDefinitionDto[]>;
  get(context: CommandContext, reportId: string): Promise<C.GenericReportDefinitionDto>;
  create(context: CommandContext, input: C.CreateGenericReportInput): Promise<C.GenericReportDefinitionDto>;
  update(context: CommandContext, reportId: string, input: C.UpdateGenericReportInput): Promise<C.GenericReportDefinitionDto>;
  query(context: CommandContext, reportId: string, input: C.QueryGenericReportInput): Promise<C.GenericReportResultDto>;
  aggregates(context: CommandContext, projectId: string, input: C.QueryGenericAggregatesInput): Promise<C.GenericReportResultDto>;
  capture(context: CommandContext, reportId: string, input: C.CaptureGenericInitialInput): Promise<C.GenericInitialSnapshotDto>;
  listSnapshots(context: CommandContext, reportId: string): Promise<C.GenericInitialSnapshotDto[]>;
  getSnapshot(context: CommandContext, reportId: string, snapshotId: string): Promise<C.GenericInitialSnapshotDto>;
  headerWidgets(context: CommandContext, projectId: string, input: C.QueryGenericHeaderWidgetsInput): Promise<C.GenericHeaderWidgetsResultDto>;
  getSettings(context: CommandContext, projectId: string): Promise<C.GenericAggregateSettingsDto>;
  setSettings(context: CommandContext, projectId: string, input: C.SetGenericAggregateSettingsInput): Promise<C.GenericAggregateSettingsDto>;
  template(context: CommandContext, projectId: string, input: C.PlanFactTemplateInput): Promise<C.PlanFactTemplateResultDto>;
}
type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
function parse<T>(schema: Schema<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid report input.'); return parsed.data; }
const found = <T>(value: T | null): T => { if (value === null) throw notFoundError(); return value; };
const rule = (message: string) => new DomainError('DOMAIN_VALIDATION_FAILED', message);
function revision(actual: number, expected: number) { if (actual !== expected) throw new DomainError('REVISION_CONFLICT', 'Reload the current report settings before editing.', { details: { currentRevision: actual } }); }
type Command = 'generic_report.create' | 'generic_report.update' | 'generic_report.capture' | 'generic_report.settings' | 'generic_report.template';
export function createGenericReportService(deps: GenericReportDependencies): GenericReportApplication {
  const id = (value: string) => parse(C.idSchema, value);
  const normalize = (ctx: CommandContext): CommandContext => ({ ...ctx, workspaceId: id(ctx.workspaceId), actor: { ...ctx.actor, userId: id(ctx.actor.userId) } });
  async function project(scope: GenericReportScope, projectId: string, writable = false) {
    const result = found(await scope.repository.tasks.findProject(scope.context.workspaceId, projectId));
    if (writable && result.archivedAt !== null) throw rule('Restore the project before editing report settings.'); return result;
  }
  async function report(scope: GenericReportScope, reportId: string) { const result = found(await scope.reports.find(reportId)); await project(scope, result.projectId); return result; }
  async function metadata(scope: GenericReportScope, report: C.GenericReportDefinitionDto, action: string) {
    await scope.recordChange({ entityType: 'generic_report', entityId: report.id, entityRevision: report.revision, action, diff: { projectId: report.projectId, reportId: report.id, revision: report.revision }, outbox: { type: 'generic_report.' + action, payload: { projectId: report.projectId, reportId: report.id, revision: report.revision } } });
  }
  async function mutate<T>(ctx: CommandContext, command: Command, target: string | null, input: unknown, schema: Schema<T>, work: (s: GenericReportScope) => Promise<T | CommittedPlanningRejection>): Promise<T> {
    const context = normalize(ctx), key = context.idempotencyKey;
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
    const payloadHash = deps.digest(canonicalJson({ command, target, input }));
    const result = await deps.write(context, 'fields.manage', async scope => {
      if(target){if(command==='generic_report.update'||command==='generic_report.capture')await report(scope,target);else await project(scope,target);}
      const repo = scope.repository.tasks, existing = await repo.findIdempotency(context.workspaceId, context.actor.userId, command, key);
      if (existing) { if (existing.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key was used for a different request.'); if (isCommittedPlanningRejection(existing.result)) return existing.result; return parse(schema, existing.result); }
      // Explicit metadata-only intent. Template separately invokes ordinary field.create guards.
      const rejected = await scope.planningGuard.check({ family: 'generic_report', command, target: { id: target ?? context.workspaceId, kind: command === 'generic_report.update' || command === 'generic_report.capture' ? 'report' : 'project' }, input });
      const value = rejected ?? await work(scope);
      await repo.insertIdempotency({ workspaceId: context.workspaceId, actorUserId: context.actor.userId, command, idempotencyKey: key, payloadHash, result: value, createdAt: scope.barrierAt.toISOString() });
      return value;
    });
    return unwrapPlanningOutcome(result);
  }
  async function create(scope: GenericReportScope, input: C.CreateGenericReportInput) {
    await project(scope, input.config.projectId, true);
    validateGenericConfig(input.config, await scope.repository.listFields(scope.context.workspaceId, input.config.projectId));await scope.reports.validateCapacity?.(input.config);
    if ((await scope.reports.list(input.config.projectId)).length >= 100) throw rule('The project report limit is 100.');
    const now = scope.barrierAt.toISOString();
    const value: C.GenericReportDefinitionDto = { id: deps.newId(), workspaceId: scope.context.workspaceId, projectId: input.config.projectId, name: input.name, revision: 1, config: input.config, archivedAt: null, createdAt: now, updatedAt: now };
    await scope.reports.save(value); await metadata(scope, value, 'created'); return value;
  }
  function sourceVersion(source: GenericReportSource, config: C.GenericReportConfig, definitionRevision: number | null, snapshotId: string | null = null) {
    // Include labels and field metadata as well as values: provider profile names can change outside the workspace head.
    const stable = { ...source, fields: [...source.fields].sort((a,b)=>a.id.localeCompare(b.id)), tasks: source.tasks.map(t=>({...t,tagIds:[...t.tagIds].sort()})).sort((a,b)=>a.id.localeCompare(b.id)), values: [...source.values].sort((a,b)=>a.taskId.localeCompare(b.taskId)||a.fieldId.localeCompare(b.fieldId)) };
    return deps.digest(canonicalJson({ source: stable, config, definitionRevision, snapshotId }));
  }
  async function calculate(scope: GenericReportScope, config: C.GenericReportConfig, definition: C.GenericReportDefinitionDto | null, input: { offset: number; limit: number; expectedSourceVersion?: string | undefined }, snapshotId: string | null = null) {
    await project(scope, config.projectId);
    if(!definition&&config.capacity)await scope.reports.validateCapacity?.(config,roleHasCapability(scope.access.membership.role,'leave.manage'));
    const source = await scope.reports.source(config), version = sourceVersion(source, config, definition?.revision ?? null, snapshotId);
    if (input.expectedSourceVersion && version !== input.expectedSourceVersion) throw new DomainError('PREVIEW_STALE', 'The source changed. Reload the complete report.');
    const snapshot = snapshotId && definition ? found(await scope.reports.findSnapshot(definition.id, snapshotId)) : null;
    if (snapshot && (snapshot.header.workspaceId !== scope.context.workspaceId || snapshot.header.reportId !== definition?.id || snapshot.header.projectId !== config.projectId)) throw notFoundError();
    if (snapshot && canonicalJson(snapshot.header.config) !== canonicalJson(config)) throw rule('This initial snapshot uses another report configuration. Restore that configuration or choose a matching snapshot.');
    const result = calculateGenericReport(source, config, version, snapshot, input.offset, input.limit);
    return { ...result, reportId: definition?.id ?? null, definitionRevision: definition?.revision ?? null };
  }
  return {
    workspaceSources(ctx) { return deps.read(normalize(ctx), 'reports.read', scope => workspaceReportSources(scope)); },
    workspaceQuery(ctx, input) { const parsed = parse(C.workspaceReportQueryInputSchema, input); return deps.read(normalize(ctx), 'reports.read', scope => queryWorkspaceReport(scope,parsed,deps.digest)); },
    list(ctx, projectId) { const pid = id(projectId); return deps.read(normalize(ctx), 'reports.read', async scope => { await project(scope, pid); return scope.reports.list(pid); }); },
    get(ctx, reportId) { const rid = id(reportId); return deps.read(normalize(ctx), 'reports.read', scope => report(scope, rid)); },
    create(ctx, input) { const parsed = parse(C.createGenericReportInputSchema, input); return mutate(ctx, 'generic_report.create', parsed.config.projectId, parsed, C.genericReportDefinitionSchema, s => create(s, parsed)); },
    update(ctx, reportId, input) {
      const rid = id(reportId), parsed = parse(C.updateGenericReportInputSchema, input);
      return mutate(ctx, 'generic_report.update', rid, parsed, C.genericReportDefinitionSchema, async scope => {
        const current = await report(scope, rid); revision(current.revision, parsed.expectedRevision);
        if (parsed.config.projectId !== current.projectId) throw rule('A report cannot move to another project.');
        await project(scope, current.projectId, true);
        // A broken historical configuration can still be archived without rebinding its field IDs.
        if (!parsed.archived || canonicalJson(parsed.config) !== canonicalJson(current.config)) validateGenericConfig(parsed.config, await scope.repository.listFields(scope.context.workspaceId, current.projectId));
        await scope.reports.validateCapacity?.(parsed.config);
        const next = { ...current, name: parsed.name, config: parsed.config, revision: current.revision + 1, archivedAt: parsed.archived ? current.archivedAt ?? scope.barrierAt.toISOString() : null, updatedAt: scope.barrierAt.toISOString() };
        await scope.reports.save(next); await metadata(scope, next, 'updated'); return next;
      });
    },
    query(ctx, reportId, input) { const rid = id(reportId), parsed = parse(C.queryGenericReportInputSchema, input); return deps.read(normalize(ctx), 'reports.read', async scope => { const current = await report(scope, rid); revision(current.revision, parsed.expectedRevision); return calculate(scope, current.config, current, parsed, parsed.snapshotId); }); },
    aggregates(ctx, projectId, input) { const pid = id(projectId), parsed = parse(C.queryGenericAggregatesInputSchema, input); if (pid !== parsed.config.projectId) throw rule('The aggregate configuration belongs to another project.'); return deps.read(normalize(ctx), 'reports.read', scope => calculate(scope, parsed.config, null, parsed)); },
    capture(ctx, reportId, input) {
      const rid = id(reportId), parsed = parse(C.captureGenericInitialInputSchema, input);
      return mutate(ctx, 'generic_report.capture', rid, parsed, C.genericInitialSnapshotSchema, async scope => {
        const current = await report(scope, rid); revision(current.revision, parsed.expectedRevision); await project(scope, current.projectId, true);
        if (current.archivedAt) throw rule('Restore the report before capturing an initial snapshot.');
        if ((await scope.reports.listSnapshots(rid)).length >= 100) throw rule('The initial snapshot limit is 100.');
        const source = await scope.reports.source(current.config), version = sourceVersion(source, current.config, current.revision);
        if (version !== parsed.expectedSourceVersion) throw new DomainError('PREVIEW_STALE', 'The source changed. Review the current report before capturing it.');
        // Full authorized scope, independent of any client page size or loaded rows.
        const computed = calculateGenericReport(source, current.config, version, null, 0, 5000);
        const header: C.GenericInitialSnapshotDto = { id: deps.newId(), workspaceId: scope.context.workspaceId, projectId: current.projectId, reportId: rid, name: parsed.name, definitionRevision: current.revision, config: current.config, fields: computed.fields, capturedAt: scope.barrierAt.toISOString(), capturedByUserId: scope.context.actor.userId, sourceVersion: version, taskCount: computed.totalTasks,...(source.capacity?{capacity:source.capacity}: {}) };
        const taskIds = new Set(computed.rows.map(r => r.taskId)), fieldIds = new Set(usedFieldIds(current.config));
        await scope.reports.insertSnapshot({ header, rows: computed.rows, values: source.values.filter(v => taskIds.has(v.taskId) && fieldIds.has(v.fieldId)) });
        await scope.recordChange({ entityType: 'generic_report_snapshot', entityId: header.id, action: 'captured', diff: { reportId: rid, definitionRevision: current.revision, taskCount: header.taskCount }, outbox: { type: 'generic_report_snapshot.captured', payload: { reportId: rid, snapshotId: header.id } } }); return header;
      });
    },
    listSnapshots(ctx, reportId) { const rid = id(reportId); return deps.read(normalize(ctx), 'reports.read', async scope => { await report(scope, rid); return scope.reports.listSnapshots(rid); }); },
    getSnapshot(ctx, reportId, snapshotId) { const rid = id(reportId), sid = id(snapshotId); return deps.read(normalize(ctx), 'reports.read', async scope => { const current = await report(scope, rid), value = found(await scope.reports.findSnapshot(rid, sid)); if (value.header.projectId !== current.projectId || value.header.workspaceId !== scope.context.workspaceId) throw notFoundError(); return value.header; }); },
    headerWidgets(ctx, projectId, input) { const pid=id(projectId),parsed=parse(C.queryGenericHeaderWidgetsInputSchema,input);return deps.read(normalize(ctx),'reports.read',async scope=>{await project(scope,pid);return queryHeaderWidgets(scope,pid,parsed,deps.digest);}); },
    getSettings(ctx, projectId) { const pid = id(projectId); return deps.read(normalize(ctx), 'reports.read', async scope => { await project(scope, pid); return scope.reports.settings(pid); }); },
    setSettings(ctx, projectId, input) {
      const pid = id(projectId), parsed = parse(C.setGenericAggregateSettingsInputSchema, input);
      return mutate(ctx, 'generic_report.settings', pid, parsed, C.genericAggregateSettingsSchema, async scope => {
        await project(scope, pid, true); const current = await scope.reports.settings(pid); revision(current.revision, parsed.expectedRevision);
        if (parsed.measures.length) validateGenericConfig({ projectId: pid, hierarchy: 'all_tasks', measures: parsed.measures, comparison: null, groupBy: { kind: 'none' }, filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null } }, await scope.repository.listFields(scope.context.workspaceId, pid));
        if(parsed.headerWidgets!==undefined)await validateHeaderWidgets(scope,pid,parsed.headerWidgets,await scope.repository.listFields(scope.context.workspaceId,pid));
        const next = { ...current, revision: current.revision + 1, measures: parsed.measures,...(parsed.headerWidgets===undefined?{}:{headerWidgets:parsed.headerWidgets}) }; await scope.reports.saveSettings(next);
        await scope.recordChange({ entityType: 'generic_report_columns', entityId: pid, action: 'updated', entityRevision: next.revision, diff: { projectId: pid, revision: next.revision }, outbox: { type: 'generic_report_columns.updated', payload: { projectId: pid, revision: next.revision } } }); return next;
      });
    },
    template(ctx, projectId, input) {
      const pid = id(projectId), parsed = parse(C.planFactTemplateInputSchema, input);
      return mutate(ctx, 'generic_report.template', pid, parsed, C.planFactTemplateResultSchema, async scope => {
        await project(scope, pid, true); const columns = await scope.repository.findProjectColumns(scope.context.workspaceId, pid);
        revision(columns?.revision ?? 1, parsed.expectedColumnsRevision);
        const fieldInput = (name: string) => C.createTaskFieldInputSchema.parse({ projectId: pid, name, type: 'duration', historyEnabled: true, locked: false, options: [] });
        const inputs = [fieldInput(parsed.planName), fieldInput(parsed.factName)] as const;
        for (const value of inputs) { const blocked = await scope.planningGuard.check({ family: 'field', command: 'field.create', target: null, input: value }); if (blocked) return blocked; }
        const plan = await createTaskFieldInScope(scope, inputs[0], deps), fact = await createTaskFieldInScope(scope, inputs[1], deps);
        const config: C.GenericReportConfig = { projectId: pid, hierarchy: 'all_tasks', measures: [{ key: 'plan', operation: 'sum', fieldId: plan.id }, { key: 'fact', operation: 'sum', fieldId: fact.id }], comparison: { planFieldId: plan.id, factFieldId: fact.id, completion: 'done_only' }, groupBy: { kind: 'assignee' }, filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null } };
        const created = await create(scope, { name: parsed.reportName, config });
        return { fields: [plan, fact] as [C.TaskFieldDefinitionDto, C.TaskFieldDefinitionDto], columns: found(await scope.repository.findProjectColumns(scope.context.workspaceId, pid)), report: created };
      });
    },
  };
}
