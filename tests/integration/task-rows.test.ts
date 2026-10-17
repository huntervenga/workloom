// Real PostgreSQL: atomic table-row creation through the DB factory on this file's own disposable child database.
// Task, package, sibling positions, custom values, value history, personal plan, period actual, audit/outbox and the
// one `task.row.create` receipt commit together. Late errors roll back everything; classified locks may commit only freezes and their rejection receipt.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateTaskRowInput, TaskDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { isDomainError, type CommandContext, type PlanningApplication, type TaskApplication, type TaskFieldApplication, type TaskRowApplication, type WorkCategoryApplication } from '@workloom/domain';
import {
  createDatabase, createPlanningApplication, createTaskApplication, createTaskFieldApplication, createWorkCategoryApplication,
  runMigrations, seedDemoData, FIXTURE_MEMBERSHIP_IDS as M, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, type Database,
} from '@workloom/db';
import { createTaskRowApplication } from '../../packages/db/src/task-rows/task-row-application.js';
import { databaseSnapshot, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';

requireTestDatabaseUrl();
const ctx = (userId: string = U.owner, key: string = randomUUID()): CommandContext => ({
  workspaceId: W.team, actor: { userId, displayName: 'Synthetic task row', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: key,
});
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected task-row fixture.');
  return value;
}

describe('atomic task-row creation on owned disposable PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined;
  let db: Database;
  let tasks: TaskApplication, fields: TaskFieldApplication, planning: PlanningApplication, categories: WorkCategoryApplication, rows: TaskRowApplication;

  beforeAll(async () => {
    target = await createThrowawayDatabase('task_rows');
    db = createDatabase(target.url, { requireLoopback: true });
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
    tasks = createTaskApplication(db);
    fields = createTaskFieldApplication(db);
    planning = createPlanningApplication(db);
    categories = createWorkCategoryApplication(db);
    rows = createTaskRowApplication(db);
  }, 60_000);
  afterAll(async () => { await db?.close(); await target?.drop(); }, 30_000);

  async function rejection(run: () => Promise<unknown>): Promise<{ code: string; details: unknown }> {
    try { await run(); } catch (error) { if (isDomainError(error)) return { code: error.code, details: error.details }; throw error; }
    throw new Error('Expected a domain rejection.');
  }
  /** Whole-database evidence: no row, audit, outbox, receipt or change_seq may change. */
  async function rejectsUnchanged(code: string, run: () => Promise<unknown>) {
    const before = await databaseSnapshot(db.sql);
    const error = await rejection(run);
    expect(error.code).toBe(code);
    expect(await databaseSnapshot(db.sql)).toEqual(before);
    return error;
  }
  async function project(label: string) {
    const created = await tasks.createProject(ctx(), { name: `${label} ${randomUUID().slice(0, 8)}` });
    const todo = required((await tasks.listStatuses(ctx(), created.id)).find((s) => s.group === 'todo'));
    return { project: created, todo };
  }
  async function week(projectId: string, cutoffAt?: string) {
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return planning.createPeriod(ctx(), {
      projectId, name: 'Неделя строки', localStart: monday.toISOString().slice(0, 10), timezone: 'UTC',
      cutoffAt: cutoffAt ?? new Date(Date.now() + 6 * 3_600_000).toISOString(), protectedFieldIds: [], protectEstimate: true,
    });
  }
  async function field(projectId: string, fieldId: string): Promise<TaskFieldDefinitionDto> {
    return required((await fields.listFields(ctx(), projectId)).find((f) => f.id === fieldId));
  }
  async function titled(projectId: string, title: string): Promise<number> {
    const [row] = await db.sql<{ count: number }[]>`select count(*)::int as count from tasks where workspace_id=${W.team} and project_id=${projectId} and title=${title}`;
    return required(row).count;
  }
  async function count(table: 'period_commitments' | 'work_logs' | 'task_field_values' | 'work_packages', column: string, value: string): Promise<number> {
    const [row] = await db.sql<{ count: number }[]>`select count(*)::int as count from ${db.sql(table)} where workspace_id=${W.team} and ${db.sql(column)}=${value}`;
    return required(row).count;
  }

  it('creates task, typed values, an explicit self plan and a zero actual with its custom category in one receipt, and replays exactly once', async () => {
    const { project: p, todo } = await project('Строка таблицы');
    const kind = await fields.createField(ctx(), { projectId: p.id, name: 'Тип работы', type: 'single_select', historyEnabled: true, locked: false, options: [{ name: 'Разработка', color: null }] });
    const amount = await fields.createField(ctx(), { projectId: p.id, name: 'Количество', type: 'number', historyEnabled: true, locked: false, options: [] });
    const binding = await categories.getBinding(ctx(), p.id);
    await categories.updateBinding(ctx(), p.id, { expectedRevision: binding.revision, fieldId: kind.id });
    const [k, n] = [await field(p.id, kind.id), await field(p.id, amount.id)];
    const option = required(k.options[0]), period = await week(p.id), key = randomUUID();
    const input: CreateTaskRowInput = {
      task: { projectId: p.id, statusId: todo.id, title: 'Строка с фактом', estimateMinutes: 480, participantMembershipIds: [M.teamOwner] },
      fields: [
        { fieldId: k.id, expectedDefinitionRevision: k.revision, value: { type: 'single_select', value: option.id } },
        { fieldId: n.id, expectedDefinitionRevision: n.revision, value: { type: 'number', value: 0 } },
      ],
      plan: { periodId: period.id, membershipId: M.teamOwner, expectedRevision: null, plannedMinutes: 240 },
      actual: { periodId: period.id, membershipId: M.teamOwner, minutes: 0 },
    };
    const result = await rows.createRow(ctx(U.owner, key), input);
    const task = result.task;
    expect(task).toMatchObject({ projectId: p.id, title: 'Строка с фактом', estimateMinutes: 480, parentTaskId: null });
    expect(result.fields.map((v) => [v.fieldId, v.value, v.revision])).toEqual([[k.id, { type: 'single_select', value: option.id }, 1], [n.id, { type: 'number', value: 0 }, 1]]);
    expect(result.plan).toMatchObject({ periodId: period.id, workPackageId: task.workPackageId, membershipId: M.teamOwner, plannedMinutes: 240, allocations: [], unallocatedMinutes: 240, state: 'active', revision: 1 });
    // A recorded 0 is a fact, distinct from no fact; its category comes from the custom value written in the same TX.
    expect(result.actual).toMatchObject({ taskId: task.id, workPackageId: task.workPackageId, periodId: period.id, membershipId: M.teamOwner, minutes: 0, state: 'active', reason: null, precision: 'period' });
    expect(result.actual?.category).toMatchObject({ kind: 'categorized', fieldId: k.id, optionId: option.id });
    expect(await titled(p.id, 'Строка с фактом')).toBe(1);
    expect(await count('task_field_values', 'task_id', task.id)).toBe(2);
    expect(await count('period_commitments', 'work_package_id', task.workPackageId)).toBe(1);
    expect(await count('work_logs', 'task_id', task.id)).toBe(1);

    const before = await databaseSnapshot(db.sql);
    expect(await rows.createRow(ctx(U.owner, key), input)).toEqual(result);
    expect(await databaseSnapshot(db.sql)).toEqual(before);
    await rejectsUnchanged('IDEMPOTENCY_KEY_REUSED', () => rows.createRow(ctx(U.owner, key), { ...input, task: { ...input.task, title: 'Другая строка' } }));

    // Absent actual writes no fact; a null plan is an explicit unknown plan, not a missing one.
    const bare = await rows.createRow(ctx(), { task: { projectId: p.id, statusId: todo.id, title: 'Строка без факта' }, plan: { periodId: period.id, membershipId: M.teamOwner, expectedRevision: null, plannedMinutes: null } });
    expect(bare.fields).toEqual([]);
    expect(bare.actual).toBeUndefined();
    expect(bare.plan).toMatchObject({ plannedMinutes: null, unallocatedMinutes: null, workPackageId: bare.task.workPackageId });
    expect(await count('work_logs', 'task_id', bare.task.id)).toBe(0);
  });

  it('rejects stale and locked fields before writing, and rolls back task, package and sibling renumbering on late value or receipt failure', async () => {
    const { project: p, todo } = await project('Откат строки');
    const kind = await fields.createField(ctx(), { projectId: p.id, name: 'Этап', type: 'single_select', historyEnabled: true, locked: false, options: [{ name: 'Активный', color: null }, { name: 'Старый', color: null }] });
    const note = await fields.createField(ctx(), { projectId: p.id, name: 'Заметка', type: 'text', historyEnabled: true, locked: false, options: [] });
    const first = await tasks.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Первая' });
    const second = await tasks.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Вторая' });
    const period = await week(p.id);
    const old = required((await field(p.id, kind.id)).options.find((o) => o.name === 'Старый'));
    const archived = await fields.updateOption(ctx(), kind.id, old.id, { expectedRevision: (await field(p.id, kind.id)).revision, archived: true });
    const base = (title: string): CreateTaskRowInput['task'] => ({ projectId: p.id, statusId: todo.id, title, insertion: { anchorTaskId: first.id, placement: 'before' } });
    const n = await field(p.id, note.id);

    await rejectsUnchanged('REVISION_CONFLICT', () => rows.createRow(ctx(), { task: base('Устаревшее поле'), fields: [{ fieldId: n.id, expectedDefinitionRevision: n.revision + 1, value: { type: 'text', value: 'x' } }] }));
    // Late failure: the task is inserted before the anchor (renumbering siblings) and only then the archived option is refused.
    await rejectsUnchanged('DOMAIN_VALIDATION_FAILED', () => rows.createRow(ctx(), {
      task: base('Поздний отказ значения'),
      fields: [{ fieldId: n.id, expectedDefinitionRevision: n.revision, value: { type: 'text', value: 'до отказа' } }, { fieldId: kind.id, expectedDefinitionRevision: archived.revision, value: { type: 'single_select', value: old.id } }],
      actual: { periodId: period.id, membershipId: M.teamOwner, minutes: 30 },
    }));
    expect((await tasks.getTask(ctx(), first.id)).position).toBe(first.position);
    expect((await tasks.getTask(ctx(), second.id)).position).toBe(second.position);

    // Unexpected failure at the very last statement (the receipt) rolls back every proposed write; exact retry then commits once.
    const key = randomUUID();
    const input: CreateTaskRowInput = { task: base('Сбой квитанции'), fields: [{ fieldId: n.id, expectedDefinitionRevision: n.revision, value: { type: 'text', value: '' } }], plan: { periodId: period.id, membershipId: M.teamOwner, expectedRevision: null, plannedMinutes: 60 }, actual: { periodId: period.id, membershipId: M.teamOwner, minutes: 45, reason: 'Синтетический факт' } };
    await db.sql.unsafe("create function qa_task_row_fault() returns trigger language plpgsql as $$ begin raise exception 'qa_task_row_fault'; end $$");
    await db.sql.unsafe('create trigger qa_task_row_fault before insert on command_idempotency for each row execute function qa_task_row_fault()');
    try {
      const before = await databaseSnapshot(db.sql);
      const hasFault = (error: unknown): boolean => {
        let current: unknown = error;
        for (let i = 0; i < 8 && current && typeof current === 'object'; i += 1) {
          if ('message' in current && typeof current.message === 'string' && current.message.includes('qa_task_row_fault')) return true;
          current = 'cause' in current ? current.cause : null;
        }
        return false;
      };
      expect(await rows.createRow(ctx(U.owner, key), input).then(() => false, hasFault)).toBe(true);
      expect(await databaseSnapshot(db.sql)).toEqual(before);
    } finally {
      await db.sql.unsafe('drop trigger qa_task_row_fault on command_idempotency');
      await db.sql.unsafe('drop function qa_task_row_fault()');
    }
    const created = await rows.createRow(ctx(U.owner, key), input);
    expect(created.actual).toMatchObject({ minutes: 45, reason: 'Синтетический факт' });
    expect(await rows.createRow(ctx(U.owner, key), input)).toEqual(created);
    expect(await titled(p.id, 'Сбой квитанции')).toBe(1);
    expect(await count('work_logs', 'task_id', created.task.id)).toBe(1);
    const ordered = await db.sql<{ id: string }[]>`select id from tasks where workspace_id=${W.team} and project_id=${p.id} order by position,id`;
    expect(ordered.map(row => row.id)).toEqual([created.task.id, first.id, second.id]);

    await fields.updateField(ctx(), note.id, { expectedRevision: (await field(p.id, note.id)).revision, locked: true });
    const locked = await field(p.id, note.id), lockedKey = randomUUID();
    const lockedInput: CreateTaskRowInput = { task: base('Закрытое поле'), fields: [{ fieldId: locked.id, expectedDefinitionRevision: locked.revision, value: { type: 'text', value: 'y' } }] };
    const packageCount = await count('work_packages', 'project_id', p.id);
    const blocked = await rejection(() => rows.createRow(ctx(U.owner, lockedKey), lockedInput));
    expect(blocked).toMatchObject({ code: 'FIELD_LOCKED', details: { committed: true } });
    expect(await titled(p.id, 'Закрытое поле')).toBe(0);
    expect(await count('work_packages', 'project_id', p.id)).toBe(packageCount);
    await rejectsUnchanged('FIELD_LOCKED', () => rows.createRow(ctx(U.owner, lockedKey), lockedInput));
  });

  it('plans a detail child on its parent whole package: explicit revision, preserved allocations, never duplicated or restored', async () => {
    const { project: p, todo } = await project('Деталь строки');
    const parent = await tasks.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Родитель', estimateMinutes: 480, participantMembershipIds: [M.teamOwner] });
    const period = await week(p.id);
    const c = await planning.createCommitment(ctx(), period.id, { workPackageId: parent.workPackageId, membershipId: M.teamOwner, expectedAbsent: true, plannedMinutes: 240, allocations: [{ taskId: parent.id, minutes: 120 }] });
    const child = (title: string, extra: Partial<CreateTaskRowInput['task']> = {}): CreateTaskRowInput['task'] => ({ projectId: p.id, statusId: todo.id, title, parentTaskId: parent.id, ...extra });
    const plan = (expectedRevision: number | null, plannedMinutes: number | null) => ({ periodId: period.id, membershipId: M.teamOwner, expectedRevision, plannedMinutes });
    const packages = await count('work_packages', 'project_id', p.id);

    await rejectsUnchanged('REVISION_CONFLICT', () => rows.createRow(ctx(), { task: child('Без ревизии'), plan: plan(null, 300) }));
    await rejectsUnchanged('REVISION_CONFLICT', () => rows.createRow(ctx(), { task: child('Чужая ревизия'), plan: plan(c.revision + 1, 300) }));
    // Late plan failure (after the child exists in the TX): the whole-package total cannot drop below its allocations.
    await rejectsUnchanged('DOMAIN_VALIDATION_FAILED', () => rows.createRow(ctx(), { task: child('Ниже распределения'), plan: plan(c.revision, 100) }));
    await rejectsUnchanged('DOMAIN_VALIDATION_FAILED', () => rows.createRow(ctx(), { task: child('Новый пакет с ревизией', { workScope: 'added_scope' }), plan: plan(c.revision, 60) }));

    const made = await rows.createRow(ctx(), { task: child('Деталь'), plan: plan(c.revision, 300) });
    expect(made.task).toMatchObject({ parentTaskId: parent.id, workPackageId: parent.workPackageId, estimateMinutes: 480, workPackageRevision: parent.workPackageRevision });
    expect(made.plan).toMatchObject({ id: c.id, workPackageId: parent.workPackageId, plannedMinutes: 300, allocations: [{ taskId: parent.id, minutes: 120 }], unallocatedMinutes: 180, state: 'active', revision: c.revision + 1 });
    expect(await count('work_packages', 'project_id', p.id)).toBe(packages);
    expect(await count('period_commitments', 'work_package_id', parent.workPackageId)).toBe(1);
    expect(await tasks.getTask(ctx(), parent.id)).toMatchObject({ estimateMinutes: 480, workPackageRevision: parent.workPackageRevision });
    await rejectsUnchanged('REVISION_CONFLICT', () => rows.createRow(ctx(), { task: child('Устаревшая ревизия'), plan: plan(c.revision, 360) }));

    const removed = await planning.updateCommitment(ctx(), period.id, c.id, { expectedRevision: c.revision + 1, plannedMinutes: 300, allocations: [{ taskId: parent.id, minutes: 120 }], state: 'removed' });
    await rejectsUnchanged('DOMAIN_VALIDATION_FAILED', () => rows.createRow(ctx(), { task: child('После удаления'), plan: plan(removed.revision, 300) }));
    await rejectsUnchanged('DOMAIN_VALIDATION_FAILED', () => rows.createRow(ctx(), { task: child('После удаления заново'), plan: plan(null, 300) }));
  });

  it('rejects cross-project periods, viewers and other-person plan/time without the capability, and rechecks access before replay', async () => {
    const { project: p, todo } = await project('Права строки');
    const other = await project('Чужой период');
    const foreign = await week(other.project.id), period = await week(p.id);
    const task = (title: string) => ({ projectId: p.id, statusId: todo.id, title });
    await rejectsUnchanged('DOMAIN_VALIDATION_FAILED', () => rows.createRow(ctx(), { task: task('Чужой план'), plan: { periodId: foreign.id, membershipId: M.teamOwner, expectedRevision: null, plannedMinutes: 60 } }));
    await rejectsUnchanged('DOMAIN_VALIDATION_FAILED', () => rows.createRow(ctx(), { task: task('Чужой факт'), actual: { periodId: foreign.id, membershipId: M.teamOwner, minutes: 60 } }));
    await rejectsUnchanged('CAPABILITY_REQUIRED', () => rows.createRow(ctx(U.viewer), { task: task('Наблюдатель') }));
    await rejectsUnchanged('CAPABILITY_REQUIRED', () => rows.createRow(ctx(U.memberA), { task: task('План другого'), plan: { periodId: period.id, membershipId: M.teamOwner, expectedRevision: null, plannedMinutes: 60 } }));
    await rejectsUnchanged('CAPABILITY_REQUIRED', () => rows.createRow(ctx(U.memberA), { task: task('Факт другого'), actual: { periodId: period.id, membershipId: M.teamOwner, minutes: 60 } }));

    const key = randomUUID();
    const input: CreateTaskRowInput = { task: task('Своя строка'), plan: { periodId: period.id, membershipId: M.teamMemberA, expectedRevision: null, plannedMinutes: 90 }, actual: { periodId: period.id, membershipId: M.teamMemberA, minutes: 30 } };
    const own = await rows.createRow(ctx(U.memberA, key), input);
    expect(own.plan?.membershipId).toBe(M.teamMemberA);
    const saved = await membershipRow(db.sql, W.team, M.teamMemberA);
    try {
      await revokeMembership(db.sql, W.team, M.teamMemberA);
      await rejectsUnchanged('NOT_FOUND', () => rows.createRow(ctx(U.memberA, key), input));
    } finally {
      await restoreMembership(db.sql, W.team, M.teamMemberA, saved);
    }
    expect(await rows.createRow(ctx(U.memberA, key), input)).toEqual(own);
  });

  it('commits only the due cutoff freeze and a tagged rejection when the shared package plan is locked, with no proposed row', async () => {
    const { project: p, todo } = await project('Cutoff строки');
    const parent: TaskDto = await tasks.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Родитель cutoff', estimateMinutes: 240, participantMembershipIds: [M.teamOwner] });
    const [clock] = await db.sql<{ at: string }[]>`select (clock_timestamp() + interval '4 seconds')::text as at`;
    const cutoffAt = new Date(required(clock).at).toISOString();
    const period = await week(p.id, cutoffAt);
    const c = await planning.createCommitment(ctx(), period.id, { workPackageId: parent.workPackageId, membershipId: M.teamOwner, expectedAbsent: true, plannedMinutes: 120, allocations: [] });
    await db.sql`select pg_sleep(greatest(0, extract(epoch from (${cutoffAt}::text::timestamptz - clock_timestamp()))) + 0.05)`;

    const key = randomUUID(), title = 'Строка после cutoff';
    const input: CreateTaskRowInput = { task: { projectId: p.id, statusId: todo.id, title, parentTaskId: parent.id }, plan: { periodId: period.id, membershipId: M.teamOwner, expectedRevision: c.revision, plannedMinutes: 180 } };
    const error = await rejection(() => rows.createRow(ctx(U.owner, key), input));
    expect(error.code).toBe('FIELD_LOCKED');
    expect(error.details).toMatchObject({ committed: true });
    expect(await titled(p.id, title)).toBe(0);
    const [stored] = await db.sql<{ planned: number | null; revision: number }[]>`select planned_minutes as planned, revision from period_commitments where id=${c.id}`;
    expect(stored).toEqual({ planned: 120, revision: c.revision });
    const [frozen] = await db.sql<{ count: number }[]>`select count(*)::int as count from plan_baselines where period_id=${period.id}`;
    expect(required(frozen).count).toBeGreaterThan(0);
    const replay = await rejectsUnchanged('FIELD_LOCKED', () => rows.createRow(ctx(U.owner, key), input));
    expect(replay.details).toEqual(error.details);
  }, 30_000);

  it('classifies a manual custom-field lock after cutoff and commits only the freeze and rejection receipt, never any row values', async () => {
    const { project: p, todo } = await project('Custom lock cutoff');
    const parent = await tasks.createTask(ctx(), { projectId: p.id, statusId: todo.id, title: 'Stable parent', estimateMinutes: 240 });
    const note = await fields.createField(ctx(), { projectId: p.id, name: 'Locked note', type: 'text', historyEnabled: true, locked: false, options: [] });
    await fields.updateField(ctx(), note.id, { expectedRevision: note.revision, locked: true });
    const locked = await field(p.id, note.id);
    const [clock] = await db.sql<{ at: string }[]>`select (clock_timestamp() + interval '4 seconds')::text as at`;
    const cutoffAt = new Date(required(clock).at).toISOString();
    const period = await week(p.id, cutoffAt);
    await planning.createCommitment(ctx(), period.id, { workPackageId: parent.workPackageId, membershipId: M.teamOwner, expectedAbsent: true, plannedMinutes: 120, allocations: [] });
    await db.sql`select pg_sleep(greatest(0, extract(epoch from (${cutoffAt}::text::timestamptz - clock_timestamp()))) + 0.05)`;
    const beforeTask = await tasks.getTask(ctx(), parent.id);
    const proposals = async () => Promise.all([
      count('work_packages', 'project_id', p.id), count('task_field_values', 'project_id', p.id),
      count('period_commitments', 'project_id', p.id), count('work_logs', 'project_id', p.id),
    ]);
    const before = await proposals(), key = randomUUID();
    const input: CreateTaskRowInput = {
      task: { projectId: p.id, statusId: todo.id, title: 'Must never exist', insertion: { anchorTaskId: parent.id, placement: 'before' } },
      // The manual lock must win even over a stale definition revision, matching the existing field command.
      fields: [{ fieldId: locked.id, expectedDefinitionRevision: locked.revision + 1, value: { type: 'text', value: 'Not stored' } }],
      plan: { periodId: period.id, membershipId: M.teamOwner, expectedRevision: null, plannedMinutes: 60 },
      actual: { periodId: period.id, membershipId: M.teamOwner, minutes: 15 },
    };
    const blocked = await rejection(() => rows.createRow(ctx(U.owner, key), input));
    expect(blocked).toMatchObject({ code: 'FIELD_LOCKED', details: { committed: true } });
    expect(await titled(p.id, 'Must never exist')).toBe(0);
    expect(await proposals()).toEqual(before);
    expect(await tasks.getTask(ctx(), parent.id)).toEqual(beforeTask);
    const [frozen] = await db.sql<{ count: number }[]>`select count(*)::int as count from plan_baselines where period_id=${period.id}`;
    expect(required(frozen).count).toBeGreaterThan(0);
    const [receipt] = await db.sql<{ result: unknown }[]>`select result from command_idempotency where workspace_id=${W.team} and command='task.row.create' and idempotency_key=${key}`;
    expect(required(receipt).result).toMatchObject({ __workloomPlanningOutcome: 'rejected', code: 'FIELD_LOCKED' });
    await rejectsUnchanged('FIELD_LOCKED', () => rows.createRow(ctx(U.owner, key), input));
  }, 30_000);
});
