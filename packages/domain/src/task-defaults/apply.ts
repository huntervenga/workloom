import type { CreateTaskInput, TaskFieldData } from '@workloom/contracts';
import type { TaskFieldRepository } from '../fields/ports.js';
import { requireAssignableReferences } from '../fields/service.js';
import type { TaskRepository } from '../tasks/ports.js';

export interface DefaultFieldValue {
  readonly fieldId: string;
  readonly expectedDefinitionRevision: number;
  readonly value: TaskFieldData;
}

/**
 * Fills in what the caller left out. Nothing is overridden: an explicit priority, estimate or field value always wins,
 * and a default that no longer fits (archived or locked field, removed option, former member) is skipped, never an error.
 */
export async function resolveTaskDefaults(
  repository: TaskRepository,
  fields: TaskFieldRepository | undefined,
  workspaceId: string,
  input: CreateTaskInput,
  suppliedFieldIds: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<{ input: CreateTaskInput; fields: DefaultFieldValue[] }> {
  const defaults = await repository.findTaskDefaults?.(workspaceId, input.projectId);
  if (!defaults || defaults.revision === 0) return { input, fields: [] };
  const config = defaults.config;
  const next: CreateTaskInput = { ...input };
  const wantsAbove = config.assignee?.kind === 'above' || config.tags?.kind === 'above' || config.dueDate?.kind === 'above'
    || config.fromAbove?.priority === true || config.fromAbove?.estimate === true || (config.fromAbove?.fieldIds.length ?? 0) > 0;
  const above = wantsAbove && repository.findTaskAbove
    ? await repository.findTaskAbove(workspaceId, { projectId: input.projectId, sectionId: input.sectionId ?? null, parentTaskId: input.parentTaskId ?? null, ...(input.insertion ? { insertion: input.insertion } : {}) })
    : null;
  // Whoever is named must still be an active member; a stale choice is skipped like any other stale default.
  const activeMembers = (config.assignee?.kind === 'fixed' || (config.assignee?.kind === 'above' && above?.responsibleMembershipId))
    ? new Set((await repository.access.listActiveMemberships(workspaceId)).filter(member => member.state === 'active').map(member => member.id.toLowerCase())) : null;
  if (next.responsibleMembershipId === undefined && config.assignee) {
    const wanted = config.assignee.kind === 'fixed' ? config.assignee.membershipId : config.assignee.kind === 'above' ? above?.responsibleMembershipId ?? null : null;
    if (wanted && activeMembers?.has(wanted.toLowerCase())) next.responsibleMembershipId = wanted;
  }
  if (next.tagIds === undefined && config.tags && config.tags.kind !== 'none') {
    const wanted = config.tags.kind === 'fixed' ? config.tags.tagIds : (above?.tags ?? []).map(tag => tag.id);
    const usable: string[] = [];
    for (const id of wanted) { const tag = await repository.findTag(workspaceId, id); if (tag && tag.archivedAt === null) usable.push(tag.id); }
    if (usable.length > 0) next.tagIds = usable;
  }
  if (next.dueDate === undefined && config.dueDate && config.dueDate.kind !== 'none') {
    const date = config.dueDate.kind === 'today' ? await todayIn(repository, workspaceId, now, config.dueDate.offsetDays) : above?.dueDate ?? null;
    if (date) next.dueDate = date;
  }
  if (next.priority === undefined && config.fromAbove?.priority && above) next.priority = above.priority;
  if (next.priority === undefined && config.priority !== null) next.priority = config.priority;
  // A detail subtask shares its parent's package, so a team estimate default only fits top-level tasks and added scope.
  const ownsPackage = !input.parentTaskId || input.workScope === 'added_scope';
  if (next.estimateMinutes === undefined && config.fromAbove?.estimate && above?.estimateMinutes !== undefined && above.estimateMinutes !== null && ownsPackage) next.estimateMinutes = above.estimateMinutes;
  if (next.estimateMinutes === undefined && config.estimateMinutes !== null && ownsPackage) next.estimateMinutes = config.estimateMinutes;
  const values: DefaultFieldValue[] = [];
  if (fields) {
    const supplied = new Set([...suppliedFieldIds].map(id => id.toLowerCase()));
    // Candidates in order of preference: the task above, then today, then the fixed default; the first usable one wins.
    const candidates: { fieldId: string; value: TaskFieldData }[] = [];
    if (above) for (const fieldId of config.fromAbove?.fieldIds ?? []) {
      const found = await fields.findValue(workspaceId, above.id, fieldId);
      if (found && found.value.value !== null) candidates.push({ fieldId, value: found.value });
    }
    for (const item of config.todayFields ?? []) candidates.push({ fieldId: item.fieldId, value: { type: 'date', value: await todayIn(repository, workspaceId, now, item.offsetDays) } });
    for (const item of config.fieldValues) candidates.push({ fieldId: item.fieldId, value: item.value });
    const done = new Set<string>();
    for (const item of candidates) {
      if (supplied.has(item.fieldId.toLowerCase()) || done.has(item.fieldId.toLowerCase())) continue;
      const field = await fields.findField(workspaceId, item.fieldId);
      if (!field || field.projectId.toLowerCase() !== input.projectId.toLowerCase() || field.archivedAt !== null || field.locked || field.type !== item.value.type) continue;
      try { await requireAssignableReferences(fields, workspaceId, field, item.value, null); } catch { continue; }
      done.add(item.fieldId.toLowerCase());
      values.push({ fieldId: field.id, expectedDefinitionRevision: field.revision, value: item.value });
    }
  }
  return { input: next, fields: values };
}

/** Today in the workspace time zone (UTC when it is unknown), moved forward by `offsetDays`. */
async function todayIn(repository: TaskRepository, workspaceId: string, now: Date, offsetDays: number): Promise<string> {
  const zone = (await repository.findWorkspaceTimezone?.(workspaceId)) ?? 'UTC';
  let today: string;
  try { today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
  catch { today = now.toISOString().slice(0, 10); }
  const moved = new Date(`${today}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + offsetDays);
  return moved.toISOString().slice(0, 10);
}
