import * as C from '@workloom/contracts';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError } from '../errors.js';
import type { TaskFieldWriteScope } from '../fields/ports.js';
import { canonicalJson } from '../tasks/service.js';

export interface ProjectViewsRepository {
  get(projectId: string): Promise<C.ProjectViewsDto>;
  save(value: C.ProjectViewsDto, at: string): Promise<void>;
}
export interface ProjectViewsScope extends TaskFieldWriteScope { readonly views: ProjectViewsRepository }
export interface ProjectViewsApplication {
  get(context: CommandContext, projectId: string): Promise<C.ProjectViewsDto>;
  set(context: CommandContext, projectId: string, input: C.SetProjectViewsInput): Promise<C.ProjectViewsDto>;
}
interface Dependencies {
  digest(value: string): string;
  read<T>(context: CommandContext, capability: Capability, work: (scope: ProjectViewsScope) => Promise<T>): Promise<T>;
  write<T>(context: CommandContext, capability: Capability, work: (scope: ProjectViewsScope) => Promise<T>): Promise<T>;
}
const COMMAND = 'project_views.set';
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError('VALIDATION_FAILED', 'Invalid saved view.');
  return result.data;
}
export function createProjectViewsService(deps: Dependencies): ProjectViewsApplication {
  return {
    get(context, rawId) {
      const id = parse(C.idSchema, rawId);
      return deps.read(context, 'task.read', async scope => {
        if (!await scope.repository.tasks.findProject(scope.context.workspaceId, id)) throw notFoundError();
        return scope.views.get(id);
      });
    },
    set(context, rawId, input) {
      const id = parse(C.idSchema, rawId), parsed = parse(C.setProjectViewsInputSchema, input), key = context.idempotencyKey;
      if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
      const hash = deps.digest(canonicalJson({ command: COMMAND, projectId: id, input: parsed }));
      return deps.write(context, 'fields.manage', async scope => {
        const tasks = scope.repository.tasks, ws = scope.context.workspaceId, userId = scope.context.actor.userId;
        const project = await tasks.findProject(ws, id);
        if (!project) throw notFoundError();
        const previous = await tasks.findIdempotency(ws, userId, COMMAND, key);
        if (previous) {
          if (previous.payloadHash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key was used with other views.');
          return parse(C.projectViewsSchema, previous.result);
        }
        if (project.archivedAt !== null) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Restore the project before editing shared views.');
        const current = await scope.views.get(id);
        if (current.revision !== parsed.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Reload and review the shared views.');
        if (current.revision === 2147483647) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The revision limit was reached.');
        const rejected = await scope.planningGuard.check({ family: 'project_view', command: COMMAND, target: { projectId: id }, input: parsed });
        if (rejected) throw new Error('A display preference unexpectedly entered planning.');
        const next = { workspaceId: ws, projectId: id, revision: current.revision + 1, views: parsed.views };
        const at = scope.barrierAt.toISOString();
        await scope.views.save(next, at);
        const metadata = { projectId: id, revision: next.revision };
        await scope.recordChange({ entityType: 'project_views', entityId: id, entityRevision: next.revision, action: 'updated',
          diff: metadata, outbox: { type: 'project_views.updated', payload: metadata } });
        await tasks.insertIdempotency({ workspaceId: ws, actorUserId: userId, command: COMMAND, idempotencyKey: key,
          payloadHash: hash, result: next, createdAt: at });
        return next;
      });
    },
  };
}
