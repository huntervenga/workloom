import * as C from '@workloom/contracts';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError } from '../errors.js';
import type { TaskFieldWriteScope } from '../fields/ports.js';
import { isCommittedPlanningRejection, unwrapPlanningOutcome } from '../planning/freeze.js';
import { canonicalJson } from '../tasks/service.js';

export interface ProjectRulesRepository {
  /** Revision 0 with every rule off when nothing was ever saved. */
  get(projectId: string): Promise<C.ProjectRulesDto>;
  save(value: C.ProjectRulesDto, at: string): Promise<void>;
}
export interface ProjectRulesScope extends TaskFieldWriteScope { readonly rules: ProjectRulesRepository }
export interface ProjectRulesDependencies {
  digest(value: string): string;
  read<T>(context: CommandContext, capability: Capability, work: (scope: ProjectRulesScope) => Promise<T>): Promise<T>;
  write<T>(context: CommandContext, capability: Capability, work: (scope: ProjectRulesScope) => Promise<T>): Promise<T>;
}
export interface ProjectRulesApplication {
  getRules(context: CommandContext, projectId: string): Promise<C.ProjectRulesDto>;
  setRules(context: CommandContext, projectId: string, input: C.SetProjectRulesInput): Promise<C.ProjectRulesDto>;
}

const COMMAND = 'project_rules.set';

async function requireProject(scope: ProjectRulesScope, projectId: string, writable: boolean) {
  const project = await scope.repository.tasks.findProject(scope.context.workspaceId, projectId);
  if (!project) throw notFoundError();
  if (writable && project.archivedAt !== null) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Restore the project before changing its rules.');
  return project;
}

export function createProjectRulesService(deps: ProjectRulesDependencies): ProjectRulesApplication {
  const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new DomainError('VALIDATION_FAILED', 'Invalid project rules input.');
    return result.data;
  };
  return {
    getRules(context, projectId) {
      const id = parse(C.idSchema, projectId);
      return deps.read(context, 'task.read', async scope => { await requireProject(scope, id, false); return scope.rules.get(id); });
    },
    async setRules(context, projectId, input) {
      const id = parse(C.idSchema, projectId), parsed = parse(C.setProjectRulesInputSchema, input), key = context.idempotencyKey;
      if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
      const hash = deps.digest(canonicalJson({ command: COMMAND, projectId: id, input: parsed }));
      return unwrapPlanningOutcome(await deps.write(context, 'fields.manage', async scope => {
        await requireProject(scope, id, false);
        const tasks = scope.repository.tasks, ws = context.workspaceId;
        const old = await tasks.findIdempotency(ws, context.actor.userId, COMMAND, key);
        if (old) {
          if (old.payloadHash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key was used with other project rules.');
          return isCommittedPlanningRejection(old.result) ? old.result : parse(C.projectRulesSchema, old.result);
        }
        await requireProject(scope, id, true);
        const rejected = await scope.planningGuard.check({ family: 'project_rules', command: COMMAND, target: { projectId: id }, input: parsed });
        const value = rejected ?? await (async () => {
          const current = await scope.rules.get(id);
          if (current.revision !== parsed.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Reload the current project rules.', { details: { currentRevision: current.revision } });
          const next: C.ProjectRulesDto = { workspaceId: ws, projectId: id, revision: current.revision + 1, config: parsed.config };
          await scope.rules.save(next, scope.barrierAt.toISOString());
          await scope.recordChange({ entityType: 'project_rules', entityId: id, entityRevision: next.revision, action: 'updated',
            diff: { from: current.config, to: next.config }, outbox: { type: 'project_rules.updated', payload: { projectId: id, revision: next.revision } } });
          return next;
        })();
        await tasks.insertIdempotency({ workspaceId: ws, actorUserId: context.actor.userId, command: COMMAND, idempotencyKey: key, payloadHash: hash, result: value, createdAt: scope.barrierAt.toISOString() });
        return value;
      }));
    },
  };
}
