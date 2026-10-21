import { describe, expect, it } from 'vitest';
import type { WorkspaceSlugRepository } from './service.js';
import { createWorkspaceSlugService } from './service.js';
import type { CommandContext } from '../access/context.js';
import type { WorkspaceAccessRecord } from '../access/ports.js';
import type { WorkspaceDto } from '@workloom/contracts';
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const access: {workspace: WorkspaceAccessRecord['workspace']; membership: WorkspaceAccessRecord['membership']} = { workspace: { id: id(1), name: 'Company', timezone: 'UTC', weekStart: 1, slug: null, slugRevision: 1, slugAliases: [] },
    membership: { id: id(2), workspaceId: id(1), userId: id(3), displayName: 'Owner', role: 'owner', state: 'active', revision: 1 } };
  const aliases: string[] = [], changes: unknown[] = [], receipts = new Map<string, {payloadHash: string; result: WorkspaceDto}>();
  let taken = false;
  const repository: WorkspaceSlugRepository = {
    receipt: async (_actor, key) => receipts.get(key) ?? null,
    saveReceipt: async (_actor, key, payloadHash, result) => { receipts.set(key, {payloadHash, result}); },
    aliases: async () => [...aliases],
    claimAlias: async slug => { if (taken) return false; if (!aliases.includes(slug)) aliases.push(slug); return true; },
    setCurrent: async () => 2,
  };
  const service = createWorkspaceSlugService({ digest: value => value, writer: {
    run: async (context, _capability, work) => work({context, access, barrierAt: new Date('2026-10-21T12:00:00Z'), repository,
      recordChange: async change => { changes.push(change); return {changeSeq: 1n, eventOrdinal: changes.length}; }}),
  } });
  const context: CommandContext = {actor: {userId: id(3), displayName: 'Owner', kind: 'real'}, workspaceId: id(1), source: 'web', requestId: 'slug-request', idempotencyKey: 'slug-key'};
  return {service, context, access, changes, receipts, setTaken: () => { taken = true; }};
}
describe('workspace slug command', () => {
  it('normalizes, records one change and replays the exact result only after current owner authorization', async () => {
    const f = fixture(), input = {slug: ' Balancy ', expectedSlugRevision: 1};
    const result = await f.service.updateSlug(f.context, input);
    expect(result).toMatchObject({id: id(1), slug: 'balancy', slugRevision: 2, slugAliases: ['balancy']});
    expect(await f.service.updateSlug(f.context, input)).toEqual(result); expect(f.changes).toHaveLength(1);
    f.access.membership = {...f.access.membership, role: 'admin'};
    await expect(f.service.updateSlug(f.context, input)).rejects.toMatchObject({code: 'CAPABILITY_REQUIRED'});
  });
  it('rejects stale, reused and unavailable values without a success receipt', async () => {
    const f = fixture();
    await expect(f.service.updateSlug(f.context, {slug: 'balancy', expectedSlugRevision: 2})).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    expect(f.changes).toHaveLength(0); expect(f.receipts.size).toBe(0);
    f.setTaken(); await expect(f.service.updateSlug(f.context, {slug: 'balancy', expectedSlugRevision: 1})).rejects.toMatchObject({code: 'DOMAIN_VALIDATION_FAILED', details: {workspaceSlugReason: 'unavailable'}});
    expect(f.receipts.size).toBe(0);
    const ok = fixture(); await ok.service.updateSlug(ok.context, {slug: 'balancy', expectedSlugRevision: 1});
    await expect(ok.service.updateSlug(ok.context, {slug: 'other', expectedSlugRevision: 1})).rejects.toMatchObject({code: 'IDEMPOTENCY_KEY_REUSED'});
  });
});
