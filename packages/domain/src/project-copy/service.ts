import * as C from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import type { WorkCategoryApplication } from '../categories/application.js';
import { DomainError } from '../errors.js';
import type { TaskFieldApplication } from '../fields/application.js';
import type { GenericReportApplication } from '../generic-reports/service.js';
import type { PlanningCheckApplication } from '../planning-checks/ports.js';
import type { TaskApplication } from '../tasks/application.js';
import type { TaskDefaultsApplication } from '../task-defaults/service.js';
import type { ProjectRulesApplication } from '../project-rules/service.js';
import { derivedId, remapSettings, shiftDate } from './mapping.js';

export interface ProjectCopyApplication {
  duplicateProject(context: CommandContext, sourceProjectId: string, input: C.DuplicateProjectInput): Promise<C.DuplicateProjectResult>;
  /** Copies one project's sums, checks and new-task defaults onto existing projects, matching fields and sections by name. */
  applySettings(context: CommandContext, sourceProjectId: string, input: C.ApplyProjectSettingsInput): Promise<C.ApplyProjectSettingsResult>;
}
export interface ProjectCopyDependencies {
  readonly tasks: TaskApplication;
  readonly fields: TaskFieldApplication;
  readonly checks: PlanningCheckApplication;
  readonly reports: GenericReportApplication;
  readonly defaults: TaskDefaultsApplication;
  /** Optional so older compositions keep working; rules travel with the defaults. */
  readonly rules?: ProjectRulesApplication;
  readonly categories: WorkCategoryApplication;
  digest(value: string): string;
}

const norm = (text: string) => text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Builds the copy from the same public commands the interface uses, so every rule and permission applies unchanged. Each
 * step gets its own idempotency key derived from the caller's key and every new id is derived too: after a failure the
 * same request, with the same key, resumes where it stopped instead of creating a second project.
 */
