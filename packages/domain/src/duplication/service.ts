import {resolveSummaryTemplate,summaryBindingTaskScope} from '../summary-templates/resolution.js';
import * as C from '@workloom/contracts';
import type { AttachmentRecord } from '../attachments/ports.js';
import { roleHasCapability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { capabilityRequiredError, DomainError, notFoundError, unauthenticatedError } from '../errors.js';
import { setTaskFieldValueInScope } from '../fields/service.js';
import { validateHeaderWidgets } from '../generic-reports/header-widgets.js';
import { validatePlanningCheckConfigInScope } from '../planning-checks/service.js';
import { createPlanningMutationGuard, isCommittedPlanningRejection, unwrapPlanningOutcome } from '../planning/freeze.js';
import type { CommittedPlanningRejection } from '../planning/ports.js';
import { canonicalJson, createSectionInScope, createTaskInScope } from '../tasks/service.js';
import type { DuplicationApplication, DuplicationDependencies, DuplicationScope, PreparedAttachmentCopy } from './ports.js';

type Kind = 'task' | 'section';
type Input = C.DuplicateTaskPreviewInput | C.DuplicateSectionPreviewInput;
interface Source {
  kind: Kind; id: string; project: C.ProjectDto; sourceTask: C.TaskDto | null; sourceSection: C.SectionDto | null;
  rows: C.TaskDto[]; allRows: C.TaskDto[]; sections: C.SectionDto[]; fields: C.TaskFieldDefinitionDto[];
  attachments: AttachmentRecord[];
  values: C.TaskFieldValueDto[]; status: C.TaskStatusDto | null;
  aggregates: C.GenericAggregateSettingsDto | null; checks: C.PlanningCheckSettingsDto | null;
  preview: C.DuplicationPreviewDto;
}
const MAX_POSITION = 2_147_483_647;
const found = <T>(value: T | null): T => { if (value === null) throw notFoundError(); return value; };
function invalid(reason: string): never { throw new DomainError('DOMAIN_VALIDATION_FAILED', 'This selection cannot be duplicated.', { details: { duplicationReason: reason } }); }
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'The duplication input is invalid.'); return parsed.data;
}
function normalize(ctx: CommandContext): CommandContext {
  if (!ctx.actor || !C.idSchema.safeParse(ctx.actor.userId).success) throw unauthenticatedError();
  return { ...ctx, workspaceId: parse(C.idSchema, ctx.workspaceId), actor: { ...ctx.actor, userId: parse(C.idSchema, ctx.actor.userId) } };
}
function settingsRequested(kind: Kind, input: Input): boolean { return kind === 'section' && 'includeSettings' in input && input.includeSettings; }
function ordinary(task: C.TaskDto): void { if (task.meetingId !== null || task.visibility !== 'workspace') invalid('meeting_or_unknown_task_type'); if (task.archivedAt !== null) invalid('archived_task'); }
const ordered = (rows: readonly C.TaskDto[]) => [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
/** Complete active subtrees from a server read, independent of the visible table page. */
export function selectDuplicationTree(rows: readonly C.TaskDto[], roots: readonly C.TaskDto[], includeChildren: boolean): C.TaskDto[] {
  const result: C.TaskDto[] = [], seen = new Set<string>(), visiting = new Set<string>();
  const children = new Map<string, C.TaskDto[]>();
  for (const row of rows) if (row.archivedAt === null && row.parentTaskId !== null) children.set(row.parentTaskId, [...(children.get(row.parentTaskId) ?? []), row]);
  function visit(row: C.TaskDto) {
    if (visiting.has(row.id)) invalid('invalid_task_tree'); if (seen.has(row.id)) return;
    ordinary(row); visiting.add(row.id); seen.add(row.id); result.push(row);
    if (result.length > C.DUPLICATION_LIMITS.maxTasks) invalid('too_many_tasks');
    if (includeChildren) for (const child of ordered(children.get(row.id) ?? [])) visit(child);
    visiting.delete(row.id);
  }
  for (const root of ordered(roots)) visit(root);
  return result;
}
export function createDuplicationApplication(deps: DuplicationDependencies): DuplicationApplication {
  async function authorizeTarget(scope: DuplicationScope, kind: Kind, id: string, input: Input) {
    const repo = scope.repository.tasks, ws = scope.context.workspaceId;
    const sourceTask = kind === 'task' ? found(await repo.findTask(ws, id)) : null;
    const sourceSection = kind === 'section' ? found(await repo.findSection(ws, id)) : null;
    const project = found(await repo.findProject(ws, found(sourceTask ?? sourceSection).projectId));
    if (kind === 'task' && (!('projectId' in input) || input.projectId !== project.id)) invalid('linked_task');
    if (settingsRequested(kind, input) && !roleHasCapability(scope.access.membership.role, 'fields.manage')) throw capabilityRequiredError();
    return { project, sourceTask, sourceSection };
  }
  async function source(scope: DuplicationScope, kind: Kind, id: string, input: Input): Promise<Source> {
    const { project, sourceTask, sourceSection } = await authorizeTarget(scope, kind, id, input);
    if (project.archivedAt !== null || (sourceSection !== null && sourceSection.archivedAt !== null)) invalid('archived_source');
    if (sourceTask) {
      ordinary(sourceTask);
      if (sourceTask.parentTaskId !== null) {
        const parent = found(await scope.repository.tasks.findTask(scope.context.workspaceId, sourceTask.parentTaskId));
        if (parent.meetingId !== null && parent.workPackageId === sourceTask.workPackageId) invalid('meeting_parent_requires_added_scope');
      }
    }
    const repo = scope.repository.tasks, ws = scope.context.workspaceId;
    const allRows = await repo.listTasks(ws, { projectId: project.id, includeArchived: true, limit: 200 }, null, C.DUPLICATION_LIMITS.maxSourceTasks + 1);
    if (allRows.length > C.DUPLICATION_LIMITS.maxSourceTasks) invalid('source_project_too_large');
    const sections = await repo.listSections(ws, project.id);
    let roots: C.TaskDto[];
    if (sourceTask) roots = [sourceTask];
    else {
      const candidates = allRows.filter(row => row.sectionId === id && row.archivedAt === null), ids = new Set(candidates.map(row => row.id));
      roots = candidates.filter(row => row.parentTaskId === null || !ids.has(row.parentTaskId));
      const byId = new Map(candidates.map(row => [row.id, row]));
      // A disconnected cycle must not disappear merely because another valid root exists.
      const complete = new Set<string>();
      for (const candidate of candidates) {
        const path = new Set<string>(); let current: C.TaskDto | undefined = candidate;
        while (current && !complete.has(current.id)) {
          if (path.has(current.id)) invalid('invalid_task_tree'); path.add(current.id);
          current = current.parentTaskId === null ? undefined : byId.get(current.parentTaskId);
        }
        for (const taskId of path) complete.add(taskId);
      }
      if (candidates.length > 0 && roots.length === 0) invalid('invalid_task_tree');
    }
    const includeTasks = !('includeTasks' in input) || input.includeTasks;
    if (includeTasks && sourceSection) {
      const placements = await scope.placements.listProject(ws, project.id, false, null, C.DUPLICATION_LIMITS.maxSourceTasks + 1);
      if (placements.length > C.DUPLICATION_LIMITS.maxSourceTasks) invalid('source_project_too_large');
      if (placements.some(row => row.sectionId === id && row.homeProjectId !== project.id && row.archivedAt === null)) invalid('linked_task');
    }
    const rows = includeTasks ? selectDuplicationTree(allRows, roots, input.copy.subtasks) : [];
    if(rows.length&&(await scope.sharedActivityTaskIds?.(rows.map(r=>r.id))??[]).length)invalid('shared_activity_requires_explicit_copy');
    const attachments = await scope.attachments.listReady(ws, rows.map(row => row.id));
    if (attachments.some(row => row.storageId !== deps.attachmentCopies?.storageId)) invalid('attachment_storage_unavailable');
    const fields = (await scope.repository.fields.listFields(ws, project.id)).filter(field => field.archivedAt === null);
    for (const fieldId of input.copy.customFieldIds) if (!fields.some(field => field.id === fieldId)) invalid('field_unavailable');
    const values = rows.length && input.copy.customFieldIds.length ? (await scope.repository.fields.listProjectValues(ws, project.id, rows.map(row => row.id))).filter(value => input.copy.customFieldIds.includes(value.fieldId)) : [];
    const statuses = await repo.listStatuses(ws, project.id), status = [...statuses].filter(row => row.group === 'todo').sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))[0] ?? null;
    if (rows.length && status === null) invalid('todo_status_missing');
    const carry = settingsRequested(kind, input);
    const aggregates = carry ? await scope.reports.settings(project.id) : null, checks = carry ? await scope.checks.settings(project.id) : null;
    const headerWidgets = aggregates?.headerWidgets?.filter(rule => rule.group.kind === 'section' && rule.group.sectionId === id) ?? [];
    const balanceChecks = checks?.config.rules.filter(rule => rule.kind === 'balance' && rule.group.kind === 'section' && rule.group.sectionId === id) ?? [];
    const activeBindings=carry?(await scope.templates?.bindings(project.id)??[]).filter(b=>!b.detached):[];
    const binding=activeBindings.find(b=>b.group.kind==='section'&&b.group.sectionId===id);
    if(binding&&'templateMode' in input&&input.templateMode==='keep_link'&&activeBindings.length>=100)invalid('template_binding_limit');
    const settings = carry && aggregates && checks ? { aggregateRevision: aggregates.revision, checksRevision: checks.revision, headerWidgets, balanceChecks,...(binding?{templateBinding:binding}:{}) } : null;
    const inputName = 'title' in input ? input.title : input.name;
    // Entire inventory protects hierarchy and insertion order, selected values protect independent revisions.
    // No server clock in this digest: unchanged previews remain usable until a semantic source changes.
    const sourceVersion = deps.digest(canonicalJson({ kind, id, input, project, sourceTask, sourceSection, allRows, sections, fields, values, attachments, statuses, aggregates, checks,...(binding?{binding}:{}), actor: scope.context.actor.userId, epoch: await repo.permissionEpoch(ws) }));
    const preview: C.DuplicationPreviewDto = { kind, sourceId: id, projectId: project.id, sourceVersion, name: inputName, taskCount: rows.length, attachmentCount: attachments.length, customValueCount: values.length, copyableFields: fields, settings };
    return { kind, id, project, sourceTask, sourceSection, rows, allRows, sections, fields, values, attachments, status, aggregates, checks, preview };
  }
  async function preview(ctx: CommandContext, kind: Kind, id: string, input: Input) {
    return deps.read(normalize(ctx), 'task.edit', async scope => (await source(scope, kind, id, input)).preview);
  }
  async function duplicate(ctx: CommandContext, kind: Kind, id: string, input: Input, expectedSourceVersion: string): Promise<C.DuplicationResultDto> {
    const context = normalize(ctx), key = context.idempotencyKey, command = kind === 'task' ? 'task.duplicate' as const : 'section.duplicate' as const;
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
    const payloadHash = deps.digest(canonicalJson({ command, id, input, expectedSourceVersion }));
    // Authorize and replay before external work; never hold a workspace lock during an S3 copy.
    const preparedSource = await deps.read(context, 'task.edit', async scope => {
      await authorizeTarget(scope, kind, id, input);
      const previous = await scope.repository.tasks.findIdempotency(context.workspaceId, context.actor.userId, command, key);
      if (previous) {
        if (previous.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key was used for another duplication.');
        return { result: isCommittedPlanningRejection(previous.result) ? previous.result : parse(C.duplicationResultSchema, previous.result) };
      }
      const selected = await source(scope, kind, id, input);
      if (selected.preview.sourceVersion !== expectedSourceVersion) throw new DomainError('PREVIEW_STALE', 'Review the changed duplication preview.');
      return { selected };
    });
    if (preparedSource.result) return unwrapPlanningOutcome(preparedSource.result);
    const prepared = preparedSource.selected.attachments.length
      ? await found(deps.attachmentCopies ?? null).prepare(context, preparedSource.selected.attachments) : [];
    return unwrapPlanningOutcome(await deps.write(context, 'task.edit', async (scope): Promise<C.DuplicationResultDto | CommittedPlanningRejection> => {
      await authorizeTarget(scope, kind, id, input);
      const repo = scope.repository.tasks, ws = context.workspaceId, previous = await repo.findIdempotency(ws, context.actor.userId, command, key);
      if (previous) { if (previous.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key was used for another duplication.'); return isCommittedPlanningRejection(previous.result) ? previous.result : parse(C.duplicationResultSchema, previous.result); }
      const selected = await source(scope, kind, id, input);
      if(selected.preview.settings?.templateBinding&&'includeSettings' in input&&input.includeSettings&&!input.templateMode)invalid('choose_template_link_mode');
      if (selected.preview.sourceVersion !== expectedSourceVersion) throw new DomainError('PREVIEW_STALE', 'Review the changed duplication preview.');
      const guard = createPlanningMutationGuard(scope, deps);
      let result: C.DuplicationResultDto | CommittedPlanningRejection | null = await guard.check({ family: 'duplication', command, target: { projectId: selected.project.id, sourceId: id }, input, fieldPolicyCandidates: selected.values.map(value => ({ fieldId: value.fieldId, value: value.value, expectedDefinitionRevision: found(selected.fields.find(field => field.id === value.fieldId) ?? null).revision })) });
      // Prerequisite census may have introduced new source tasks; never copy a stale partial tree.
      if (result === null && (await source(scope, kind, id, input)).preview.sourceVersion !== expectedSourceVersion) result = { __workloomPlanningOutcome: 'rejected', code: 'PREVIEW_STALE', details: { committed: true, baselineIds: [] } };
      result ??= await createCopies(scope, selected, input, guard, prepared);
      await repo.insertIdempotency({ workspaceId: ws, actorUserId: context.actor.userId, command, idempotencyKey: key, payloadHash, result, createdAt: scope.barrierAt.toISOString() });
      return result;
    }));
  }
  async function createCopies(scope: DuplicationScope, selected: Source, input: Input, guard: ReturnType<typeof createPlanningMutationGuard>, prepared: readonly PreparedAttachmentCopy[]): Promise<C.DuplicationResultDto> {
    const repo = scope.repository.tasks, projectId = selected.project.id;
    const taskScope = { ...scope, repository: repo, planningGuard: guard };
    let section: C.SectionDto | null = null;
    if (selected.sourceSection && 'name' in input) {
      const sourcePosition = selected.sourceSection.position;
      const shifted = selected.sections.filter(row => row.position > sourcePosition);
      if (sourcePosition >= MAX_POSITION || shifted.some(row => row.position >= MAX_POSITION)) invalid('section_order_full');
      for (const row of [...shifted].sort((a, b) => b.position - a.position || b.id.localeCompare(a.id))) {
        const next = { ...row, position: row.position + 1, revision: row.revision + 1 };
        await repo.saveSection(next);
        await scope.recordChange({ entityType: 'section', entityId: row.id, action: 'updated', entityRevision: next.revision, diff: { position: next.position }, outbox: { type: 'section.updated', payload: { projectId, sectionId: row.id, revision: next.revision } } });
      }
      section = await createSectionInScope(taskScope, projectId, { name: input.name, position: sourcePosition + 1 }, deps);
    }
    const mapping = new Map<string, C.TaskDto>();
    for (const row of selected.rows) {
      const oldParent = row.parentTaskId === null ? null : selected.allRows.find(parent => parent.id === row.parentTaskId) ?? null;
      const copiedParent = row.parentTaskId === null ? null : mapping.get(row.parentTaskId) ?? null;
      const root = selected.sourceTask?.id === row.id;
      const parentTaskId = copiedParent?.id ?? (root ? row.parentTaskId : null);
      const separatePackage = oldParent !== null && oldParent.workPackageId !== row.workPackageId;
      const fields = selected.values.filter(value => value.taskId === row.id);
      const created = await createTaskInScope(taskScope, {
        // Copies are new work: use the project's first To do status for every copied task.
        projectId, title: root && 'title' in input ? input.title : row.title, statusId: found(selected.status).id,
        sectionId: section?.id ?? row.sectionId, parentTaskId,
        ...(parentTaskId !== null && separatePackage ? { workScope: 'added_scope' as const } : {}),
        description: input.copy.description ? row.description : '', responsibleMembershipId: input.copy.assignee ? row.responsibleMembershipId : null,
        participantMembershipIds: input.copy.participants ? row.participants.filter(member => member.active).map(member => member.membershipId) : [],
        startDate: input.copy.dates ? row.startDate ?? null : null, dueDate: input.copy.dates ? row.dueDate : null,
        priority: input.copy.priority ? row.priority : 'none', tagIds: input.copy.tags ? row.tags.map(tag => tag.id) : [],
        ...(root ? { insertion: { anchorTaskId: row.id, placement: 'after' as const } } : {}),
      }, deps, fields.map(value => ({ fieldId: value.fieldId, value: value.value })));
      mapping.set(row.id, created);
      for (const value of fields) await setTaskFieldValueInScope({ ...scope, repository: scope.repository.fields, planningGuard: guard }, created.id, value.fieldId, { expectedRevision: 0, expectedDefinitionRevision: found(selected.fields.find(field => field.id === value.fieldId) ?? null).revision, value: value.value }, deps);
    }
    for (const attachment of selected.attachments) {
      const staged = found(prepared.find(copy => copy.sourceId === attachment.id) ?? null);
      const taskId = found(mapping.get(attachment.taskId) ?? null).id;
      const rejection = await guard.check({ family: 'attachment', command: 'attachment.copy', target: { taskId }, input: { sourceAttachmentId: attachment.id } });
      if (rejection) throw new Error('Attachment metadata guard unexpectedly rejected a copy.');
      const row = { ...staged.row, taskId };
      await scope.attachments.adopt(row);
      await scope.recordChange({ entityType: 'task_attachment', entityId: row.id, entityRevision: row.revision,
        action: 'created', diff: { taskId }, outbox: { type: 'attachment.created', payload: { taskId, attachmentId: row.id } } });
    }
    if (section && selected.preview.settings && selected.aggregates && selected.checks) {
      const fieldsScope = { ...scope, repository: scope.repository.fields, planningGuard: guard };
      let linked:C.SummaryTemplateBindingDto|undefined;
      const sourceBinding=selected.preview.settings.templateBinding;
      if(sourceBinding&&'templateMode' in input&&input.templateMode==='keep_link'){
       if(!scope.templates)throw Error('Missing summary template repository.');const template=found((await scope.templates.list(projectId)).find(t=>t.id===sourceBinding.templateId)??null),parameters={group:{kind:'section' as const,sectionId:section.id},person:input.templatePerson===undefined?sourceBinding.person:input.templatePerson,overrides:sourceBinding.overrides,ruleIds:{}};
       linked={...sourceBinding,id:deps.newId(),group:parameters.group,person:parameters.person,revision:1,detached:false,...resolveSummaryTemplate(template,parameters,deps.newId)};
       const reject=await guard.check({family:'summary_template',command:'summary_template.bind',target:{kind:'project',id:projectId},input:{expectedSourceVersion:selected.preview.sourceVersion,group:linked.group,person:linked.person,templateId:template.id,expectedTemplateRevision:template.revision,overrides:linked.overrides}});if(reject)throw Error('Metadata summary guard unexpectedly rejected a copied binding.');
      }
      const linkedTemplateId=linked?.templateId;const template=linked?found((await found(scope.templates??null).list(projectId)).find(t=>t.id===linkedTemplateId)??null):null;
      const widgets = [...(selected.aggregates.headerWidgets ?? []), ...(linked&&template?[{group:linked.group,widgets:linked.resolved.widgets,...(summaryBindingTaskScope(template,linked)?{taskScope:summaryBindingTaskScope(template,linked)}:{})}]:selected.preview.settings.headerWidgets.map(rule => ({ ...rule, group: { kind: 'section' as const, sectionId: section.id }, widgets: rule.widgets.map(widget => { const key = `copy_${deps.newId().replaceAll('-', '')}`; return { ...widget, key, ...(widget.kind === 'measure' ? { measure: { ...widget.measure, key } } : {}) }; }) })))];
      const aggregate = parse(C.genericAggregateSettingsSchema, { ...selected.aggregates, revision: selected.aggregates.revision + 1, headerWidgets: widgets });
      const rules = [...selected.checks.config.rules, ...(linked?linked.resolved.balanceChecks:selected.preview.settings.balanceChecks.map(rule => rule.kind === 'balance' ? { ...rule, id: deps.newId(), group: { kind: 'section' as const, sectionId: section.id } } : rule))];
      const checks = parse(C.planningCheckSettingsSchema, { ...selected.checks, revision: selected.checks.revision + 1, config: { ...selected.checks.config, rules } });
      if(linked)await found(scope.templates??null).saveBinding(linked,scope.context.actor.userId,scope.barrierAt.toISOString());
      if(linked)await scope.recordChange({entityType:'summary_template',entityId:linked.id,entityRevision:linked.revision,action:'bound',diff:{projectId,revision:linked.revision},outbox:{type:'summary_template.updated',payload:{projectId,revision:linked.revision}}});
      if (selected.preview.settings.headerWidgets.length) await validateHeaderWidgets(fieldsScope, projectId, widgets, selected.fields);
      if (selected.preview.settings.balanceChecks.length) await validatePlanningCheckConfigInScope(fieldsScope, projectId, checks.config);
      if (selected.preview.settings.headerWidgets.length) { await scope.reports.saveSettings(aggregate); await scope.recordChange({ entityType: 'generic_report_columns', entityId: projectId, action: 'updated', entityRevision: aggregate.revision, diff: { projectId, revision: aggregate.revision }, outbox: { type: 'generic_report_columns.updated', payload: { projectId, revision: aggregate.revision } } }); }
      if (selected.preview.settings.balanceChecks.length) { await scope.checks.saveSettings(checks, scope.context.actor.userId, scope.barrierAt.toISOString()); await scope.recordChange({ entityType: 'planning_check', entityId: projectId, action: 'settings_updated', entityRevision: checks.revision, diff: { projectId, revision: checks.revision }, outbox: { type: 'planning_check.settings_updated', payload: { projectId, revision: checks.revision } } }); }
    }
    return { kind: selected.kind, projectId, rootTaskId: selected.sourceTask ? mapping.get(selected.sourceTask.id)?.id ?? null : null, section, taskIds: [...mapping.values()].map(task => task.id) };
  }
  return {
    previewTask: (ctx, id, input) => preview(ctx, 'task', parse(C.idSchema, id), parse(C.duplicateTaskPreviewInputSchema, input)),
    previewSection: (ctx, id, input) => preview(ctx, 'section', parse(C.idSchema, id), parse(C.duplicateSectionPreviewInputSchema, input)),
    duplicateTask: (ctx, id, input) => { const { expectedSourceVersion, ...rest } = parse(C.duplicateTaskInputSchema, input); return duplicate(ctx, 'task', parse(C.idSchema, id), rest, expectedSourceVersion); },
    duplicateSection: (ctx, id, input) => { const { expectedSourceVersion, ...rest } = parse(C.duplicateSectionInputSchema, input); return duplicate(ctx, 'section', parse(C.idSchema, id), rest, expectedSourceVersion); },
  };
}
