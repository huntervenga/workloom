import { describe, expect, it } from 'vitest';

import type { UserRecord, WorkspaceAccessRecord } from '../access/ports.js';
import { isDomainError } from '../errors.js';
import {
  createWorkspaceCreateService,
  type NewWorkspacePlan,
  type WorkspaceCreateContext,
  type WorkspaceCreateScope,
  type WorkspaceCreationReceipt,
} from './create.js';

const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realUser: UserRecord = { id: id(1), displayName: 'Verified person', kind: 'real' };

function context(overrides: Partial<WorkspaceCreateContext> = {}): WorkspaceCreateContext {
  return { actor: { userId: realUser.id, displayName: realUser.displayName, kind: 'real' }, source: 'web', requestId: 'req-1', idempotencyKey: 'key-1', ...overrides };
}

/** In-memory port: one map per table, with a per-run log so tests can assert reads and writes. */
function harness() {
  const users = new Map<string, UserRecord>([[realUser.id, realUser]]);
  const receipts = new Map<string, WorkspaceCreationReceipt>();
  const access = new Map<string, WorkspaceAccessRecord>();
  const inserted: NewWorkspacePlan[] = [];
  const locked: string[] = [];
  const runs: { actorUserId: string; idempotencyKey: string }[] = [];
  let counter = 100;
  const digestInputs: string[] = [];
  const hashes = new Map<string, string>();
  const digest = (value: string): string => {
    digestInputs.push(value);
    const known = hashes.get(value);
    if (known !== undefined) return known;
    const next = String(hashes.size + 1).padStart(64, '0');
    hashes.set(value, next);
    return next;
  };
  let owned = 0;
  const scope: WorkspaceCreateScope = {
    async countOwnedWorkspaces() { return owned; },
    async findActor(userId) { return users.get(userId) ?? null; },
    async findReceipt(actorUserId, key) { return receipts.get(`${actorUserId}|${key}`) ?? null; },
    async lockWorkspaceAccess(workspaceId, userId) { locked.push(workspaceId); return access.get(`${workspaceId}|${userId}`) ?? null; },
    async insertWorkspace(plan) {
      inserted.push(plan);
      const record: WorkspaceAccessRecord = {
        workspace: { id: plan.workspaceId, name: plan.name, timezone: plan.timezone, weekStart: 1 },
        membership: { id: plan.membershipId, workspaceId: plan.workspaceId, userId: plan.context.actor.userId, displayName: plan.context.actor.displayName, role: 'owner', state: 'active', revision: 1 },
      };
      access.set(`${plan.workspaceId}|${plan.context.actor.userId}`, record);
      receipts.set(`${plan.context.actor.userId}|${plan.idempotencyKey}`, { workspaceId: plan.workspaceId, payloadHash: plan.payloadHash });
      return record;
    },
  };
  const service = createWorkspaceCreateService({
    newId: () => id(counter++),
    digest,
    unitOfWork: { async run(actorUserId, idempotencyKey, work) { runs.push({ actorUserId, idempotencyKey }); return work(scope); } },
  });
  return { service, users, receipts, access, inserted, locked, runs, digestInputs, setOwned: (count: number) => { owned = count; } };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isDomainError(error)) return error.code;
    throw error;
  }
  throw new Error('Expected a domain error.');
}