export function createProjectCopyService(deps: ProjectCopyDependencies): ProjectCopyApplication {
  return {
    async duplicateProject(context, sourceProjectId, rawInput) {
      const parsed = C.duplicateProjectInputSchema.safeParse(rawInput);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid project copy input.');
      const input = parsed.data;
      const base = context.idempotencyKey;
      if (!base || !/^[\x21-\x7e]{1,128}$/.test(base)) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
      const sourceId = C.idSchema.parse(sourceProjectId);
      const step = (name: string): CommandContext => ({ ...context, idempotencyKey: deps.digest(`${base}\u0000${name}`).slice(0, 64) });
      const warnings: C.DuplicateProjectResult['warnings'] = [];
      const ids = new Map<string, string>();
      const link = (from: string, to: string) => ids.set(from.toLowerCase(), to);

      const source = await deps.tasks.getProject(context, sourceId);
      const [sourceSections, sourceFields, sourceColumns, sourceStatuses] = await Promise.all([
        deps.tasks.listSections(context, sourceId), deps.fields.listFields(context, sourceId), deps.fields.getProjectColumns(context, sourceId), deps.tasks.listStatuses(context, sourceId),
      ]);

      // Core structure: any failure here stops the copy.
      const created = await deps.tasks.createProject(step('project'), { name: input.name });
      link(sourceId, created.id);
      const range = source.dateRange ?? null;
      if (range) {
        await deps.tasks.updateProject(step('dates'), created.id, { expectedRevision: created.revision, dateRange: { from: shiftDate(range.from, input.shiftDays), to: shiftDate(range.to, input.shiftDays) } });
      }

      const sections = sourceSections.filter(section => section.archivedAt === null).sort((a, b) => a.position - b.position);
      for (const section of sections) {
        const copy = await deps.tasks.createSection(step(`section:${section.id}`), created.id, { name: section.name });
        link(section.id, copy.id);
      }
      const newStatuses = await deps.tasks.listStatuses(context, created.id);
      for (const status of sourceStatuses) {
        const match = newStatuses.find(candidate => norm(candidate.name) === norm(status.name) && candidate.group === status.group);
        if (match) link(status.id, match.id);
      }

      const fields = sourceFields.filter(field => field.archivedAt === null);
      for (const field of fields) {
        const activeOptions = [...field.options].filter(option => option.archivedAt === null).sort((a, b) => a.position - b.position);
        const copy = await deps.fields.createField(step(`field:${field.id}`), {
          projectId: created.id, name: field.name, type: field.type, historyEnabled: field.historyEnabled, locked: field.locked,
          options: activeOptions.map(option => ({ name: option.name, color: option.color })),
        });
        link(field.id, copy.id);
        const copied = [...copy.options].sort((a, b) => a.position - b.position);
        activeOptions.forEach((option, optionIndex) => { const target = copied[optionIndex]; if (target) link(option.id, target.id); });
      }

      // Column revisions move with every field created, so a resumed copy compares the layout instead of guessing a revision.
      const currentColumns = await deps.fields.getProjectColumns(context, created.id);
      const columns = sourceColumns.columns.flatMap(column => { const fieldId = ids.get(column.fieldId.toLowerCase()); return fieldId ? [{ ...column, fieldId }] : []; });
      const layout = (list: readonly { fieldId: string; visible: boolean; width: number; position: number }[]) => JSON.stringify([...list].sort((a, b) => a.fieldId.localeCompare(b.fieldId)).map(({ fieldId, visible, width, position }) => [fieldId, visible, width, position]));
      if (columns.length > 0 && layout(columns) !== layout(currentColumns.columns)) await deps.fields.updateProjectColumns(step('columns'), created.id, { expectedRevision: currentColumns.revision, columns });

      const clone = input.copy.tasks ? await copyTasks(deps, context, step, sourceId, created.id, ids, input.shiftDays) : null;

      // Optional settings: a failure is reported, and the project stays complete without that part.
      const optional = async (part: C.DuplicateProjectResult['warnings'][number]['part'], work: () => Promise<void>) => {
        try { await work(); } catch (error) {
          warnings.push({ part, message: error instanceof DomainError ? error.message : 'This part could not be copied.' });
        }
      };
      const result: C.DuplicateProjectResult = { projectId: created.id, name: created.name, copied: { sections: sections.length, fields: fields.length, aggregates: false, checkRules: 0, defaults: false, reports: 0, workCategory: false, ...(clone ? { tasks: clone.tasks } : {}) }, warnings };
      if (clone?.skippedLockedFields.length) warnings.push({ part: 'tasks', message: `Values of locked fields were not copied: ${clone.skippedLockedFields.join(', ')}.` });

      if (input.copy.aggregates) await optional('aggregates', async () => {
        const settings = await deps.reports.getSettings(context, sourceId);
        if (settings.measures.length === 0 && !(settings.headerWidgets?.length)) return;
        const mapped = remapSettings({ measures: settings.measures, headerWidgets: settings.headerWidgets }, ids, input.shiftDays);
        await deps.reports.setSettings(step('aggregates'), created.id, { expectedRevision: 0, measures: mapped.measures, ...(mapped.headerWidgets ? { headerWidgets: mapped.headerWidgets } : {}) });
        result.copied.aggregates = true;
      });

      if (input.copy.checks) await optional('checks', async () => {
        const settings = await deps.checks.getSettings(context, sourceId);
        if (settings.config.rules.length === 0) return;
        const ruleIds = new Map(ids);
        for (const rule of settings.config.rules) ruleIds.set(rule.id.toLowerCase(), derivedId(deps.digest, `${base}:rule`, rule.id));
        await deps.checks.setSettings(step('checks'), created.id, { expectedRevision: 0, config: remapSettings(settings.config, ruleIds, input.shiftDays) });
        result.copied.checkRules = settings.config.rules.length;
      });

      if (input.copy.defaults) await optional('defaults', async () => {
        const settings = await deps.defaults.getDefaults(context, sourceId);
        if (settings.revision === 0) return;
        await deps.defaults.setDefaults(step('defaults'), created.id, { expectedRevision: 0, config: remapSettings(settings.config, ids, input.shiftDays) });
        result.copied.defaults = true;
      });
      const rulesApplication = deps.rules;
      if (input.copy.defaults && rulesApplication) await optional('defaults', async () => {
        const rules = await rulesApplication.getRules(context, sourceId);
        if (rules.revision === 0) return;
        await rulesApplication.setRules(step('rules'), created.id, { expectedRevision: 0, config: rules.config });
      });

      if (input.copy.workCategory) await optional('workCategory', async () => {
        const binding = await deps.categories.getBinding(context, sourceId);
        const fieldId = binding.fieldId === null ? undefined : ids.get(binding.fieldId.toLowerCase());
        if (!fieldId) return;
        await deps.categories.updateBinding(step('category'), created.id, { expectedRevision: 0, fieldId });
        result.copied.workCategory = true;
      });

      if (input.copy.reports) await optional('reports', async () => {
        const definitions = (await deps.reports.list(context, sourceId)).filter(report => !report.archivedAt);
        for (const definition of definitions) {
          await deps.reports.create(step(`report:${definition.id}`), { name: definition.name, config: remapSettings(definition.config, ids, input.shiftDays) });
          result.copied.reports += 1;
        }
      });

      return result;
    },

    async applySettings(context, sourceProjectId, rawInput) {
      const parsed = C.applyProjectSettingsInputSchema.safeParse(rawInput);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid settings copy input.');
      const input = parsed.data;
      const base = context.idempotencyKey;
      if (!base || !/^[\x21-\x7e]{1,128}$/.test(base)) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
      const sourceId = C.idSchema.parse(sourceProjectId);
      const step = (name: string): CommandContext => ({ ...context, idempotencyKey: deps.digest(`${base}\u0000${name}`).slice(0, 64) });
      await deps.tasks.getProject(context, sourceId);
      const [sourceSections, sourceFields, sourceStatuses] = await Promise.all([
        deps.tasks.listSections(context, sourceId), deps.fields.listFields(context, sourceId), deps.tasks.listStatuses(context, sourceId),
      ]);
      const sourceAggregates = input.copy.aggregates ? await deps.reports.getSettings(context, sourceId) : null;
      const sourceChecks = input.copy.checks ? await deps.checks.getSettings(context, sourceId) : null;
      const sourceDefaults = input.copy.defaults ? await deps.defaults.getDefaults(context, sourceId) : null;

      const sourceIds = new Set([
        ...sourceSections.map(item => item.id), ...sourceStatuses.map(item => item.id),
        ...sourceFields.flatMap(item => [item.id, ...item.options.map(option => option.id)]),
      ].map(value => value.toLowerCase()));
      const results: C.ApplyProjectSettingsResult['results'] = [];
      for (const targetId of new Set(input.targetProjectIds.map(value => value.toLowerCase()))) {
        const applied = { aggregates: false, checkRules: 0, defaults: false };
        const warnings: C.ApplyProjectSettingsResult['results'][number]['warnings'] = [];
        results.push({ projectId: targetId, applied, warnings });
        if (targetId === sourceId.toLowerCase()) continue;
        const optional = async (part: 'aggregates' | 'checks' | 'defaults', work: () => Promise<void>) => {
          try { await work(); } catch (error) { warnings.push({ part, message: error instanceof DomainError ? error.message : 'This part could not be copied.' }); }
        };
        let ids: Map<string, string>;
        try {
          await deps.tasks.getProject(context, targetId);
          const [targetSections, targetFields, targetStatuses] = await Promise.all([
            deps.tasks.listSections(context, targetId), deps.fields.listFields(context, targetId), deps.tasks.listStatuses(context, targetId),
          ]);
          ids = new Map([[sourceId.toLowerCase(), targetId]]);
          const unique = <T>(list: readonly T[], keyOf: (item: T) => string, wanted: string) => { const hits = list.filter(item => keyOf(item) === wanted); return hits.length === 1 ? hits[0] : undefined; };
          for (const section of sourceSections.filter(item => item.archivedAt === null)) {
            const match = unique(targetSections.filter(item => item.archivedAt === null), item => norm(item.name), norm(section.name));
            if (match) ids.set(section.id.toLowerCase(), match.id);
          }
          for (const status of sourceStatuses) {
            const match = unique(targetStatuses, item => `${item.group}:${norm(item.name)}`, `${status.group}:${norm(status.name)}`);
            if (match) ids.set(status.id.toLowerCase(), match.id);
          }
          for (const field of sourceFields.filter(item => item.archivedAt === null)) {
            const match = unique(targetFields.filter(item => item.archivedAt === null), item => `${item.type}:${norm(item.name)}`, `${field.type}:${norm(field.name)}`);
            if (!match) continue;
            ids.set(field.id.toLowerCase(), match.id);
            for (const option of field.options.filter(item => item.archivedAt === null)) {
              const optionMatch = unique(match.options.filter(item => item.archivedAt === null), item => norm(item.name), norm(option.name));
              if (optionMatch) ids.set(option.id.toLowerCase(), optionMatch.id);
            }
          }
        } catch (error) {
          const message = error instanceof DomainError ? error.message : 'This project could not be read.';
          for (const part of ['aggregates', 'checks', 'defaults'] as const) if (input.copy[part]) warnings.push({ part, message });
          continue;
        }
        // A source id that found no match by name would stay in the copy and point at another project; refuse that.
        const guard = <T>(value: T): T => {
          const text = JSON.stringify(value).toLowerCase();
          if ([...sourceIds].some(found => text.includes(found))) throw new DomainError('VALIDATION_FAILED', 'A field, option or section has no match by name in this project.');
          return value;
        };

        if (sourceAggregates && (sourceAggregates.measures.length > 0 || sourceAggregates.headerWidgets?.length)) await optional('aggregates', async () => {
          const target = await deps.reports.getSettings(context, targetId);
          if ((target.measures.length > 0 || target.headerWidgets?.length) && !input.replaceExisting) throw new DomainError('VALIDATION_FAILED', 'Sums are already set up in this project.');
          const mapped = guard(remapSettings({ measures: sourceAggregates.measures, headerWidgets: sourceAggregates.headerWidgets }, ids, 0));
          await deps.reports.setSettings(step(`${targetId}:aggregates:${target.revision}`), targetId, { expectedRevision: target.revision, measures: mapped.measures, ...(mapped.headerWidgets ? { headerWidgets: mapped.headerWidgets } : {}) });
          applied.aggregates = true;
        });

        if (sourceChecks && sourceChecks.config.rules.length > 0) await optional('checks', async () => {
          const target = await deps.checks.getSettings(context, targetId);
          if (target.config.rules.length > 0 && !input.replaceExisting) throw new DomainError('VALIDATION_FAILED', 'Planning checks are already set up in this project.');
          const ruleIds = new Map(ids);
          for (const rule of sourceChecks.config.rules) ruleIds.set(rule.id.toLowerCase(), derivedId(deps.digest, `${base}:${targetId}:rule`, rule.id));
          await deps.checks.setSettings(step(`${targetId}:checks:${target.revision}`), targetId, { expectedRevision: target.revision, config: guard(remapSettings(sourceChecks.config, ruleIds, 0)) });
          applied.checkRules = sourceChecks.config.rules.length;
        });

        if (sourceDefaults && sourceDefaults.revision > 0) await optional('defaults', async () => {
          const target = await deps.defaults.getDefaults(context, targetId);
          if (target.revision > 0 && !input.replaceExisting) throw new DomainError('VALIDATION_FAILED', 'Defaults for new tasks are already set up in this project.');
          await deps.defaults.setDefaults(step(`${targetId}:defaults:${target.revision}`), targetId, { expectedRevision: target.revision, config: guard(remapSettings(sourceDefaults.config, ids, 0)) });
          applied.defaults = true;
        });
      }
      return { results };
    },
  };
}

