import { updateWorkspaceSlugInputSchema, workspaceSchema, type UpdateWorkspaceSlugInput, type WorkspaceDto } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import type { WorkspaceWriteRunner, WorkspaceWriteScope } from '../transactions/ports.js';
import { DomainError, capabilityRequiredError } from '../errors.js';
import { canonicalJson } from '../tasks/service.js';

export interface WorkspaceSlugRepository {
  receipt(actorId: string, key: string): Promise<{ payloadHash: string; result: unknown } | null>;
  saveReceipt(actorId: string, key: string, payloadHash: string, result: WorkspaceDto, at: Date): Promise<void>;
  aliases(): Promise<readonly string[]>;
  claimAlias(slug: string, at: Date): Promise<boolean>;
  setCurrent(slug: string, expectedRevision: number, at: Date): Promise<number>;
}
export interface WorkspaceSlugWriteScope extends WorkspaceWriteScope { readonly repository: WorkspaceSlugRepository }
export interface WorkspaceSlugApplication {
  updateSlug(context: CommandContext, input: UpdateWorkspaceSlugInput): Promise<WorkspaceDto>;
}
export function createWorkspaceSlugService(deps: {
  writer: WorkspaceWriteRunner<WorkspaceSlugWriteScope>;
  digest: (value: string) => string;
}): WorkspaceSlugApplication {
  return { async updateSlug(context, input) {
    const parsed = updateWorkspaceSlugInputSchema.safeParse(input);
    if (!parsed.success || !context.idempotencyKey || !/^[\x21-\x7e]{1,128}$/.test(context.idempotencyKey)) {
      throw new DomainError('VALIDATION_FAILED', 'Enter a valid company address.');
    }
    const key = context.idempotencyKey;
    const hash = deps.digest(canonicalJson({ command: 'workspace.slug.update', input: parsed.data }));
    return deps.writer.run(context, 'workspace.read', async scope => {
      // Owner is a stricter boundary than existing workspace capabilities shared with admins.
      if (scope.access.membership.role !== 'owner') throw capabilityRequiredError();
      const cached = await scope.repository.receipt(context.actor.userId, key);
      if (cached) {
        if (cached.payloadHash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused.');
        return workspaceSchema.parse(cached.result);
      }
      const currentRevision = scope.access.workspace.slugRevision ?? 1;
      if (currentRevision !== parsed.data.expectedSlugRevision) throw new DomainError('REVISION_CONFLICT', 'The company address changed. Reload and try again.');
      const aliases = [...await scope.repository.aliases()];
      const slug = parsed.data.slug;
      if (!aliases.includes(slug) && aliases.length >= 100) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Company address history limit reached.', { details: { workspaceSlugReason: 'limit' } });
      if (!await scope.repository.claimAlias(slug, scope.barrierAt)) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'This company address is unavailable.', { details: { workspaceSlugReason: 'unavailable' } });
      if (!aliases.includes(slug)) aliases.push(slug);
      let revision = currentRevision;
      if (scope.access.workspace.slug !== slug) {
        revision = await scope.repository.setCurrent(slug, currentRevision, scope.barrierAt);
        await scope.recordChange({ entityType: 'workspace', entityId: context.workspaceId, entityRevision: revision,
          action: 'slug_changed', diff: { previousSlug: scope.access.workspace.slug ?? null, slug },
          outbox: { type: 'workspace.slug_changed', payload: { workspaceId: context.workspaceId } } });
      }
      const result = workspaceSchema.parse({ ...scope.access.workspace, role: scope.access.membership.role,
        slug, slugRevision: revision, slugAliases: aliases.sort() });
      await scope.repository.saveReceipt(context.actor.userId, key, hash, result, scope.barrierAt);
      return result;
    });
  } };
}
