// Isolated PostgreSQL: time is a property of every task, kept in each project's estimate and fact fields.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase, createGenericReportApplication, createProjectCopyApplication, createTaskApplication, createTaskFieldApplication,
  runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, type Database,
} from '@workloom/db';
import type { CommandContext } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
const ctx = (key: string = randomUUID()): CommandContext => ({ workspaceId: W.team, actor: { userId: U.owner, displayName: 'Synthetic owner', kind: 'fixture' }, source: 'web', requestId: randomUUID(), idempotencyKey: key });
const roles = (fields: readonly { name: string; timeRole?: string; archivedAt: string | null }[]) =>
  fields.filter(field => field.archivedAt === null && field.timeRole).map(field => [field.timeRole, field.name]).sort();

describe('time fields on isolated PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined;
  let db: Database;
  beforeAll(async () => {
    target = await createThrowawayDatabase('time_fields');
    db = createDatabase(target.url, { requireLoopback: true });
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
  }, 90_000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30_000);

  it('gives a new project its estimate and fact fields, which cannot be archived or doubled, and copies keep them', async () => {
    const tasks = createTaskApplication(db), fields = createTaskFieldApplication(db);
    const project = await tasks.createProject(ctx(), { name: `Timed ${randomUUID()}`, timeFields: true });
    const list = await fields.listFields(ctx(), project.id);
    expect(roles(list)).toEqual([['estimate', 'Hours Est'], ['fact', 'Hours Fact']]);
    expect(list.every(field => field.type === 'duration')).toBe(true);
    const columns = await fields.getProjectColumns(ctx(), project.id);
    expect(columns.columns.filter(column => column.visible).map(column => column.fieldId).sort()).toEqual(list.map(field => field.id).sort());

    const estimate = list.find(field => field.timeRole === 'estimate');
    if (!estimate) throw new Error('estimate field missing');
    await expect(fields.updateField(ctx(), estimate.id, { expectedRevision: estimate.revision, archived: true })).rejects.toMatchObject({ details: { fields: ['archived'] } });
    await expect(fields.createField(ctx(), { projectId: project.id, name: 'Second estimate', type: 'duration', historyEnabled: true, locked: false, options: [], timeRole: 'estimate' })).rejects.toMatchObject({ details: { fields: ['timeRole'] } });
    await expect(fields.createField(ctx(), { projectId: project.id, name: 'Text estimate', type: 'text', historyEnabled: true, locked: false, options: [], timeRole: 'fact' })).rejects.toMatchObject({ details: { fields: ['timeRole'] } });
    // Renaming is allowed: the role, not the name, says what the field is.
    await fields.updateField(ctx(), estimate.id, { expectedRevision: estimate.revision, name: 'Plan' });

    // Without the option a project is created as before (older callers).
    const plain = await tasks.createProject(ctx(), { name: `Plain ${randomUUID()}` });
    expect(await fields.listFields(ctx(), plain.id)).toEqual([]);

    // A copy has the same time fields once, with their names and roles.
    const copy = await createProjectCopyApplication(db).duplicateProject(ctx(), project.id, { name: `Timed copy ${randomUUID()}` });
    expect(roles(await fields.listFields(ctx(), copy.projectId))).toEqual([['estimate', 'Plan'], ['fact', 'Hours Fact']]);

    // The plan-and-fact report uses the time fields instead of adding another pair.
    const template = await createGenericReportApplication(db).template(ctx(), project.id, { planName: 'Other plan', factName: 'Other fact', reportName: 'Plan vs fact', expectedColumnsRevision: (await fields.getProjectColumns(ctx(), project.id)).revision });
    expect(template.fields.map(field => field.timeRole)).toEqual(['estimate', 'fact']);
    expect((await fields.listFields(ctx(), project.id)).filter(field => field.archivedAt === null)).toHaveLength(2);
  });

  it('migration 0044 gives existing projects their time fields: by name where they exist, created where they do not', async () => {
    const tasks = createTaskApplication(db), fields = createTaskFieldApplication(db);
    const week = await tasks.createProject(ctx(), { name: `Old week ${randomUUID()}` });
    for (const name of ['Hours Est', 'Hours Fact']) await fields.createField(ctx(), { projectId: week.id, name, type: 'duration', historyEnabled: true, locked: false, options: [] });
    const backlog = await tasks.createProject(ctx(), { name: `Old backlog ${randomUUID()}` });
    for (const name of ['Hours Est', 'Hours Fact']) await fields.createField(ctx(), { projectId: backlog.id, name, type: 'number', historyEnabled: true, locked: false, options: [] });
    const empty = await tasks.createProject(ctx(), { name: `Old empty ${randomUUID()}` });
    const weekFields = await fields.listFields(ctx(), week.id);

    // The two data statements of the migration, as they ran on the databases that existed before it.
    const file = readFileSync(fileURLToPath(new URL('../../packages/db/migrations/0044_time_fields.sql', import.meta.url)), 'utf8');
    const [assign, create] = file.split('--> statement-breakpoint').slice(3);
    for (let round = 0; round < 2; round += 1) {
      await db.sql.unsafe(assign ?? '');
      await db.sql.unsafe(create ?? '');
    }

    const weekAfter = await fields.listFields(ctx(), week.id);
    expect(roles(weekAfter)).toEqual([['estimate', 'Hours Est'], ['fact', 'Hours Fact']]);
    expect(weekAfter.map(field => field.id).sort()).toEqual(weekFields.map(field => field.id).sort());
    // The backlog keeps its number fields; the time fields take free names.
    const backlogAfter = await fields.listFields(ctx(), backlog.id);
    expect(roles(backlogAfter)).toEqual([['estimate', 'Estimate'], ['fact', 'Fact']]);
    expect(backlogAfter.filter(field => field.type === 'number').map(field => field.name).sort()).toEqual(['Hours Est', 'Hours Fact']);
    const emptyAfter = await fields.listFields(ctx(), empty.id);
    expect(roles(emptyAfter)).toEqual([['estimate', 'Hours Est'], ['fact', 'Hours Fact']]);
    // Created fields are complete: a visible column each, a first version, and values can be written.
    const columns = await fields.getProjectColumns(ctx(), empty.id);
    expect(columns.columns.map(column => column.fieldId).sort()).toEqual(emptyAfter.map(field => field.id).sort());
    expect(columns.columns.every(column => column.visible)).toBe(true);
    const todo = (await tasks.listStatuses(ctx(), empty.id)).find(status => status.group === 'todo');
    const task = await tasks.createTask(ctx(), { projectId: empty.id, title: 'Timed task', statusId: String(todo?.id) });
    const fact = emptyAfter.find(field => field.timeRole === 'fact');
    if (!fact) throw new Error('fact field missing');
    const saved = await fields.setTaskValue(ctx(), task.id, fact.id, { expectedRevision: 0, expectedDefinitionRevision: fact.revision, value: { type: 'duration', value: 90 } });
    expect(saved.value).toEqual({ type: 'duration', value: 90 });
  });
});
