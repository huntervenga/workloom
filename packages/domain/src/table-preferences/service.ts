import { idSchema, personalTablePreferenceSchema, updatePersonalTablePreferenceInputSchema, type PersonalTablePreferenceDto } from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError, unauthenticatedError } from '../errors.js';
import { canonicalJson } from '../tasks/service.js';
import type { PersonalTablePreferenceApplication } from './application.js';
import type { PersonalTablePreferenceTools, PersonalTablePreferenceUnitOfWork } from './ports.js';
const command = 'table.preference.set' as const;
function canonicalContext(value: CommandContext): CommandContext {
  const ws = idSchema.safeParse(value.workspaceId), user = idSchema.safeParse(value.actor.userId);
  if (!ws.success) throw notFoundError(); if (!user.success) throw unauthenticatedError();
  return { ...value, workspaceId: ws.data, actor: { ...value.actor, userId: user.data } };
}
function projectId(value: string) { const id = idSchema.safeParse(value); if (!id.success) throw notFoundError(); return id.data; }
function invalid(field: string) { return new DomainError('VALIDATION_FAILED', 'The request is invalid.', { details: { fields: [field] } }); }
const initial = (workspaceId: string, projectId: string, membershipId: string): PersonalTablePreferenceDto => ({ workspaceId, projectId, membershipId, revision: 0, columns: null });
/** Own display metadata only. Viewer and archived-project access intentionally use task.read. */
export function createPersonalTablePreferenceApplication(unit: PersonalTablePreferenceUnitOfWork, tools: PersonalTablePreferenceTools): PersonalTablePreferenceApplication {
  return {
    async getPreference(contextValue, path) {
      const ctx = canonicalContext(contextValue), id = projectId(path);
      return unit.read(async repo => {
        const access = await authorizeWorkspace(repo.access, ctx, 'task.read');
        if (!await repo.projectExists(ctx.workspaceId, id)) throw notFoundError();
        return await repo.findPreference(ctx.workspaceId, id, access.membership.id) ?? initial(ctx.workspaceId, id, access.membership.id);
      });
    },
    async setPreference(contextValue, path, input) {
      const ctx = canonicalContext(contextValue), id = projectId(path), parsed = updatePersonalTablePreferenceInputSchema.safeParse(input), key = ctx.idempotencyKey;
      if (!parsed.success) throw invalid('columns');
      if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw invalid('Idempotency-Key');
      const payloadHash = tools.digest(canonicalJson({ command, target: { projectId: id }, input: parsed.data }));
      return unit.run(ctx, 'task.read', async scope => {
        const repo = scope.repository, ws = ctx.workspaceId, membershipId = scope.access.membership.id;
        if (!await repo.projectExists(ws, id)) throw notFoundError();
        const fieldIds = parsed.data.columns?.flatMap(choice => choice.column.kind === 'field' ? [choice.column.fieldId] : []) ?? [];
        if (fieldIds.length) {
          const known = new Set(await repo.ownFieldIds(ws, id, fieldIds));
          if (fieldIds.some(fieldId => !known.has(fieldId))) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'A selected column is unavailable in this project.');
        }
        // A receipt cannot restore revoked project/field scope or address another person's row.
        const old = await repo.findIdempotency(ws, ctx.actor.userId, command, key);
        if (old) {
          if (old.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This operation key belongs to another request.');
          const stored = personalTablePreferenceSchema.safeParse(old.result);
          if (!stored.success) throw new Error('Stored personal table preference does not match its contract.');
          return stored.data;
        }
        const current = await repo.findPreference(ws, id, membershipId);
        if ((current?.revision ?? 0) !== parsed.data.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Your table columns changed. Reload and review before saving.');
        if (parsed.data.expectedRevision === 2147483647) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The preference revision limit was reached.');
        const rejected = await scope.planningGuard.check({ family: 'table_preference', command, target: { projectId: id }, input: parsed.data });
        if (rejected) throw new Error('An inert personal preference entered a planning mutation.');
        const next: PersonalTablePreferenceDto = { workspaceId: ws, projectId: id, membershipId, revision: parsed.data.expectedRevision + 1, columns: parsed.data.columns };
        const at = scope.barrierAt.toISOString();
        await repo.savePreference(next, at, current !== null);
        const metadata = { projectId: id, membershipId, revision: next.revision };
        await scope.recordChange({ entityType: 'personal_table_preference', entityId: id, action: 'updated', entityRevision: next.revision, diff: metadata, outbox: { type: 'personal_table_preference.updated', payload: { workspaceId: ws, ...metadata } } });
        await repo.insertIdempotency({ workspaceId: ws, actorUserId: ctx.actor.userId, command, idempotencyKey: key, payloadHash, result: next, createdAt: at });
        return next;
      });
    },
  };
}