/** The source project's own active tasks, parents before their subtasks, each level in project order. */
async function cloneOrder(deps: ProjectCopyDependencies, context: CommandContext, sourceId: string): Promise<C.TaskDto[]> {
  const rows: C.TaskDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.tasks.listTasks(context, { projectId: sourceId, limit: 200, ...(cursor ? { cursor } : {}) });
    rows.push(...page.items);
    if (rows.length > C.PROJECT_COPY_MAX_TASKS) throw new DomainError('VALIDATION_FAILED', `A project with more than ${C.PROJECT_COPY_MAX_TASKS} tasks cannot be copied with its tasks.`);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  // Meeting tasks and tasks shown here from another home project are not this project's work; archived ones are gone.
  const own = rows.filter(row => row.projectId.toLowerCase() === sourceId.toLowerCase() && row.archivedAt === null && !row.meetingId);
  const children = new Map<string | null, C.TaskDto[]>();
  for (const row of own) children.set(row.parentTaskId, [...(children.get(row.parentTaskId) ?? []), row]);
  const ordered: C.TaskDto[] = [];
  const visit = (parentId: string | null) => {
    for (const row of [...(children.get(parentId) ?? [])].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))) { ordered.push(row); visit(row.id); }
  };
  // A subtask whose parent is archived or elsewhere is never reached, as in the interface.
  visit(null);
  return ordered;
}

