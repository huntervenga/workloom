// Owner-only historical facts use an owned throwaway database; never the application database.
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@workloom/contracts';
import { createDatabase, createLeaveApplication, createSharedAuthStore, runMigrations, type Database } from '@workloom/db';
import type { CommandContext, LeaveApplication } from '@workloom/domain';
import { registerLeaveRoutes } from '../../apps/api/src/http/leave-routes.js';
import { mapError } from '../../apps/api/src/http/errors.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { databaseSnapshot } from './support/p1b.js';
requireTestDatabaseUrl();
const add = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const must = <T>(value: T | null | undefined): T => { if (value === null || value === undefined) throw new Error('Missing synthetic history fixture.'); return value; };
describe('owner-only leave history facts', () => {
  let target: ThrowawayDatabase | undefined, db: Database, leave: LeaveApplication, today: string, year: number;
  beforeAll(async () => { target = await createThrowawayDatabase('leave_history'); await runMigrations(target.url, { requireLoopback: true }); db = createDatabase(target.url, { requireLoopback: true }); leave = createLeaveApplication(db); const [clock] = await db.sql`select (clock_timestamp() at time zone 'UTC')::date::text as today`; today = String(clock?.today); year = Number(today.slice(0, 4)); }, 60000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30000);
  async function fixture() {
    const identity = await createSharedAuthStore(db).provisionIdentity({ issuer: 'https://auth.example.test', subject: randomUUID(), displayName: 'Synthetic history owner', workspaceName: 'Synthetic history workspace', timezone: 'UTC' });
    const workspaceId = identity.workspaceId, userId = identity.user.id;
    const [member] = await db.sql`select id from memberships where workspace_id=${workspaceId} and user_id=${userId}`; const membershipId = String(member?.id);
    const ctx = (key = randomUUID()): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Synthetic history owner', kind: 'real' }, source: 'import', requestId: randomUUID(), idempotencyKey: key });
    const template = await leave.template(ctx(), { expectedRevision: 0, effectiveYear: year - 1, includeCompanyHolidays: true });
    const policy = must(template.policyVersions[0]), vacation = must(policy.types.find(type => type.consumesBalance && type.carryover.mode === 'unlimited'));
    // Zero entitlement makes debt behavior independent of execution date while keeping allowNegative false.
    const configured = await leave.settings(ctx(), { expectedRevision: 1, timezone: 'UTC', defaultWeeklyMinutes: template.defaultWeeklyMinutes, policyVersions: template.policyVersions.map(version => ({ ...version, types: version.types.map(type => ({ ...type, annualEntitlementMicrodays: 0 })) })), reason: 'Synthetic zero-entitlement fixture' });
    const profile: C.PutLeaveProfileInput = { expectedRevision: 0, timezone: 'UTC', employmentStart: `${year - 1}-01-01`, employmentEnd: null, accountingStart: `${year - 1}-01-01`, openingBalances: [], schedulePeriods: [], reason: '' };
    await leave.profile(ctx(), membershipId, profile);
    const firstMonday = must(Array.from({ length: 7 }, (_, i) => add(`${year - 1}-01-02`, i)).find(date => new Date(date + 'T00:00:00Z').getUTCDay() === 1));
    const input: C.PreviewLeaveHistoryInput = { source: { sha256: 'a'.repeat(64), sheet: 'Vacations' }, reason: 'Import verified synthetic historical facts', rows: [{ sourceRows: [2], membershipId, typeId: vacation.id, startDate: firstMonday, endDate: add(firstMonday, 11), note: 'Synthetic source note' }] };
    return { workspaceId, userId, membershipId, ctx, profile, vacation, configured, input };
  }
  async function apply(f: Awaited<ReturnType<typeof fixture>>, input = f.input, context = f.ctx()) { const preview = await leave.previewHistory(context, input); return { result: await leave.importHistory(context, { ...input, expectedSourceVersion: preview.sourceVersion }), preview, context, body: { ...input, expectedSourceVersion: preview.sourceVersion } }; }
  it('records past debt without granting negative policy, emits immutable versions/ledger and keeps old strict HTTP shapes', async () => {
    const f = await fixture(), before = await databaseSnapshot(db.sql), preview = await leave.previewHistory(f.ctx(), f.input);
    expect(await databaseSnapshot(db.sql)).toEqual(before); expect(preview.rows[0]?.totalMicrodays).toBe(10_000_000); expect(preview.rows[0]?.chargedDays).toHaveLength(10);
    const context = f.ctx(), body = { ...f.input, expectedSourceVersion: preview.sourceVersion }, result = await leave.importHistory(context, body), request = must(result[0]);
    expect(request.status).toBe('approved'); expect(request.negativeApproved).toBe(false); expect(request.historicalImport).toMatchObject({ sourceFileSha256: f.input.source.sha256, sheet: 'Vacations', sourceRows: [2] });
    expect(must((await leave.overview(f.ctx())).balances.find(balance => balance.typeId === f.vacation.id)).availableMicrodays).toBe(-10_000_000);
    expect(must((await leave.overview(f.ctx())).settings).policyVersions[0]?.types.find(type => type.id === f.vacation.id)?.allowNegative).toBe(false);
    const [ledger] = await db.sql`select count(*)::int as n,sum(delta_microdays)::text as total from leave_charge_ledger where request_id=${request.id}`; expect(ledger).toEqual({ n: 10, total: '10000000' });
    const versions = await db.sql`select snapshot from leave_request_versions where request_id=${request.id} order by revision`; expect(versions).toHaveLength(1); expect(versions[0]?.snapshot.historicalImport).toEqual(request.historicalImport);
    const stable = await databaseSnapshot(db.sql); expect(await leave.importHistory(context, body)).toEqual(result); expect(await databaseSnapshot(db.sql)).toEqual(stable);
    await expect(leave.importHistory(f.ctx(), body)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    await expect(leave.previewHistory(f.ctx(), f.input)).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    const updated = await leave.update(f.ctx(), request.id, { expectedRevision: 1, startDate: request.startDate, endDate: request.endDate, note: 'Reasoned note correction', reason: 'Correct source note only' });
    expect(C.leaveRequestSchema.safeParse(updated).success).toBe(true); expect(updated).not.toHaveProperty('historicalImport');
    const [stored] = await db.sql`select snapshot from leave_requests where id=${request.id}`; expect(stored?.snapshot.historicalImport).toEqual(request.historicalImport);
    const app = Fastify(); app.setErrorHandler((error, _request, reply) => { const mapped = mapError(error); return reply.code(mapped.statusCode).send(mapped.body); });
    registerLeaveRoutes(app, { leave, identity: { mode: 'shared', resolveActor: async () => f.ctx().actor } });
    try { const response = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${f.workspaceId}/time-off/overview` }); expect(response.statusCode).toBe(200); const publicBody = response.json(); expect(C.leaveOverviewResponseSchema.safeParse(publicBody).success).toBe(true); expect(JSON.stringify(publicBody)).not.toContain('historicalImport'); expect(JSON.stringify(publicBody)).not.toContain(f.input.source.sha256); } finally { await app.close(); }
    const futureExtension = { expectedRevision: 2, startDate: request.startDate, endDate: add(today, 10), note: '', reason: 'Attempt future extension' };
    await expect(leave.update(f.ctx(), request.id, futureExtension)).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    const futureWorkingDay = must(Array.from({ length: 7 }, (_, i) => add(today, 10 + i)).find(date => ![0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay())));
    await expect(leave.create(f.ctx(), { membershipId: f.membershipId, typeId: f.vacation.id, startDate: futureWorkingDay, endDate: futureWorkingDay, note: '', reason: '' }).then(pending => leave.decide(f.ctx(), pending.id, { expectedRevision: pending.revision, decision: 'approve', reason: '', approveNegative: false }))).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
  });
  it('requires current real owner and import source again before exact receipt replay', async () => {
    const f = await fixture(), imported = await apply(f), stable = await databaseSnapshot(db.sql);
    for (const context of [{ ...imported.context, source: 'web' as const }, { ...imported.context, actor: { ...imported.context.actor, kind: 'fixture' as const } }]) await expect(leave.importHistory(context, imported.body)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    expect(await databaseSnapshot(db.sql)).toEqual(stable);
    await db.sql`update memberships set role='admin',revision=revision+1 where id=${f.membershipId}`;
    await expect(leave.importHistory(imported.context, imported.body)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    await db.sql`update memberships set role='owner',revision=revision+1 where id=${f.membershipId}`;
    await db.sql`update users set kind='fixture' where id=${f.userId}`;
    await expect(leave.importHistory(imported.context, imported.body)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    await db.sql`update users set kind='real' where id=${f.userId}`;
    await db.sql`update memberships set state='revoked',revoked_at=now(),revision=revision+1 where id=${f.membershipId}`;
    await expect(leave.importHistory(imported.context, imported.body)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects future dates, stale source, reused rows and overlapping batches before writes', async () => {
    const f = await fixture(), before = await databaseSnapshot(db.sql);
    await expect(leave.previewHistory(f.ctx(), { ...f.input, rows: [{ ...must(f.input.rows[0]), endDate: add(today, 1) }] })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    await expect(leave.previewHistory(f.ctx(), { ...f.input, rows: [...f.input.rows, { ...must(f.input.rows[0]), sourceRows: [3] }] })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    expect(() => leave.previewHistory(f.ctx(), { ...f.input, rows: [...f.input.rows, { ...must(f.input.rows[0]), sourceRows: [2] }] })).toThrow();
    await expect(leave.previewHistory(f.ctx(), { ...f.input, rows: [{ ...must(f.input.rows[0]), membershipId: randomUUID() }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await databaseSnapshot(db.sql)).toEqual(before);
    const preview = await leave.previewHistory(f.ctx(), f.input), correction = { ...f.profile, expectedRevision: 1, reason: 'Refresh a source profile revision' }, profilePreview = await leave.previewProfile(f.ctx(), f.membershipId, correction);
    await leave.profile(f.ctx(), f.membershipId, { ...correction, expectedSourceVersion: profilePreview.sourceVersion }); const afterCorrection = await databaseSnapshot(db.sql);
    await expect(leave.importHistory(f.ctx(), { ...f.input, expectedSourceVersion: preview.sourceVersion })).rejects.toMatchObject({ code: 'PREVIEW_STALE' }); expect(await databaseSnapshot(db.sql)).toEqual(afterCorrection);
    const imported = await apply(f), reused = { ...f.input, rows: [{ ...must(f.input.rows[0]), startDate: add(must(f.input.rows[0]).startDate, 30), endDate: add(must(f.input.rows[0]).endDate, 30) }] };
    await expect(leave.previewHistory(f.ctx(), reused)).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    const afterImport = await databaseSnapshot(db.sql); await expect(leave.importHistory(imported.context, { ...imported.body, reason: 'Different body with same key' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' }); expect(await databaseSnapshot(db.sql)).toEqual(afterImport);
  });
  it('permits unchanged/improving profile corrections after history while deeper real debt remains rejected', async () => {
    const f = await fixture(); await apply(f);
    for (const opening of [0, 2_000_000]) { const current = must((await leave.overview(f.ctx())).profiles[0]), input = { ...f.profile, expectedRevision: current.revision, openingBalances: [{ typeId: f.vacation.id, microdays: opening }], reason: 'Replace provisional imported profile with reviewed balances' }, preview = await leave.previewProfile(f.ctx(), f.membershipId, input); await leave.profile(f.ctx(), f.membershipId, { ...input, expectedSourceVersion: preview.sourceVersion }); }
    const current = must((await leave.overview(f.ctx())).profiles[0]), worsening = { ...f.profile, expectedRevision: current.revision, openingBalances: [], reason: 'Would deepen known debt' }, preview = await leave.previewProfile(f.ctx(), f.membershipId, worsening), before = await databaseSnapshot(db.sql);
    await expect(leave.profile(f.ctx(), f.membershipId, { ...worsening, expectedSourceVersion: preview.sourceVersion })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' }); expect(await databaseSnapshot(db.sql)).toEqual(before);
  });
  it('rolls a second-row late audit failure back with all ledgers/versions/outbox/receipts and retries the exact command', async () => {
    const f = await fixture(), row = must(f.input.rows[0]), input = { ...f.input, rows: [row, { ...row, sourceRows: [3], startDate: add(row.startDate, 30), endDate: add(row.endDate, 30) }] }, preview = await leave.previewHistory(f.ctx(), input), context = f.ctx(), body = { ...input, expectedSourceVersion: preview.sourceVersion };
    await db.sql.unsafe(`create function qa_leave_history_fail() returns trigger language plpgsql as $$ begin if NEW.entity_type='leave_request' and NEW.workspace_id='${f.workspaceId}'::uuid and (select count(*) from leave_requests where workspace_id=NEW.workspace_id)>=2 then raise exception 'synthetic second-row audit fault'; end if; return NEW; end $$`);
    await db.sql.unsafe('create trigger qa_leave_history_fail before insert on audit_events for each row execute function qa_leave_history_fail()');
    const before = await databaseSnapshot(db.sql);
    try { await expect(leave.importHistory(context, body)).rejects.toThrow(); expect(await databaseSnapshot(db.sql)).toEqual(before); } finally { await db.sql.unsafe('drop trigger qa_leave_history_fail on audit_events'); await db.sql.unsafe('drop function qa_leave_history_fail()'); }
    expect(await leave.importHistory(context, body)).toHaveLength(2);
  });
});
