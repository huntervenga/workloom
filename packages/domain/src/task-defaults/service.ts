import * as C from '@workloom/contracts';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError } from '../errors.js';
import type { TaskFieldWriteScope } from '../fields/ports.js';
import { requireAssignableReferences } from '../fields/service.js';
import { isCommittedPlanningRejection, unwrapPlanningOutcome } from '../planning/freeze.js';
import { canonicalJson } from '../tasks/service.js';

export interface TaskDefaultsRepository {
  /** Revision 0 with the empty configuration when nothing was ever saved. */
  get(projectId: string): Promise<C.TaskDefaultsDto>;
  save(value: C.TaskDefaultsDto, at: string): Promise<void>;
}
export interface TaskDefaultsScope extends TaskFieldWriteScope { readonly defaults: TaskDefaultsRepository }
export interface TaskDefaultsDependencies {
  digest(value: string): string;
  read<T>(context: CommandContext, capability: Capability, work: (scope: TaskDefaultsScope) => Promise<T>): Promise<T>;
  write<T>(context: CommandContext, capability: Capability, work: (scope: TaskDefaultsScope) => Promise<T>): Promise<T>;
}
export interface TaskDefaultsApplication {
  getDefaults(context: CommandContext, projectId: string): Promise<C.TaskDefaultsDto>;
  setDefaults(context: CommandContext, projectId: string, input: C.SetTaskDefaultsInput): Promise<C.TaskDefaultsDto>;
}

const COMMAND = 'task_defaults.set';
const invalid = (message: string, field?: string): never => { throw new DomainError('DOMAIN_VALIDATION_FAILED', message, field ? { details: { fields: [field] } } : {}); };

async function requireProject(scope: TaskDefaultsScope, projectId: string, writable: boolean) {
  const project = await scope.repository.tasks.findProject(scope.context.workspaceId, projectId);
  if (!project) throw notFoundError();
  if (writable && project.archivedAt !== null) invalid('Restore the project before changing its defaults.');
  return project;
}

/** Everything a stored default must still satisfy when it is applied, checked once when it is saved. */
export async function validateTaskDefaults(scope: TaskDefaultsScope, projectId: string, config: C.TaskDefaultsConfig): Promise<void> {
  const ws = scope.context.workspaceId;
  if (config.statusId !== null) {
    const status = await scope.repository.tasks.findStatus(ws, config.statusId);
    if (!status || status.projectId.toLowerCase() !== projectId.toLowerCase()) invalid('The default status is not a status of this project.', 'statusId');
  }
  if (config.assignee?.kind === 'fixed') {
    const membershipId=config.assignee.membershipId;
    const members = await scope.repository.tasks.access.listActiveMemberships(ws);
    if (!members.some(member => member.id === membershipId && member.state === 'active')) invalid('The default assignee must be an active workspace member.', 'assignee');
  }
  if (config.tags?.kind === 'fixed') for (const id of config.tags.tagIds) {
    const tag = await scope.repository.tasks.findTag(ws,id);
    if (!tag || tag.archivedAt !== null) invalid('A default tag is unavailable in this workspace.', 'tags');
  }
  const fields = await scope.repository.listFields(ws, projectId);
  for (const id of config.fromAbove?.fieldIds ?? []) {
    const field = fields.find(item => item.id === id);
    if (!field || field.archivedAt !== null || field.locked) invalid('A field copied from above must be an editable field of this project.', 'fromAbove');
  }
  for (const item of config.todayFields ?? []) {
    const field = fields.find(field => field.id === item.fieldId);
    if (!field || field.type !== 'date' || field.archivedAt !== null || field.locked) invalid('Today can only initialize an editable date field of this project.', 'todayFields');
  }
  for (const item of config.fieldValues) {
    const field = fields.find(candidate => candidate.id.toLowerCase() === item.fieldId.toLowerCase());
    if (!field) invalid('A default refers to a field of another project.', 'fieldValues');
    else if (field.archivedAt !== null) invalid(`“${field.name}” is archived and cannot have a default.`, 'fieldValues');
    else if (field.locked) invalid(`“${field.name}” is locked and cannot have a default.`, 'fieldValues');
    else if (field.type !== item.value.type) invalid(`The default for “${field.name}” has the wrong type.`, 'fieldValues');
    else {
      try { await requireAssignableReferences(scope.repository, ws, field, item.value, null); }
      catch { invalid(`The default for “${field.name}” refers to an option or person that cannot be chosen.`, 'fieldValues'); }
    }
  }
}

export function createTaskDefaultsService(deps: TaskDefaultsDependencies): TaskDefaultsApplication {
  const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new DomainError('VALIDATION_FAILED', 'Invalid task defaults input.');
    return result.data;
  };
  const projectIdOf = (value: string) => parse(C.idSchema, value);
  return {
    getDefaults(context, projectId) {
      const id = projectIdOf(projectId);
      return deps.read(context, 'task.read', async scope => { await requireProject(scope, id, false); return scope.defaults.get(id); });
    },
    async setDefaults(context, projectId, input) {
      const id = projectIdOf(projectId), parsed = parse(C.setTaskDefaultsInputSchema, input), key = context.idempotencyKey;
      if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
      const hash = deps.digest(canonicalJson({ command: COMMAND, projectId: id, input: parsed }));
      return unwrapPlanningOutcome(await deps.write(context, 'fields.manage', async scope => {
        await requireProject(scope, id, false);
        const tasks = scope.repository.tasks, ws = context.workspaceId;
        const old = await tasks.findIdempotency(ws, context.actor.userId, COMMAND, key);
        if (old) {
          if (old.payloadHash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key was used with other task defaults.');
          return isCommittedPlanningRejection(old.result) ? old.result : parse(C.taskDefaultsSchema, old.result);
        }
        await requireProject(scope, id, true);
        const rejected = await scope.planningGuard.check({ family: 'task_defaults', command: COMMAND, target: { projectId: id }, input: parsed });
        const value = rejected ?? await (async () => {
          const current = await scope.defaults.get(id);
          if (current.revision !== parsed.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Reload the current task defaults.', { details: { currentRevision: current.revision } });
          await validateTaskDefaults(scope, id, parsed.config);
          const next: C.TaskDefaultsDto = { workspaceId: ws, projectId: id, revision: current.revision + 1, config: parsed.config };
          await scope.defaults.save(next, scope.barrierAt.toISOString());
          await scope.recordChange({ entityType: 'task_defaults', entityId: id, entityRevision: next.revision, action: 'updated',
            diff: { from: current.config, to: next.config }, outbox: { type: 'task_defaults.updated', payload: { projectId: id, revision: next.revision } } });
          return next;
        })();
        await tasks.insertIdempotency({ workspaceId: ws, actorUserId: context.actor.userId, command: COMMAND, idempotencyKey: key, payloadHash: hash, result: value, createdAt: scope.barrierAt.toISOString() });
        return value;
      }));
    },
  };
}
