import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskTableBuiltinColumnSchema, updatePersonalTablePreferenceInputSchema, type ColumnChoice } from '@workloom/contracts';
import type { CommandContext } from '@workloom/domain';
import type { WorkloomExecutor } from '../src/client.js';
import { FIXTURE_MEMBERSHIP_IDS as M, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W } from '../src/fixtures.js';
import { MIGRATIONS_FOLDER, readExpectedMigrations, runMigrations } from '../src/migrations.js';
import { createReadinessProbe } from '../src/readiness.js';
import { createPlanningApplication } from '../src/planning/planning-application.js';
import { createRecurrenceApplication } from '../src/recurrence/recurrence-application.js';
import { createPersonalTablePreferenceApplication } from '../src/table-preferences/application.js';
import { createPersonalTablePreferenceRepository } from '../src/table-preferences/repository.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support.js';
import { createLegacyProject, createLegacyTask, createLegacyTextField, legacyActor, seedLegacyIdentities, snapshotLegacyRows } from './legacy-fixtures.js';
const id = (n: number) => `ce000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = (userId: string = U.viewer, key = randomUUID(), workspaceId: string = W.team): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Untrusted label', kind: 'fixture' }, source: 'web', requestId: 'personal-columns-pg', idempotencyKey: key });
const title: ColumnChoice = { column: { kind: 'builtin', key: 'title' }, visible: true };
const fieldChoice = (fieldId: string, visible = true): ColumnChoice => ({ column: { kind: 'field', fieldId }, visible });
async function snapshot(target: ThrowawayDatabase, tables?: readonly string[]): Promise<Record<string, string>> {
  const names = tables ?? (await target.database.sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name`).map(row => row.table_name);
  const result: Record<string, string> = {};
  for (const name of names) {
    if (!/^[a-z_]+$/.test(name)) throw new Error('Unsafe synthetic snapshot table.');
    const [row] = await target.database.sql.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from "${name}" t`); result[name] = row?.digest ?? '';
  }
  return result;
}
describe('own personal columns on an isolated PostgreSQL database', () => {
  let target: ThrowawayDatabase, projectId: string, otherProjectId: string, archivedField: string, activeField: string, foreignProjectField: string, foreignWorkspaceField: string, statusId: string;
  let upgrade: { applied: readonly string[]; oldRowsUnchanged: boolean; oldHistoryUnchanged: boolean; pendingNotReady: boolean; ready: boolean };
  const app = () => createPersonalTablePreferenceApplication(target.database);
  const choices = (): ColumnChoice[] => [title, fieldChoice(archivedField, false), { column: { kind: 'builtin', key: 'tags' }, visible: false }, fieldChoice(activeField)];
  beforeAll(async () => {
    target = await createThrowawayDatabase('preferences'); process.stdout.write(`PREFERENCES_DISPOSABLE_DB=${target.name}\n`);
    const prior = mkdtempSync(join(tmpdir(), 'workloom-preferences-prior-migrations-'));
    try {
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      journal.entries = journal.entries.slice(0, journal.entries.findIndex(entry => entry.tag === '0012_personal_table_preferences'));
      mkdirSync(join(prior, 'meta')); writeFileSync(join(prior, 'meta', '_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries) copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(prior, `${entry.tag}.sql`));
      await runMigrations(target.url, { requireLoopback: true, migrationsFolder: prior });
    } finally { rmSync(prior, { recursive: true, force: true }); }
    await seedLegacyIdentities(target.database.sql);
    const owner = legacyActor(W.team, U.owner), outsider = legacyActor(W.outside, U.outsider);
    const project = await createLegacyProject(target.database.sql, owner, 'Personal columns fixture'); projectId = project.id;
    otherProjectId = (await createLegacyProject(target.database.sql, owner, 'Other team project')).id;
    const outside = await createLegacyProject(target.database.sql, outsider, 'Outside columns project');
    statusId = project.todoStatusId;
    await createLegacyTask(target.database.sql, owner, { projectId, statusId, title: 'Existing unchanged task' });
    archivedField = (await createLegacyTextField(target.database.sql, owner, projectId, 'Archived personal choice', true)).id;
    activeField = (await createLegacyTextField(target.database.sql, owner, projectId, 'Active personal choice')).id;
    foreignProjectField = (await createLegacyTextField(target.database.sql, owner, otherProjectId, 'Other project field')).id;
    foreignWorkspaceField = (await createLegacyTextField(target.database.sql, outsider, outside.id, 'Outside field')).id;
    const oldRows = await snapshotLegacyRows(target.database.sql), oldHistory = await target.database.sql`select * from drizzle.__drizzle_migrations order by created_at`, pendingNotReady = !(await createReadinessProbe(target.database).check()).ready;
    const result = await runMigrations(target.url, { requireLoopback: true }), afterHistory = await target.database.sql`select * from drizzle.__drizzle_migrations order by created_at`;
    upgrade = { applied: result.appliedNow, oldRowsUnchanged: JSON.stringify(await snapshotLegacyRows(target.database.sql, oldRows)) === JSON.stringify(oldRows), oldHistoryUnchanged: JSON.stringify(afterHistory.slice(0, oldHistory.length)) === JSON.stringify(oldHistory), pendingNotReady, ready: (await createReadinessProbe(target.database).check()).ready };
  }, 60_000);
  afterAll(async () => { await target?.drop(); });

  it('upgrades populated pre-0012 data/history without backfill and gates readiness', () => { expect(upgrade).toEqual({ applied: readExpectedMigrations().slice(readExpectedMigrations().findIndex(migration => migration.tag === '0012_personal_table_preferences')).map(migration => migration.tag), oldRowsUnchanged: true, oldHistoryUnchanged: true, pendingNotReady: true, ready: true }); });

  it('returns own revision-zero/default state without any GET writes or row synthesis', async () => {
    const before = await snapshot(target);
    expect(await app().getPreference(context(), projectId)).toEqual({ workspaceId: W.team, projectId, membershipId: M.teamViewer, revision: 0, columns: null });
    expect(await snapshot(target)).toEqual(before);
    const [count] = await target.database.sql`select count(*)::int as n from personal_table_preferences`; expect(count?.n).toBe(0);
  });

  it('lets a viewer configure a readable archived project and retain owned archived field choices', async () => {
    await target.database.sql`update projects set archived_at=now() where id=${projectId}`;
    try {
      const before = await snapshot(target, ['tasks', 'work_packages', 'task_participants', 'task_field_definitions', 'project_column_settings', 'project_columns', 'work_logs', 'work_log_revisions']);
      const saved = await app().setPreference(context(), projectId, { expectedRevision: 0, columns: choices() });
      expect(saved).toMatchObject({ membershipId: M.teamViewer, revision: 1, columns: choices() });
      expect(await app().getPreference(context(), projectId)).toEqual(saved);
      expect(await snapshot(target, Object.keys(before))).toEqual(before);
      expect(await app().getPreference(context(U.owner), projectId)).toMatchObject({ membershipId: M.teamOwner, revision: 0, columns: null });
    } finally { await target.database.sql`update projects set archived_at=null where id=${projectId}`; }
  });

  it('keeps resets versioned and replays an older exact receipt without restoring an old head', async () => {
    const service = app(), ctx = context(U.owner), first = await service.setPreference(ctx, projectId, { expectedRevision: 0, columns: [title] });
    expect((await service.setPreference(context(U.owner), projectId, { expectedRevision: 1, columns: null })).revision).toBe(2);
    expect((await service.setPreference(context(U.owner), projectId, { expectedRevision: 2, columns: null })).revision).toBe(3);
    const before = await snapshot(target);
    expect(await service.setPreference(ctx, projectId, { expectedRevision: 0, columns: [title] })).toEqual(first);
    expect(await service.getPreference(ctx, projectId)).toMatchObject({ revision: 3, columns: null }); expect(await snapshot(target)).toEqual(before);
    await expect(service.setPreference(context(U.owner), projectId, { expectedRevision: 0, columns: null })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(service.setPreference(ctx, projectId, { expectedRevision: 0, columns: null })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('serializes same-key retries once and rejects one concurrent stale revision with different keys', async () => {
    const service = app(), ctx = context(U.memberC);
    const [a, b] = await Promise.all([service.setPreference(ctx, projectId, { expectedRevision: 0, columns: [title] }), service.setPreference(ctx, projectId, { expectedRevision: 0, columns: [title] })]); expect(a).toEqual(b); expect(a.revision).toBe(1);
    const outcomes = await Promise.allSettled([service.setPreference(context(U.memberB), projectId, { expectedRevision: 0, columns: [title] }), service.setPreference(context(U.memberB), projectId, { expectedRevision: 0, columns: null })]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === 'rejected'); expect(rejected).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ code: 'REVISION_CONFLICT' }) });
    const [row] = await target.database.sql`select count(*)::int as n from command_idempotency where workspace_id=${W.team} and actor_user_id=${U.memberC} and command='table.preference.set'`; expect(row?.n).toBe(1);
  });

  it('rechecks current actor/project/field scope before replay and rejects foreign/missing columns without writes', async () => {
    const service = app(), ctx = context(U.admin), body = { expectedRevision: 0, columns: choices() }; await service.setPreference(ctx, projectId, body);
    await target.database.sql`update memberships set state='revoked',revoked_at=now(),revision=revision+1 where id=${M.teamAdmin}`;
    try { const before = await snapshot(target); await expect(service.setPreference(ctx, projectId, body)).rejects.toMatchObject({ code: 'NOT_FOUND' }); await expect(service.getPreference(ctx, projectId)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(await snapshot(target)).toEqual(before); }
    finally { await target.database.sql`update memberships set state='active',revoked_at=null,revision=revision+1 where id=${M.teamAdmin}`; }
    const before = await snapshot(target);
    for (const fieldId of [foreignProjectField, foreignWorkspaceField, id(999)]) await expect(service.setPreference(context(), projectId, { expectedRevision: 1, columns: [title, fieldChoice(fieldId)] })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    await expect(service.getPreference(context(U.outsider, randomUUID(), W.outside), projectId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.setPreference(context(), id(999), { expectedRevision: 0, columns: null })).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(await snapshot(target)).toEqual(before);
  });

  it('recovers an application return lost after actual PostgreSQL commit by exact unchanged retry', async () => {
    const db = target.database.db;
    const lost = new Proxy(db, { get(original, key, receiver) { if (key !== 'transaction') return Reflect.get(original, key, receiver) as unknown; return async (...args: Parameters<typeof original.transaction>) => { await original.transaction(...args); throw Object.assign(new Error('Injected post-commit response loss'), { code: 'ECONNRESET' }); }; } }) as WorkloomExecutor;
    const ctx = context(U.memberA), input = { expectedRevision: 0, columns: choices() };
    await expect(createPersonalTablePreferenceApplication(lost).setPreference(ctx, projectId, input)).rejects.toBeDefined();
    const before = await snapshot(target); expect(await app().setPreference(ctx, projectId, input)).toMatchObject({ revision: 1, columns: input.columns }); expect(await snapshot(target)).toEqual(before);
  });

  it.each(['personal_table_preferences', 'audit_events', 'outbox_events', 'command_idempotency'])('rolls back head/events/receipt/sequence after a fault at %s', async table => {
    await target.database.sql.unsafe(`create function preference_test_fault() returns trigger language plpgsql as $$ begin raise exception 'Injected preference transaction fault'; end; $$`);
    await target.database.sql.unsafe(`create trigger preference_test_fault after insert or update on "${table}" for each row execute function preference_test_fault()`);
    try { const before = await snapshot(target), current = await app().getPreference(context(), projectId); await expect(app().setPreference(context(), projectId, { expectedRevision: current.revision, columns: null })).rejects.toThrow(); expect(await snapshot(target)).toEqual(before); }
    finally { await target.database.sql.unsafe(`drop trigger preference_test_fault on "${table}"`); await target.database.sql`drop function preference_test_fault()`; }
  });

  it('enforces JSON structural constraints, independent custom bound and composite FKs', async () => {
    const rows: unknown[] = [];
    const rest = taskTableBuiltinColumnSchema.options.filter(key => key !== 'title');
    for (let bits = 0; bits < 1 << rest.length; bits++) rows.push([title, ...rest.map((_, n) => ({ column: { kind: 'builtin', key: rest[(n + bits) % rest.length] }, visible: Boolean(bits & 1 << n) }))]);
    const builtin = taskTableBuiltinColumnSchema.options.map(key => ({ column: { kind: 'builtin', key }, visible: true }));
    rows.push([...builtin, ...Array.from({ length: 200 }, (_, n) => fieldChoice(id(n + 1)))]);
    rows.push(null, {}, 'malformed', [title, ...Array.from({ length: 201 }, (_, n) => fieldChoice(id(n + 1)))], [], [{ ...title, visible: false }], [title, title], [fieldChoice(id(1)), title], [title, { column: { kind: 'builtin', key: 'arbitrary' }, visible: true }], [title, { column: { kind: 'field', fieldId: id(1).toUpperCase() }, visible: true }], [title, { column: { kind: 'field', fieldId: 'bad' }, visible: true }], [title, { column: null, visible: true }], [title, null]);
    const checked = await target.database.sql<{ n: string; valid: boolean }[]>`select ordinal::text as n, public.workloom_valid_personal_table_columns(value) as valid from jsonb_array_elements(${JSON.stringify(rows)}::jsonb) with ordinality as fixture(value,ordinal) order by ordinal`;
    for (const [n, row] of rows.entries()) {
      // SQL storage requires canonical IDs; HTTP canonicalizes valid uppercase IDs before storage.
      const parsed = updatePersonalTablePreferenceInputSchema.safeParse({ expectedRevision: 0, columns: row });
      const canonical = row !== null && parsed.success && JSON.stringify(parsed.data.columns) === JSON.stringify(row);
      expect(checked[n]?.valid, `structural case ${n}`).toBe(canonical);
    }
    await expect(target.database.sql`insert into personal_table_preferences(workspace_id,project_id,membership_id,revision,columns,updated_at) values(${W.outside},${projectId},${M.outsideOwner},1,null,now())`).rejects.toMatchObject({ code: '23503' });
    await expect(target.database.sql`insert into personal_table_preferences(workspace_id,project_id,membership_id,revision,columns,updated_at) values(${W.team},${projectId},${M.outsideOwner},1,null,now())`).rejects.toMatchObject({ code: '23503' });
    await expect(target.database.sql`insert into personal_table_preferences(workspace_id,project_id,membership_id,revision,columns,updated_at) values(${W.team},${otherProjectId},${M.teamViewer},0,null,now())`).rejects.toMatchObject({ code: '23514' });
    await expect(target.database.sql`insert into personal_table_preferences(workspace_id,project_id,membership_id,revision,columns,updated_at) values(${W.team},${otherProjectId},${M.teamViewer},1,'[]'::jsonb,now())`).rejects.toMatchObject({ code: '23514' });
    await expect(target.database.sql`insert into personal_table_preferences(workspace_id,project_id,membership_id,revision,columns,updated_at) values(${W.team},${otherProjectId},${M.teamViewer},1,'null'::jsonb,now())`).rejects.toMatchObject({ code: '23514' });
    await expect(createPersonalTablePreferenceRepository(target.database.db).ownFieldIds(W.team, projectId, Array.from({ length: 201 }, (_, n) => id(n + 1)))).rejects.toThrow('bounded to 200');
  });

  it('keeps audit/outbox metadata-only and uses one actual readonly RR snapshot without GET writes', async () => {
    const events = await target.database.sql`select diff from audit_events where entity_type='personal_table_preference'`, outbox = await target.database.sql`select payload from outbox_events where type='personal_table_preference.updated'`;
    for (const payload of [...events.map(row => row.diff), ...outbox.map(row => row.payload)]) { expect(Object.keys(payload as object).every(key => ['workspaceId','projectId','membershipId','revision'].includes(key))).toBe(true); }
    const db = target.database.db; let inspected = false;
    const read = new Proxy(db, { get(original, key, receiver) { if (key !== 'transaction') return Reflect.get(original, key, receiver) as unknown; return async <R>(work: (tx: WorkloomExecutor) => Promise<R>, options: { isolationLevel: 'repeatable read'; accessMode: 'read only' }) => original.transaction(async tx => {
      expect(options).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
      const settings = await tx.execute(sql`select current_setting('transaction_read_only') as read_only, current_setting('transaction_isolation') as isolation`); expect(settings[0]).toMatchObject({ read_only: 'on', isolation: 'repeatable read' }); inspected = true;
      await tx.execute(sql`select id from memberships where id=${M.teamViewer}`);
      await target.database.sql`update memberships set state='revoked',revoked_at=now(),revision=revision+1 where id=${M.teamViewer}`;
      return work(tx);
    }, options); } }) as WorkloomExecutor;
    try { expect((await createPersonalTablePreferenceApplication(read).getPreference(context(), projectId)).revision).toBe(1); await expect(app().getPreference(context(), projectId)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(inspected).toBe(true); }
    finally { await target.database.sql`update memberships set state='active',revoked_at=null,revision=revision+1 where id=${M.teamViewer}`; }
    const before = await snapshot(target); await app().getPreference(context(), projectId); expect(await snapshot(target)).toEqual(before);
  });

  it('changes only own display metadata across an overdue blocked recurrence calendar', async () => {
    const planning = createPlanningApplication(target.database), recurrence = createRecurrenceApplication(target.database), owner = context(U.owner);
    const period = await planning.createPeriod(owner, { projectId, name: 'Preference inertness fixture', localStart: '2027-01-04', timezone: 'UTC', cutoffAt: '2030-01-01T00:00:00.000Z', protectedFieldIds: [], protectEstimate: false });
    const input = { schedule: { startDate: '2027-01-04', localTime: '10:00', timezone: 'UTC', frequency: 'daily' as const, plannedDurationMinutes: 30, end: { kind: 'after_count' as const, count: 1 } }, template: { title: 'Blocked display-independent occurrence', statusId, organizerMembershipId: M.teamOwner, attendeeMembershipIds: [M.teamOwner] }, targetPeriodIds: [period.id] };
    const preview = await recurrence.previewCreate(owner, projectId, input); await recurrence.createSeries(context(U.owner), projectId, { ...input, previewHash: preview.previewHash });
    await target.database.sql`update planning_periods set cutoff_at='2020-01-01T00:00:00Z' where id=${period.id}`; await target.database.sql`update memberships set state='revoked',revoked_at=now(),revision=revision+1 where id=${M.teamOwner}`;
    try {
      expect((await recurrence.getReadiness(context(), period.id)).state).toBe('blocked');
      const all = Object.keys(await snapshot(target)), inert = all.filter(name => !['personal_table_preferences','audit_events','outbox_events','command_idempotency','workspaces'].includes(name)), before = await snapshot(target, inert);
      const [epoch] = await target.database.sql`select permission_epoch from workspaces where id=${W.team}`;
      const current = await app().getPreference(context(), projectId); await app().setPreference(context(), projectId, { expectedRevision: current.revision, columns: choices() });
      expect(await snapshot(target, inert)).toEqual(before); expect((await target.database.sql`select permission_epoch from workspaces where id=${W.team}`)[0]?.permission_epoch).toEqual(epoch?.permission_epoch); expect((await recurrence.getReadiness(context(), period.id)).state).toBe('blocked');
    } finally { await target.database.sql`update memberships set state='active',revoked_at=null,revision=revision+1 where id=${M.teamOwner}`; }
  });
});
