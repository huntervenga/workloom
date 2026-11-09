// Real PostgreSQL: custom fields, field writes and the weekly time summary through the public automation core.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createAutomationApplication, createLeaveApplication, createTaskApplication, createTaskFieldApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, type Database } from '@workloom/db';
import type { CommandContext } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
requireTestDatabaseUrl();

const must = <T>(value: T | null | undefined): T => { if (value === null || value === undefined) throw Error('Missing synthetic fixture'); return value; };
const WEEK = { from: '2026-11-02', to: '2026-11-08' } as const;

describe('public API custom fields and weekly time summary', () => {
  let target: ThrowawayDatabase | undefined, db: Database;
  beforeAll(async () => {
    target = await createThrowawayDatabase('public_fields');
    db = createDatabase(target.url, { requireLoopback: true, maxConnections: 8 });
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
  }, 90000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30000);

  async function fixture() {
    const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID(), viewer = randomUUID();
    await db.sql`insert into workspaces(id,name,timezone) values(${workspaceId},'Synthetic time workspace','UTC')`;
    for (const [id, userId, role] of [[owner, U.owner, 'owner'], [member, U.memberA, 'member'], [viewer, U.viewer, 'viewer']] as const)
      await db.sql`insert into memberships(id,workspace_id,user_id,role) values(${id},${workspaceId},${userId},${role})`;
    const ctx = (userId: string = U.owner): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Synthetic actor', kind: 'fixture' }, source: 'web', requestId: randomUUID(), idempotencyKey: randomUUID() });
    const tasks = createTaskApplication(db), fields = createTaskFieldApplication(db), leave = createLeaveApplication(db);
    const created = await tasks.createProject(ctx(), { name: 'Week 45' });
    const project = await tasks.updateProject(ctx(), created.id, { expectedRevision: created.revision, dateRange: WEEK });
    const field = (name: string, type: 'duration' | 'single_select', options: string[] = []) => fields.createField(ctx(), { projectId: project.id, name, type, historyEnabled: true, locked: false, options: options.map(option => ({ name: option, color: null })) });
    const estimation = await field('Estimation', 'duration'), fact = await field('Fact', 'duration'), kind = await field('Kind', 'single_select', ['Meeting', 'Development']);
    const todo = must((await tasks.listStatuses(ctx(), project.id)).find(status => status.group === 'todo'));
    const task = (title: string, responsibleMembershipId: string | null) => tasks.createTask(ctx(), { projectId: project.id, statusId: todo.id, title, responsibleMembershipId });
    const design = await task('Design review', member), build = await task('Build feature', member), mine = await task('Owner work', owner), loose = await task('Nobody', null);
    // Working schedules: the member works the workspace default (40 hours a week) and takes Wednesday off.
    const settings = await leave.template(ctx(), { expectedRevision: 0, effectiveYear: 2025, includeCompanyHolidays: false });
    const vacation = must(must(settings.policyVersions[0]).types.find(type => type.consumesBalance && type.carryover.mode === 'unlimited'));
    await leave.profile(ctx(), member, { expectedRevision: 0, reason: '', timezone: 'UTC', employmentStart: '2025-01-01', employmentEnd: null, accountingStart: '2025-01-01', openingBalances: [{ typeId: vacation.id, microdays: 20_000_000 }], schedulePeriods: [] });
    await leave.create(ctx(), { membershipId: member, typeId: vacation.id, startDate: '2026-11-04', endDate: '2026-11-04', note: '', reason: 'Synthetic retrospective entry' });
    const app = createAutomationApplication(db);
    const token = (userId: string, scopes: ('read' | 'tasks:write')[]) => app.issueToken(userId, { name: 'Synthetic fields token', scopes, workspaceIds: [workspaceId], expiresInDays: 1 });
    return { workspaceId, owner, member, ctx, tasks, fields, project, estimation, fact, kind, design, build, mine, loose, app, token, settings };
  }
  const counts = async () => (await db.sql`select (select count(*)::int from audit_events) audit,(select count(*)::int from task_field_values) values_`)[0];

  it('lists fields and shows friendly values on tasks', async () => {
    const f = await fixture(), t = await f.token(U.owner, ['read']);
    const list = await f.app.listFields(t.token, f.workspaceId, 'week 45');
    expect(list.map(field => [field.name, field.type])).toEqual(expect.arrayContaining([['Estimation', 'duration'], ['Fact', 'duration'], ['Kind', 'single_select']]));
    expect(list.find(field => field.name === 'Kind')?.options.map(option => option.name)).toEqual(['Meeting', 'Development']);
    await f.fields.setTaskValue(f.ctx(), f.design.id, f.fact.id, { expectedRevision: 0, expectedDefinitionRevision: f.fact.revision, value: { type: 'duration', value: 150 } });
    const view = await f.app.getTask(t.token, f.workspaceId, f.design.id, { includeFields: true });
    expect(view.fields?.find(field => field.name === 'Fact')).toMatchObject({ set: true, value: 150, hours: 2.5 });
    expect(view.fields?.find(field => field.name === 'Estimation')).toMatchObject({ set: false, value: null, hours: null });
    expect((await f.app.getTask(t.token, f.workspaceId, f.design.id)).fields).toBeUndefined();
    const page = await f.app.listTasks(t.token, f.workspaceId, { project: ['Week 45'], includeFields: true, sort: 'created', limit: 50 });
    expect(page.items.every(item => item.fields?.length === 3)).toBe(true);
  });

  it('previews without writing, writes by name, replays the same key and rejects a reused key', async () => {
    const f = await fixture(), t = await f.token(U.owner, ['read', 'tasks:write']);
    const body = { items: [
      { taskId: f.design.id, values: [{ field: 'Estimation', value: '2h' }, { field: 'fact', value: '1h 30m' }, { field: 'Kind', value: 'meeting' }] },
      { taskId: f.build.id, values: [{ field: 'Fact', value: 'soon' }, { field: 'Missing', value: 1 }, { field: 'Estimation', value: null }] },
    ] };
    const before = await counts();
    const preview = await f.app.setTaskFields(t.token, f.workspaceId, { ...body, dryRun: true }, { requestId: randomUUID() });
    expect(preview.dryRun).toBe(true);
    expect(preview.summary).toEqual({ changed: 3, unchanged: 1, failed: 2 });
    expect(preview.items[0]?.changes.map(change => [change.field, change.before, change.after, change.status])).toEqual([['Estimation', null, 120, 'changed'], ['Fact', null, 90, 'changed'], ['Kind', null, 'Meeting', 'changed']]);
    expect(preview.items[1]?.changes.map(change => change.error?.code)).toEqual(['VALIDATION_FAILED', 'VALIDATION_FAILED', undefined]);
    expect(await counts()).toEqual(before);

    const key = randomUUID();
    const written = await f.app.setTaskFields(t.token, f.workspaceId, body, { requestId: randomUUID(), idempotencyKey: key });
    expect(written.dryRun).toBe(false);
    expect(written.summary).toEqual({ changed: 3, unchanged: 1, failed: 2 });
    const values = await f.fields.listTaskValues(f.ctx(), f.design.id);
    const byField = new Map(values.map(row => [row.fieldId, row.value]));
    expect(byField.get(f.estimation.id)).toEqual({ type: 'duration', value: 120 });
    expect(byField.get(f.fact.id)).toEqual({ type: 'duration', value: 90 });
    expect(byField.get(f.kind.id)).toEqual({ type: 'single_select', value: must(f.kind.options.find(option => option.name === 'Meeting')).id });
    expect(values).toHaveLength(3);
    const afterWrite = await counts();
    expect(await f.app.setTaskFields(t.token, f.workspaceId, body, { requestId: randomUUID(), idempotencyKey: key })).toEqual(written);
    expect(await counts()).toEqual(afterWrite);
    await expect(f.app.setTaskFields(t.token, f.workspaceId, { items: [{ taskId: f.design.id, values: [{ field: 'Fact', value: '3h' }] }] }, { requestId: randomUUID(), idempotencyKey: key })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const again = await f.app.setTaskFields(t.token, f.workspaceId, { items: [{ taskId: f.design.id, values: [{ field: 'Fact', value: 90 }] }] }, { requestId: randomUUID() });
    expect(again.summary).toEqual({ changed: 0, unchanged: 1, failed: 0 });
  });

  it('keeps writes to the token scope and the caller role', async () => {
    const f = await fixture(), readOnly = await f.token(U.owner, ['read']), viewer = await f.token(U.viewer, ['read', 'tasks:write']);
    const body = { items: [{ taskId: f.design.id, values: [{ field: 'Fact', value: '1h' }] }] };
    await expect(f.app.setTaskFields(readOnly.token, f.workspaceId, body, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    await expect(f.app.setTaskFields(viewer.token, f.workspaceId, body, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    expect(await f.fields.listTaskValues(f.ctx(), f.design.id)).toEqual([]);
  });

  it('summarises plan and fact per person against expected hours minus time off', async () => {
    const f = await fixture(), w = await f.token(U.owner, ['read', 'tasks:write']);
    await f.app.setTaskFields(w.token, f.workspaceId, { items: [
      { taskId: f.design.id, values: [{ field: 'Estimation', value: '4h' }, { field: 'Fact', value: '5h' }] },
      { taskId: f.build.id, values: [{ field: 'Estimation', value: '20h' }, { field: 'Fact', value: '18h' }] },
      { taskId: f.mine.id, values: [{ field: 'Fact', value: '3h' }] },
      { taskId: f.loose.id, values: [{ field: 'Estimation', value: '1h' }] },
    ] }, { requestId: randomUUID() });
    const summary = await f.app.timeSummary(w.token, f.workspaceId, { project: 'Week 45' });
    expect(summary).toMatchObject({ from: WEEK.from, to: WEEK.to, rangeSource: 'project', planField: { name: 'Estimation' }, factField: { name: 'Fact' } });
    const member = must(summary.people.find(person => person.membershipId === f.member));
    // Five working days of 8 hours, minus the Wednesday off.
    expect(member).toMatchObject({ scheduleKnown: true, scheduledMinutes: 2400, absenceMinutes: 480, expectedMinutes: 1920, planMinutes: 1440, factMinutes: 1380, factGapMinutes: 540 });
    expect(member.tasks?.map(task => task.title).sort()).toEqual(['Build feature', 'Design review']);
    const owner = must(summary.people.find(person => person.membershipId === f.owner));
    expect(owner).toMatchObject({ scheduleKnown: false, expectedMinutes: null, factMinutes: 180, factGapMinutes: null });
    expect(summary.unassigned).toMatchObject({ planMinutes: 60, factMinutes: 0 });
    expect(summary.totals).toEqual({ expectedMinutes: 1920, planMinutes: 1440, factMinutes: 1560 });

    const narrowed = await f.app.timeSummary(w.token, f.workspaceId, { project: 'Week 45', people: ['me'], from: '2026-11-02', to: '2026-11-03', includeTasks: false });
    expect(narrowed.people.map(person => person.membershipId)).toEqual([f.owner]);
    expect(narrowed.people[0]?.tasks).toBeUndefined();
    await expect(f.app.timeSummary(w.token, f.workspaceId, { project: 'Week 45', factField: 'Kind' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
