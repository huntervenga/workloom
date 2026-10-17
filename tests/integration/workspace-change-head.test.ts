// Real HTTP and PostgreSQL evidence in a newly created, disposable database only.
// No runtime database or synthetic replacement for PostgreSQL is used by this suite.
import { randomUUID } from 'node:crypto';

import { workspaceChangeHeadResponseSchema, type WorkspaceChangeHeadDto } from '@workloom/contracts';
import { createDatabase, createWorkspaceChangeHeadApplication, runWorkspaceWrite, type Database, type WorkloomExecutor } from '@workloom/db';
import type { CommandContext } from '@workloom/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { userTables } from './support/db-cli.js';
import { header } from './support/http.js';
import { expectEnvelope, expectError } from './support/p1a.js';
import { databaseSnapshot, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { commit, MEMBERS as M, OUTSIDE, period, planningHarness, planningProject, planningTask, TEAM, USERS as U, type PlanningHarness } from './support/p2a-fixture.js';
import { P2aClient } from './support/p2a.js';
import { p3bClients } from './support/p3b.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

const HEAD = '/change-head';
const context = (userId: string = U.owner, workspaceId: string = TEAM): CommandContext => ({
  workspaceId, actor: { userId, displayName: 'Synthetic test actor', kind: 'fixture' }, source: 'web', requestId: randomUUID(),
});
const ownerIdentity = { workspaceId: TEAM, actorUserId: U.owner, membershipId: M.teamOwner, membershipRevision: 1, role: 'owner' } as const;

async function head(client: P2aClient): Promise<WorkspaceChangeHeadDto> {
  const response = await client.get(HEAD);
  expect(header(response, 'cache-control')).toBe('no-store');
  expect(header(response, 'x-request-id')).not.toBe('');
  const envelope = expectEnvelope(response, 200, workspaceChangeHeadResponseSchema);
  expect(envelope.meta.requestId).toBe(header(response, 'x-request-id'));
  return envelope.data;
}

// Preserve the established public-table assertions and also cover every installed user schema,
// including queue tables if this disposable database's migrations installed them.
async function fullSnapshot(h: PlanningHarness) {
  const publicData = await databaseSnapshot(h.db.sql);
  const otherSchemas: Record<string, { count: string; digest: string }> = {};
  for (const { schema, table } of await userTables(h.db.sql)) {
    if (schema === 'public') continue;
    const [row] = await h.db.sql<{ count: string; digest: string }[]>`
      select count(*)::text as count,
        md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text) as digest
      from ${h.db.sql(schema)}.${h.db.sql(table)} as t`;
    if (!row) throw new Error('Expected a digest for every installed user table.');
    otherSchemas[`${schema}.${table}`] = row;
  }
  return { publicData, otherSchemas };
}

// Independent expected counters come from stored fixture state, never from the service under test.
async function storedHead(h: PlanningHarness, workspaceId: string = TEAM) {
  const [row] = await h.db.sql<{ changeSeq: string; permissionEpoch: string }[]>`
    select change_seq::text as "changeSeq", permission_epoch::text as "permissionEpoch"
    from workspaces where id = ${workspaceId}`;
  if (!row) throw new Error('Expected the isolated fixture workspace.');
  return row;
}

describe('workspace change head over HTTP on isolated PostgreSQL', () => {
  let h: PlanningHarness;
  let db: Database;
  beforeAll(async () => {
    h = await planningHarness('workspace_change_head');
    db = createDatabase(h.db.url, { requireLoopback: true });
  });
  afterAll(async () => {
    await db?.close();
    await h?.close();
  });

  it('returns exact zero heads and canonical current actor memberships, including read-only viewers', async () => {
    const before = await fullSnapshot(h);
    expect(await head(h.owner)).toEqual({ ...ownerIdentity, changeSeq: '0', permissionEpoch: '0' });
    expect(await head(h.viewer)).toEqual({
      workspaceId: TEAM, actorUserId: U.viewer, membershipId: M.teamViewer, membershipRevision: 1,
      role: 'viewer', changeSeq: '0', permissionEpoch: '0',
    });
    expect(await head(new P2aClient(h.member.api, TEAM.toUpperCase()))).toEqual({
      workspaceId: TEAM, actorUserId: U.memberA, membershipId: M.teamMemberA, membershipRevision: 1,
      role: 'member', changeSeq: '0', permissionEpoch: '0',
    });
    expect(await fullSnapshot(h)).toEqual(before);
  });

  it('rejects all query inputs and malformed paths without any database effects', async () => {
    const before = await fullSnapshot(h);
    for (const query of ['actorUserId=' + U.outsider, 'membershipId=' + M.teamOwner, 'role=owner', 'projectId=' + randomUUID(), 'since=0', 'cursor=x', 'changeSeq=1', 'unknown=', 'since=0&since=1']) {
      expectError(await h.owner.get(`${HEAD}?${query}`), 400, 'VALIDATION_FAILED');
    }
    expectError(await new P2aClient(h.owner.api, 'not-a-uuid').get(HEAD), 400, 'VALIDATION_FAILED');
    expect(await fullSnapshot(h)).toEqual(before);
  });

  it('exposes a colleague HTTP command to a second process on the next authorized read', async () => {
    const counters = await storedHead(h);
    await h.owner.tasks.createProject('Synthetic colleague head change');
    const expected = { ...ownerIdentity, ...counters, changeSeq: (BigInt(counters.changeSeq) + 1n).toString() };
    expect(await head(h.replica)).toEqual(expected);
    expect(await head(h.viewer)).toEqual({ ...expected, actorUserId: U.viewer, membershipId: M.teamViewer, role: 'viewer' });
  });

  it('shows committed writes to a second client and advances once for multiple events in one transaction', async () => {
    const before = await storedHead(h);
    const request = context();
    const entityId = randomUUID();
    await runWorkspaceWrite(db, request, 'task.edit', async scope => {
      await Promise.all([
        scope.recordChange({ entityType: 'head_probe', entityId, action: 'created' }),
        scope.recordChange({ entityType: 'head_probe', entityId, action: 'updated', outbox: { type: 'head_probe.updated', payload: { synthetic: true } } }),
      ]);
    });
    const expected = { ...ownerIdentity, ...before, changeSeq: (BigInt(before.changeSeq) + 1n).toString() };
    expect(await head(h.replica)).toEqual(expected);
    expect(await head(h.owner)).toEqual(expected);
    const events = await h.db.sql<{ change_seq: string; event_ordinal: number }[]>`
      select change_seq::text as change_seq, event_ordinal from audit_events
      where request_id = ${request.requestId} order by event_ordinal`;
    expect(events).toEqual([
      { change_seq: expected.changeSeq, event_ordinal: 1 }, { change_seq: expected.changeSeq, event_ordinal: 2 },
    ]);
    expect(await h.db.sql`select change_seq::text as change_seq, event_ordinal from outbox_events where aggregate_id = ${entityId}`)
      .toEqual([{ change_seq: expected.changeSeq, event_ordinal: 2 }]);
  });

  it('keeps the complete database and visible head unchanged after a rolled-back write', async () => {
    const beforeHead = { ...ownerIdentity, ...await storedHead(h) };
    const before = await fullSnapshot(h);
    await expect(runWorkspaceWrite(db, context(), 'task.edit', async scope => {
      await scope.recordChange({ entityType: 'head_probe', entityId: randomUUID(), action: 'updated', outbox: { type: 'head_probe.updated', payload: {} } });
      await scope.tx.execute(sql`update workspaces set name = 'Rolled back synthetic name' where id = ${TEAM}`);
      throw new Error('Intentional isolated test rollback');
    })).rejects.toThrow('Intentional isolated test rollback');
    expect(await head(h.replica)).toEqual(beforeHead);
    expect(await fullSnapshot(h)).toEqual(before);
  });

  it('does not expose another workspace commit through this workspace head', async () => {
    const team = { ...ownerIdentity, ...await storedHead(h) };
    const outside = await storedHead(h, OUTSIDE);
    await h.outsider.tasks.createProject('Synthetic foreign head change');
    expect(await head(h.replica)).toEqual(team);
    expect(await head(h.outsider)).toEqual({
      workspaceId: OUTSIDE, actorUserId: U.outsider, membershipId: M.outsideOwner, membershipRevision: 1, role: 'owner',
      permissionEpoch: outside.permissionEpoch, changeSeq: (BigInt(outside.changeSeq) + 1n).toString(),
    });
  });

  it('rereads role, membership revision and permission epoch independently when changeSeq stays equal', async () => {
    const counters = await storedHead(h);
    const membership = await membershipRow(h.db.sql, TEAM, M.teamViewer);
    const base = { workspaceId: TEAM, actorUserId: U.viewer, membershipId: M.teamViewer, membershipRevision: membership.revision, role: 'viewer', ...counters };
    try {
      await h.db.sql`update memberships set role = 'member' where id = ${M.teamViewer} and workspace_id = ${TEAM}`;
      expect(await head(h.viewer)).toEqual({ ...base, role: 'member' });
      await h.db.sql`update memberships set revision = revision + 1 where id = ${M.teamViewer} and workspace_id = ${TEAM}`;
      expect(await head(h.viewer)).toEqual({ ...base, role: 'member', membershipRevision: membership.revision + 1 });
      await h.db.sql`update workspaces set permission_epoch = permission_epoch + 1 where id = ${TEAM}`;
      const expected = { ...base, role: 'member', membershipRevision: membership.revision + 1, permissionEpoch: (BigInt(counters.permissionEpoch) + 1n).toString() };
      const before = await fullSnapshot(h);
      expect(await head(h.viewer)).toEqual(expected);
      expect(await head(h.viewer)).toEqual(expected);
      expect(await fullSnapshot(h)).toEqual(before);
    } finally {
      await h.db.sql`update memberships set role = 'viewer' where id = ${M.teamViewer} and workspace_id = ${TEAM}`;
      await restoreMembership(h.db.sql, TEAM, M.teamViewer, membership);
      await h.db.sql`update workspaces set permission_epoch = ${counters.permissionEpoch}::text::bigint where id = ${TEAM}`;
    }
  });

  it('returns precise decimal strings above Number safety and at PostgreSQL bigint maximum', async () => {
    const original = await storedHead(h);
    try {
      for (const value of ['9007199254740993', '9223372036854775807']) {
        await h.db.sql`update workspaces set change_seq = ${value}::text::bigint, permission_epoch = ${value}::text::bigint where id = ${TEAM}`;
        const before = await fullSnapshot(h);
        expect(await head(h.owner)).toEqual({ ...ownerIdentity, changeSeq: value, permissionEpoch: value });
        expect(await fullSnapshot(h)).toEqual(before);
      }
    } finally {
      await h.db.sql`update workspaces set change_seq = ${original.changeSeq}::text::bigint, permission_epoch = ${original.permissionEpoch}::text::bigint where id = ${TEAM}`;
    }
  });

  it('returns neutral NOT_FOUND for outsiders, absent workspaces and a membership revoked after an earlier successful read', async () => {
    const hidden = [TEAM, M.teamViewer, 'Synthetic Team Workspace', 'changeSeq', 'permissionEpoch'];
    const before = await fullSnapshot(h);
    const denied = expectError(await new P2aClient(h.outsider.api, TEAM).get(HEAD), 404, 'NOT_FOUND', hidden);
    const absent = expectError(await new P2aClient(h.owner.api, randomUUID()).get(HEAD), 404, 'NOT_FOUND', hidden);
    expect(absent.error).toEqual(denied.error);
    expect(await fullSnapshot(h)).toEqual(before);
    const saved = await membershipRow(h.db.sql, TEAM, M.teamViewer);
    await head(h.viewer);
    try {
      await revokeMembership(h.db.sql, TEAM, M.teamViewer);
      const revoked = await fullSnapshot(h);
      const response = expectError(await h.viewer.get(HEAD), 404, 'NOT_FOUND', hidden);
      expect(response.error).toEqual(denied.error);
      expectError(await h.viewer.get(HEAD), 404, 'NOT_FOUND', hidden);
      expect(await fullSnapshot(h)).toEqual(revoked);
    } finally { await restoreMembership(h.db.sql, TEAM, M.teamViewer, saved); }
    expect(await head(h.viewer)).toMatchObject({ membershipId: M.teamViewer, role: 'viewer', membershipRevision: saved.revision });
  });

  it('reads the committed head without waiting for or observing an uncommitted workspace barrier writer', async () => {
    const expected = { ...ownerIdentity, ...await storedHead(h) };
    const connection = await h.db.sql.reserve();
    let pending: Promise<WorkspaceChangeHeadDto> | undefined;
    let observed: WorkspaceChangeHeadDto | 'blocked' = 'blocked';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await connection`begin`;
      await connection`update workspaces set change_seq = change_seq + 1 where id = ${TEAM}`;
      pending = head(h.replica);
      observed = await Promise.race([pending, new Promise<'blocked'>(resolve => { timer = setTimeout(() => resolve('blocked'), 2_000); })]);
    } finally {
      if (timer) clearTimeout(timer);
      await connection`rollback`;
      connection.release();
      await pending;
    }
    expect(observed, 'A head read must not acquire the workspace write barrier.').toEqual(expected);
  });

  it('uses a real read-only repeatable snapshot for authorization and both counters during concurrent revocation', async () => {
    const counters = await storedHead(h);
    const saved = await membershipRow(h.db.sql, TEAM, M.teamViewer);
    let inspected = false;
    let committed: Awaited<ReturnType<typeof fullSnapshot>> | undefined;
    // Instrument transaction entry only: every authorization/head query still executes on PostgreSQL.
    const inspectedDb = new Proxy(db.db, { get(original, key, receiver) {
      if (key !== 'transaction') return Reflect.get(original, key, receiver) as unknown;
      return async <R>(read: (tx: WorkloomExecutor) => Promise<R>, options: { isolationLevel: 'repeatable read'; accessMode: 'read only' }) => original.transaction(async tx => {
        expect(options).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
        const settings = await tx.execute(sql`select current_setting('transaction_read_only') as read_only, current_setting('transaction_isolation') as isolation`);
        expect(settings[0]).toMatchObject({ read_only: 'on', isolation: 'repeatable read' });
        // Establish the actual MVCC snapshot before a separate connection commits both changes.
        await tx.execute(sql`select id from memberships where id = ${M.teamViewer}`);
        await h.db.sql.begin(async concurrent => {
          await concurrent`update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1 where id = ${M.teamViewer}`;
          await concurrent`update workspaces set change_seq = change_seq + 1, permission_epoch = permission_epoch + 1 where id = ${TEAM}`;
        });
        committed = await fullSnapshot(h);
        inspected = true;
        return read(tx);
      }, options);
    } }) as WorkloomExecutor;
    try {
      const actual = await createWorkspaceChangeHeadApplication(inspectedDb).getHead(context(U.viewer.toUpperCase(), TEAM.toUpperCase()));
      expect(actual).toEqual({ workspaceId: TEAM, actorUserId: U.viewer, membershipId: M.teamViewer, membershipRevision: saved.revision, role: 'viewer', ...counters });
      expect(inspected).toBe(true);
      expect(committed).toBeDefined();
      expectError(await h.viewer.get(HEAD), 404, 'NOT_FOUND');
      expect(await fullSnapshot(h)).toEqual(committed);
      expect(await head(h.owner)).toEqual({ ...ownerIdentity, changeSeq: (BigInt(counters.changeSeq) + 1n).toString(), permissionEpoch: (BigInt(counters.permissionEpoch) + 1n).toString() });
    } finally {
      await restoreMembership(h.db.sql, TEAM, M.teamViewer, saved);
      await h.db.sql`update workspaces set change_seq = ${counters.changeSeq}::text::bigint, permission_epoch = ${counters.permissionEpoch}::text::bigint where id = ${TEAM}`;
    }
  });

  it('leaves all data, revisions, receipts and jobs unchanged with overdue freeze and recurrence prerequisites', async () => {
    const { project, todo } = await planningProject(h.owner, 'Synthetic overdue head reads');
    const task = await planningTask(h.owner, project, 120);
    const week = await period(h.owner, project.id, { localStart: '2027-01-04', cutoffAt: '2030-01-01T00:00:00.000Z' });
    await commit(h.owner, week, task, 60);
    const recurrence = p3bClients(h).owner;
    await recurrence.create(project.id, {
      schedule: { startDate: '2027-01-04', localTime: '10:00', timezone: 'UTC', frequency: 'daily', plannedDurationMinutes: 30, end: { kind: 'after_count', count: 1 } },
      template: { title: 'Synthetic missing head-read occurrence', statusId: todo.id, organizerMembershipId: M.teamOwner, attendeeMembershipIds: [M.teamOwner] },
      targetPeriodIds: [week.id],
    });
    // Fixture surgery applies only to this file's fresh DB and avoids a clock-dependent wait.
    await h.db.sql`update planning_periods set cutoff_at = '2020-01-01T00:00:00Z' where id = ${week.id}`;
    expect((await recurrence.readiness(week.id)).missingCount).toBeGreaterThan(0);
    expect(await h.db.sql`select id from plan_baselines where period_id = ${week.id}`).toEqual([]);
    const before = await fullSnapshot(h);
    const expected = { ...ownerIdentity, ...await storedHead(h) };
    for (let index = 0; index < 5; index += 1) {
      expect(await head(h.owner)).toEqual(expected);
      expect(await head(h.viewer)).toEqual({ ...expected, actorUserId: U.viewer, membershipId: M.teamViewer, role: 'viewer' });
    }
    expect(await fullSnapshot(h)).toEqual(before);
    expect((await recurrence.readiness(week.id)).missingCount).toBeGreaterThan(0);
    expect(await h.db.sql`select id from plan_baselines where period_id = ${week.id}`).toEqual([]);
  });
});