/**
 * Clones the source project's tasks into the copy with the same commands the interface uses, one derived key per task
 * and per value, so a resumed copy replays them instead of creating them twice. New tasks keep their source position,
 * so the order (sections, subtasks, people) is the same. Values of locked fields cannot be written and are reported.
 */
async function copyTasks(
  deps: ProjectCopyDependencies, context: CommandContext, step: (name: string) => CommandContext,
  sourceId: string, targetId: string, ids: Map<string, string>, shiftDays: number,
): Promise<{ tasks: number; skippedLockedFields: string[] }> {
  const rows = await cloneOrder(deps, context, sourceId);
  const [targetStatuses, targetFields, sourceFields] = await Promise.all([deps.tasks.listStatuses(context, targetId), deps.fields.listFields(context, targetId), deps.fields.listFields(context, sourceId)]);
  const firstTodo = [...targetStatuses].filter(status => status.group === 'todo').sort((a, b) => a.position - b.position)[0];
  const mapped = (id: string | null | undefined) => (id ? ids.get(id.toLowerCase()) ?? null : null);
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const row of rows) {
    const parent = row.parentTaskId === null ? null : byId.get(row.parentTaskId) ?? null;
    const parentTaskId = parent === null ? null : mapped(parent.id);
    // A subtask with its own estimate is a separate work package (added scope); a detail subtask shares its parent's.
    const ownPackage = parent === null || parent.workPackageId !== row.workPackageId;
    const statusId = mapped(row.statusId) ?? firstTodo?.id;
    if (!statusId) throw new DomainError('VALIDATION_FAILED', 'The new project has no To do status.');
    const copy = await deps.tasks.createTask(step(`task:${row.id}`), {
      projectId: targetId, parentTaskId, title: row.title, description: C.remapDescriptionFiles(row.description, new Map()),
      statusId, sectionId: mapped(row.sectionId),
      responsibleMembershipId: row.responsibleMembershipId,
      participantMembershipIds: row.participants.filter(member => member.active).map(member => member.membershipId),
      startDate: row.startDate ? shiftDate(row.startDate, shiftDays) : null, dueDate: row.dueDate ? shiftDate(row.dueDate, shiftDays) : null,
      priority: row.priority, tagIds: row.tags.filter(tag => tag.archivedAt === null).map(tag => tag.id),
      position: row.position,
      ...(ownPackage ? { estimateMinutes: row.estimateMinutes } : {}),
      ...(parent !== null && ownPackage ? { workScope: 'added_scope' as const } : {}),
    });
    ids.set(row.id.toLowerCase(), copy.id);
  }

  const lockedNames = new Set<string>();
  const targetById = new Map(targetFields.map(field => [field.id.toLowerCase(), field]));
  const sourceById = new Map(sourceFields.map(field => [field.id.toLowerCase(), field]));
  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200).map(row => row.id);
    const values = await deps.fields.listProjectValues(context, sourceId, { taskIds: chunk });
    for (const value of [...values].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.fieldId.localeCompare(b.fieldId))) {
      const field = targetById.get(mapped(value.fieldId)?.toLowerCase() ?? '');
      const taskId = mapped(value.taskId);
      if (!field || !taskId || field.archivedAt !== null) continue;
      const data = remapValue(value.value, ids, shiftDays);
      if (data.value === null) continue;
      if (field.locked) { lockedNames.add(sourceById.get(value.fieldId.toLowerCase())?.name ?? field.name); continue; }
      await deps.fields.setTaskValue(step(`value:${value.taskId}:${value.fieldId}`), taskId, field.id, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: data });
    }
  }
  return { tasks: rows.length, skippedLockedFields: [...lockedNames].sort() };
}

/** A field value aimed at the copy: options become the copied options, dates move with the project. */
function remapValue(data: C.TaskFieldValueDto['value'], ids: ReadonlyMap<string, string>, shiftDays: number): C.TaskFieldValueDto['value'] {
  switch (data.type) {
    case 'single_select': return { type: 'single_select', value: data.value === null ? null : ids.get(data.value.toLowerCase()) ?? null };
    case 'multi_select': {
      if (data.value === null) return data;
      const options = data.value.flatMap(option => { const copy = ids.get(option.toLowerCase()); return copy ? [copy] : []; });
      return { type: 'multi_select', value: options.length ? options : null };
    }
    case 'date': return { type: 'date', value: data.value === null ? null : shiftDate(data.value, shiftDays) };
    default: return data;
  }
}
