import { describe, expect, it, vi } from 'vitest';
import type { ColumnChoice, PersonalTablePreferenceDto } from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import type { CommandContext } from '../access/context.js';
import type { AccessRepository, WorkspaceAccessRecord } from '../access/ports.js';
import { createPlanningMutationGuard } from '../planning/freeze.js';
import type { PlanningWriteScope } from '../planning/ports.js';
import type { IdempotencyRecord } from '../tasks/ports.js';
import { createPersonalTablePreferenceApplication } from './service.js';
import type { PersonalTablePreferenceRepository, PersonalTablePreferenceUnitOfWork } from './ports.js';
const id = (n: number) => `ae000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const columns: ColumnChoice[] = [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'field', fieldId: id(5) }, visible: false }];
const ctx: CommandContext = { workspaceId: id(1), actor: { userId: id(2), displayName: 'Viewer', kind: 'fixture' }, source: 'web', requestId: 'preference-test', idempotencyKey: 'key-one' };
function setup() {
  let access: WorkspaceAccessRecord | null = { workspace: { id: id(1), name: 'Workspace', timezone: 'UTC', weekStart: 1 }, membership: { id: id(3), userId: id(2), workspaceId: id(1), displayName: 'Viewer', role: 'viewer', state: 'active', revision: 1 } };
  let exists = true, row: PersonalTablePreferenceDto | null = null, known = [id(5)];
  const order: string[] = [], receipts = new Map<string, IdempotencyRecord>();
  const repo: PersonalTablePreferenceRepository = {
    access: { findWorkspaceAccess: async () => { order.push('access'); return access; } } as unknown as AccessRepository,
    projectExists: vi.fn(async () => { order.push('project'); return exists; }),
    ownFieldIds: vi.fn(async () => { order.push('fields'); return known; }),
    findPreference: vi.fn(async () => row),
    savePreference: vi.fn(async next => { row = next; }),
    findIdempotency: vi.fn(async (_ws, _actor, _command, key) => { order.push('receipt'); return receipts.get(key) ?? null; }),
    insertIdempotency: vi.fn(async receipt => { receipts.set(receipt.idempotencyKey, receipt); }),
  };
  const record = vi.fn(async () => ({ changeSeq: 1n, eventOrdinal: 1 }));
  const guard = createPlanningMutationGuard({} as PlanningWriteScope, { newId: () => id(99), digest: value => value }), check = vi.spyOn(guard, 'check');
  const unit: PersonalTablePreferenceUnitOfWork = { read: work => work(repo), run: async (context, capability, work) => { const active = await authorizeWorkspace(repo.access, context, capability); return work({ context, access: active, barrierAt: new Date('2026-10-16T00:00:00.000Z'), recordChange: record, repository: repo, planningGuard: guard }); } };
  return { app: createPersonalTablePreferenceApplication(unit, { digest: value => value }), repo, order, record, check, setAccess: (value: WorkspaceAccessRecord | null) => { access = value; }, setExists: (value: boolean) => { exists = value; }, setKnown: (value: string[]) => { known = value; }, getRow: () => row };
}
describe('own personal table preference domain', () => {
  it('returns inferred absent revision zero/null without synthesizing a write', async () => {
    const test = setup(); expect(await test.app.getPreference(ctx, id(4))).toEqual({ workspaceId: id(1), projectId: id(4), membershipId: id(3), revision: 0, columns: null });
    expect(test.repo.savePreference).not.toHaveBeenCalled(); expect(test.record).not.toHaveBeenCalled(); expect(test.repo.insertIdempotency).not.toHaveBeenCalled();
  });
  it('lets an active viewer save own columns through the explicit inert family with metadata-only events', async () => {
    const test = setup(), result = await test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns });
    expect(result).toMatchObject({ membershipId: id(3), revision: 1, columns }); expect(test.order).toEqual(['access', 'project', 'fields', 'receipt']);
    expect(test.check).toHaveBeenCalledWith({ family: 'table_preference', command: 'table.preference.set', target: { projectId: id(4) }, input: { expectedRevision: 0, columns } });
    expect(JSON.stringify(test.record.mock.calls)).not.toContain('fieldId'); expect(JSON.stringify(test.record.mock.calls)).not.toContain('columns');
    expect(test.repo.ownFieldIds).toHaveBeenCalledWith(id(1), id(4), [id(5)]);
  });
  it('increments version for reset and fresh same-content saves, never deleting/resetting the head to zero', async () => {
    const test = setup(); await test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns });
    expect((await test.app.setPreference({ ...ctx, idempotencyKey: 'two' }, id(4), { expectedRevision: 1, columns: null })).revision).toBe(2);
    expect((await test.app.setPreference({ ...ctx, idempotencyKey: 'three' }, id(4), { expectedRevision: 2, columns: null })).revision).toBe(3);
    expect(test.getRow()).toMatchObject({ revision: 3, columns: null });
  });
  it('replays old receipts without restoring a newer preference head', async () => {
    const test = setup(), first = await test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns });
    await test.app.setPreference({ ...ctx, idempotencyKey: 'two' }, id(4), { expectedRevision: 1, columns: null });
    expect(await test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns })).toEqual(first);
    expect(test.getRow()).toMatchObject({ revision: 2, columns: null }); expect(test.repo.savePreference).toHaveBeenCalledTimes(2); expect(test.record).toHaveBeenCalledTimes(2);
  });
  it('checks current project/ref/membership scope before an exact receipt', async () => {
    const test = setup(); await test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns });
    test.setExists(false); test.order.length = 0;
    await expect(test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns })).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(test.order).toEqual(['access', 'project']);
    test.setExists(true); test.setKnown([]); test.order.length = 0;
    await expect(test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' }); expect(test.order).toEqual(['access', 'project', 'fields']);
    test.setAccess(null); test.order.length = 0;
    await expect(test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns })).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(test.order).toEqual(['access']);
  });
  it('rejects stale revisions and changed payload reuse without updating the head', async () => {
    const test = setup(); await test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns });
    await expect(test.app.setPreference({ ...ctx, idempotencyKey: 'two' }, id(4), { expectedRevision: 0, columns: null })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(test.app.setPreference(ctx, id(4), { expectedRevision: 0, columns: null })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(test.getRow()).toMatchObject({ revision: 1, columns }); expect(test.repo.savePreference).toHaveBeenCalledTimes(1);
  });
});