describe('workspace creation service', () => {
  it('refuses a new workspace once the person owns the maximum', async () => {
    const h = harness();
    h.setOwned(25);
    await expect(h.service.createWorkspace(context(), { name: 'One more', timezone: 'UTC' })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    expect(h.inserted).toHaveLength(0);
  });

  it('creates one owned workspace with fresh IDs, trusted audit context and a canonical payload hash', async () => {
    const h = harness();
    const dto = await h.service.createWorkspace(context(), { name: '  Launch team ', timezone: 'Europe/Berlin' });
    expect(dto).toEqual({ id: id(100), name: 'Launch team', role: 'owner', timezone: 'Europe/Berlin' });
    expect(h.runs).toEqual([{ actorUserId: realUser.id, idempotencyKey: 'key-1' }]);
    expect(h.inserted).toHaveLength(1);
    const [plan] = h.inserted;
    expect(plan).toMatchObject({ workspaceId: id(100), membershipId: id(101), name: 'Launch team', timezone: 'Europe/Berlin', idempotencyKey: 'key-1',
      context: { actor: { userId: realUser.id, kind: 'real' }, source: 'web', requestId: 'req-1' } });
    expect(h.digestInputs).toEqual(['["workspace.create.v1","Launch team","Europe/Berlin"]']);
    expect(plan?.payloadHash).toBe('0000000000000000000000000000000000000000000000000000000000000001');
  });

  it('replays an identical retry without a second insert, and the trimmed form hashes identically', async () => {
    const h = harness();
    const first = await h.service.createWorkspace(context(), { name: 'Launch team', timezone: 'UTC' });
    const second = await h.service.createWorkspace(context({ requestId: 'req-2' }), { name: ' Launch team ', timezone: 'UTC' });
    expect(second).toEqual(first);
    expect(h.inserted).toHaveLength(1);
    expect(h.locked).toEqual([first.id]);
  });

  it('rejects a changed body under the same key as IDEMPOTENCY_KEY_REUSED', async () => {
    const h = harness();
    await h.service.createWorkspace(context(), { name: 'Launch team', timezone: 'UTC' });
    expect(await rejection(h.service.createWorkspace(context(), { name: 'Other team', timezone: 'UTC' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await rejection(h.service.createWorkspace(context(), { name: 'Launch team', timezone: 'Europe/Paris' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(h.inserted).toHaveLength(1);
  });

  it('authorizes replay against the current membership: revoked or absent is NOT_FOUND, demoted shows the current role', async () => {
    const h = harness();
    const first = await h.service.createWorkspace(context(), { name: 'Launch team', timezone: 'UTC' });
    const key = `${first.id}|${realUser.id}`;
    const owner = h.access.get(key);
    if (owner === undefined) throw new Error('Expected the owner membership.');

    h.access.set(key, { ...owner, membership: { ...owner.membership, role: 'viewer', revision: 2 } });
    expect(await h.service.createWorkspace(context(), { name: 'Launch team', timezone: 'UTC' })).toEqual({ ...first, role: 'viewer' });

    h.access.set(key, { ...owner, membership: { ...owner.membership, state: 'revoked', revision: 3 } });
    expect(await rejection(h.service.createWorkspace(context(), { name: 'Launch team', timezone: 'UTC' }))).toBe('NOT_FOUND');
    // A revoked actor learns nothing about the stored body either.
    expect(await rejection(h.service.createWorkspace(context(), { name: 'Other', timezone: 'UTC' }))).toBe('NOT_FOUND');

    h.access.delete(key);
    expect(await rejection(h.service.createWorkspace(context(), { name: 'Launch team', timezone: 'UTC' }))).toBe('NOT_FOUND');
    expect(h.inserted).toHaveLength(1);
    expect(h.access.has(key)).toBe(false);
  });

  it('keeps keys actor-scoped: another real actor with the same key gets an independent workspace', async () => {
    const h = harness();
    const other: UserRecord = { id: id(2), displayName: 'Second person', kind: 'real' };
    h.users.set(other.id, other);
    const first = await h.service.createWorkspace(context(), { name: 'Team', timezone: 'UTC' });
    const second = await h.service.createWorkspace(context({ actor: { userId: other.id, displayName: other.displayName, kind: 'real' } }), { name: 'Team', timezone: 'UTC' });
    expect(second.id).not.toBe(first.id);
    expect(second.role).toBe('owner');
    expect(h.inserted).toHaveLength(2);
  });

  it('only accepts currently persisted real actors, whatever the caller claims', async () => {
    const h = harness();
    const fixtureClaim = context({ actor: { userId: realUser.id, displayName: 'x', kind: 'fixture' } });
    expect(await rejection(h.service.createWorkspace(fixtureClaim, { name: 'Team', timezone: 'UTC' }))).toBe('CAPABILITY_REQUIRED');
    expect(h.runs).toHaveLength(0);

    h.users.set(realUser.id, { ...realUser, kind: 'fixture' });
    expect(await rejection(h.service.createWorkspace(context(), { name: 'Team', timezone: 'UTC' }))).toBe('CAPABILITY_REQUIRED');
    h.users.delete(realUser.id);
    expect(await rejection(h.service.createWorkspace(context(), { name: 'Team', timezone: 'UTC' }))).toBe('UNAUTHENTICATED');
    expect(await rejection(h.service.createWorkspace(context({ actor: { userId: 'not-a-uuid', displayName: 'x', kind: 'real' } }), { name: 'Team', timezone: 'UTC' }))).toBe('UNAUTHENTICATED');
    expect(h.inserted).toHaveLength(0);
  });

  it('re-validates the contract: no extras, owner selectors, invalid names, time zones or keys', async () => {
    const h = harness();
    const invalid: unknown[] = [
      null, {}, { name: 'Team' }, { timezone: 'UTC' },
      { name: 'Team', timezone: 'UTC', ownerUserId: id(5) }, { name: 'Team', timezone: 'UTC', actor: { userId: id(5) } },
      { name: 'Team', timezone: 'UTC', workspaceId: id(6) }, { name: 'Team', timezone: 'UTC', weekStart: 3 },
      { name: '', timezone: 'UTC' }, { name: ' \t ', timezone: 'UTC' }, { name: 'x'.repeat(201), timezone: 'UTC' }, { name: 'a\0b', timezone: 'UTC' },
      { name: 'Team', timezone: 'Not/AZone' }, { name: 'Team', timezone: '../etc' }, { name: 'Team', timezone: 'utc offset' },
      { name: 'Team', timezone: `America/${'B'.repeat(60)}` },
    ];
    for (const input of invalid) {
      expect(await rejection(h.service.createWorkspace(context(), input as never))).toBe('VALIDATION_FAILED');
    }
    for (const idempotencyKey of ['', 'with space', 'k'.repeat(129), 'tab\tkey']) {
      expect(await rejection(h.service.createWorkspace(context({ idempotencyKey }), { name: 'Team', timezone: 'UTC' }))).toBe('VALIDATION_FAILED');
    }
    expect(h.runs).toHaveLength(0);
    expect(await h.service.createWorkspace(context(), { name: 'x'.repeat(200), timezone: 'America/Argentina/Buenos_Aires' })).toMatchObject({ role: 'owner' });
  });
});
