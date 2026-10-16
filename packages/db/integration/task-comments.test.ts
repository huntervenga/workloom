import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandContext } from '@workloom/domain';
import type { WorkloomExecutor } from '../src/client.js';
import { FIXTURE_MEMBERSHIP_IDS as M, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W } from '../src/fixtures.js';
import { MIGRATIONS_FOLDER, readExpectedMigrations, runMigrations } from '../src/migrations.js';
import { createReadinessProbe } from '../src/readiness.js';
import { seedDemoData } from '../src/seed/demo-seed.js';
import { createTaskApplication } from '../src/tasks/task-application.js';
import { createPlanningApplication } from '../src/planning/planning-application.js';
import { createRecurrenceApplication } from '../src/recurrence/recurrence-application.js';
import { createTaskCommentsApplication } from '../src/task-comments/application.js';
import { createTaskCommentsRepository } from '../src/task-comments/repository.js';
import { runWorkspaceWrite } from '../src/transactions/workspace-write.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support.js';
const id = (n: number) => `cd000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = (userId: string = U.memberA, key = randomUUID(), workspaceId: string = W.team): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Untrusted context label', kind: 'fixture' }, source: 'web', requestId: 'comment-pg', idempotencyKey: key });
const secret = 'synthetic-task-discussion-cursor-key-thirty-two-bytes';
async function snapshot(target: ThrowawayDatabase, tables?: readonly string[]): Promise<Record<string, string>> {
  const names = tables ?? (await target.database.sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`).map(row => row.table_name);
  const result: Record<string, string> = {};
  for (const name of names) {
    if (!/^[a-z_]+$/.test(name)) throw new Error('Unsafe synthetic snapshot table.');
    const [row] = await target.database.sql.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) as digest from "${name}" t`);
    result[name] = row?.digest ?? '';
  }
  return result;
}

describe('append-only discussion and safe activity on owned disposable PostgreSQL', () => {
  let target: ThrowawayDatabase, projectId: string, taskId: string, otherTaskId: string, statusId: string;
  let migrationEvidence: { pendingWasNotReady: boolean; applied: readonly string[]; oldRowsUnchanged: boolean; oldHistoryUnchanged: boolean; ready: boolean };
  const app = () => createTaskCommentsApplication(target.database, { secret });
  beforeAll(async () => {
    target = await createThrowawayDatabase('comments');
    process.stdout.write(`COMMENTS_DISPOSABLE_DB=${target.name}\n`);
    const prior = mkdtempSync(join(tmpdir(), 'workloom-comments-prior-migrations-'));
    try {
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      journal.entries = journal.entries.slice(0, journal.entries.findIndex(entry => entry.tag === '0011_task_comments'));
      mkdirSync(join(prior, 'meta'));
      writeFileSync(join(prior, 'meta', '_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries) copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(prior, `${entry.tag}.sql`));
      await runMigrations(target.url, { requireLoopback: true, migrationsFolder: prior });
    } finally { rmSync(prior, { recursive: true, force: true }); }
    await seedDemoData(target.database);
    const tasks = createTaskApplication(target.database), owner = context(U.owner);
    const project = await tasks.createProject(owner, { name: 'Synthetic discussion project' }); projectId = project.id;
    const status = (await tasks.listStatuses(owner, projectId)).find(row => row.group === 'todo'); if (!status) throw new Error('Synthetic todo required.'); statusId = status.id;
    taskId = (await tasks.createTask(context(U.owner), { projectId, statusId, title: 'First discussion task' })).id;
    otherTaskId = (await tasks.createTask(context(U.owner), { projectId, statusId, title: 'Second discussion task' })).id;
    const oldRows = await snapshot(target), oldHistory = await target.database.sql`select * from drizzle.__drizzle_migrations order by created_at`;
    const pendingWasNotReady = !(await createReadinessProbe(target.database).check()).ready;
    const migrated = await runMigrations(target.url, { requireLoopback: true });
    const afterHistory = await target.database.sql`select * from drizzle.__drizzle_migrations order by created_at`;
    migrationEvidence = { pendingWasNotReady, applied: migrated.appliedNow, oldRowsUnchanged: JSON.stringify(await snapshot(target, Object.keys(oldRows))) === JSON.stringify(oldRows), oldHistoryUnchanged: JSON.stringify(afterHistory.slice(0, oldHistory.length)) === JSON.stringify(oldHistory), ready: (await createReadinessProbe(target.database).check()).ready };

  }, 60_000);
  afterAll(async () => { await target?.drop(); });

  it('upgrades a populated pre-comments schema without changing any old rows/history and gates readiness', () => {
    expect(migrationEvidence).toEqual({ pendingWasNotReady: true, applied: readExpectedMigrations().slice(11).map(migration => migration.tag), oldRowsUnchanged: true, oldHistoryUnchanged: true, ready: true });
  });

  it('stores exact plaintext and immutable trusted author/time, with no body in audit/outbox', async () => {
    const body = '  <img src=x onerror=alert(1)>\r\nLiteral plaintext  ';
    const before = await snapshot(target, ['tasks', 'work_packages', 'task_participants', 'work_logs', 'work_log_revisions']);
    const result = await app().createComment(context(), taskId, { body });
    expect(result).toMatchObject({ workspaceId: W.team, taskId, body, authorUserId: U.memberA, authorMembershipId: M.teamMemberA, authorDisplayNameSnapshot: 'Synthetic Member A' });
    expect(Number.isFinite(Date.parse(result.createdAt))).toBe(true);
    expect((await app().listComments(context(U.viewer), taskId, {})).items).toContainEqual(result);
    const events = await target.database.sql`select diff from audit_events where entity_type = 'task_comment' and entity_id = ${result.id}`;
    const outbox = await target.database.sql`select payload from outbox_events where type = 'task_comment.created' and payload->>'commentId' = ${result.id}`;
    expect(JSON.stringify([...events, ...outbox])).not.toContain(body);
    expect(events).toHaveLength(1); expect(outbox).toHaveLength(1);
    expect(await snapshot(target, Object.keys(before))).toEqual(before);
  });

  it('serializes concurrent exact retries and detects changed body/target without another write', async () => {
    const service = app(), ctx = context(), before = await target.database.sql`select change_seq from workspaces where id = ${W.team}`;
    const [a, b] = await Promise.all([service.createComment(ctx, taskId, { body: 'Concurrent exact command' }), service.createComment(ctx, taskId, { body: 'Concurrent exact command' })]);
    expect(a).toEqual(b);
    const [count] = await target.database.sql`select count(*)::int as n from task_comments where id = ${a.id}`; expect(count?.n).toBe(1);
    const [after] = await target.database.sql`select change_seq from workspaces where id = ${W.team}`; expect(BigInt(after?.change_seq as string)).toBe(BigInt(before[0]?.change_seq as string) + 1n);
    const saved = await snapshot(target);
    expect(await service.createComment(ctx, taskId, { body: 'Concurrent exact command' })).toEqual(a);
    await expect(service.createComment(ctx, taskId, { body: 'Changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(service.createComment(ctx, otherTaskId, { body: 'Concurrent exact command' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await snapshot(target)).toEqual(saved);
  });

  it('recovers exact retry after a failure injected after actual PostgreSQL commit', async () => {
    const db = target.database.db;
    const lostReturn = new Proxy(db, { get(original, key, receiver) {
      if (key !== 'transaction') return Reflect.get(original, key, receiver) as unknown;
      return async (...args: Parameters<typeof original.transaction>) => { await original.transaction(...args); throw Object.assign(new Error('Injected lost post-commit response'), { code: 'ECONNRESET' }); };
    } }) as WorkloomExecutor;
    const ctx = context(), body = 'Confirmed in PostgreSQL; caller lost the answer';
    await expect(createTaskCommentsApplication(lostReturn, { secret }).createComment(ctx, taskId, { body })).rejects.toBeDefined();
    const [committed] = await target.database.sql`select id from task_comments where body = ${body}`; expect(committed).toBeDefined();
    const beforeRetry = await snapshot(target);
    expect((await app().createComment(ctx, taskId, { body })).id).toBe(committed?.id);
    expect(await snapshot(target)).toEqual(beforeRetry);
  });

  it.each(['task_comments', 'audit_events', 'outbox_events', 'command_idempotency'])('rolls back comment/events/receipt/sequence when failure follows insert into %s', async table => {
    await target.database.sql.unsafe(`create function comment_test_fault() returns trigger language plpgsql as $$ begin raise exception 'Injected comment transaction fault'; end; $$`);
    await target.database.sql.unsafe(`create trigger comment_test_fault after insert on "${table}" for each row execute function comment_test_fault()`);
    try {
      const before = await snapshot(target);
      await expect(app().createComment(context(), taskId, { body: `Atomic rollback ${table}` })).rejects.toThrow();
      expect(await snapshot(target)).toEqual(before);
    } finally { await target.database.sql.unsafe(`drop trigger comment_test_fault on "${table}"`); await target.database.sql`drop function comment_test_fault()`; }
  });

  it('reauthorizes current membership/task before exact receipt and before decoding a bad cursor', async () => {
    const ctx = context(), row = await app().createComment(ctx, taskId, { body: 'Access may later be revoked' });
    await target.database.sql`update memberships set state='revoked', revoked_at=now(), revision=revision+1 where id=${M.teamMemberA}`;
    try {
      const before = await snapshot(target);
      await expect(app().createComment(ctx, taskId, { body: row.body })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(app().listComments(ctx, taskId, { cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await snapshot(target)).toEqual(before);
    } finally { await target.database.sql`update memberships set state='active', revoked_at=null, revision=revision+1 where id=${M.teamMemberA}`; }
    await expect(app().listActivity(context(U.outsider, randomUUID(), W.outside), taskId, { cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(app().createComment(context(U.viewer), taskId, { body: 'Viewer cannot write' })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    const empty = await app().listComments(context(U.viewer), otherTaskId, {}); expect(empty.items).toEqual([]);
  });

  it('enforces same-workspace author/task FKs and real append-only update/delete/truncate triggers', async () => {
    const row = await app().createComment(context(), taskId, { body: 'Immutable row' }), repo = createTaskCommentsRepository(target.database.db);
    await expect(repo.insertComment({ ...row, id: randomUUID(), workspaceId: W.outside })).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
    await expect(repo.insertComment({ ...row, id: randomUUID(), authorUserId: U.memberB })).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
    const before = await snapshot(target);
    for (const statement of [`update task_comments set body='changed' where id='${row.id}'`, `delete from task_comments where id='${row.id}'`, 'truncate task_comments']) await expect(target.database.sql.unsafe(statement)).rejects.toMatchObject({ code: '23001' });
    expect(await snapshot(target)).toEqual(before);
  });

  it('paginates same-time comments without duplicates and binds cursors to feed/task/actor/epoch/limit', async () => {
    const fixed = '2026-01-01T00:00:00.000Z', repo = createTaskCommentsRepository(target.database.db);
    for (const n of [1, 2, 3]) await repo.insertComment({ id: id(n), workspaceId: W.team, taskId: otherTaskId, authorUserId: U.memberA, authorMembershipId: M.teamMemberA, authorDisplayNameSnapshot: 'Synthetic Member A', createdAt: fixed, body: `Tie ${n}` });
    const service = app(), ctx = context(U.viewer), first = await service.listComments(ctx, otherTaskId, { limit: 1 }), ids = first.items.map(row => row.id);
    expect(ids).toEqual([id(3)]);
    let cursor = first.nextCursor;
    while (cursor) { const page = await service.listComments(ctx, otherTaskId, { limit: 1, cursor }); ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor; }
    expect(ids).toEqual([id(3), id(2), id(1)]);
    for (const attempt of [() => service.listComments(ctx, taskId, { limit: 1, cursor: first.nextCursor as string }), () => service.listComments(context(), otherTaskId, { limit: 1, cursor: first.nextCursor as string }), () => service.listComments(ctx, otherTaskId, { limit: 2, cursor: first.nextCursor as string }), () => service.listActivity(ctx, otherTaskId, { limit: 1, cursor: first.nextCursor as string })]) await expect(attempt()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await target.database.sql`update workspaces set permission_epoch=permission_epoch+1 where id=${W.team}`;
    await expect(service.listComments(ctx, otherTaskId, { limit: 1, cursor: first.nextCursor as string })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('projects only reviewed activity summaries before limiting, with current labels distinct from comment snapshots', async () => {
    const original = await app().createComment(context(), taskId, { body: 'Historical author name' });
    await runWorkspaceWrite(target.database, context(), 'task.edit', async scope => {
      for (const action of ['updated', 'archived', 'restored', 'schedule_updated', 'private_internal_action', 'another_private_action']) await scope.recordChange({ entityType: 'task', entityId: taskId, action, diff: { confidential: 'secret raw diff' }, reason: 'secret reason' });
      await scope.recordChange({ entityType: 'project', entityId: taskId, action: 'updated', diff: { confidential: 'secret other entity' } });
    });
    await target.database.sql`update users set display_name='Current renamed author' where id=${U.memberA}`;
    try {
      const service = app(), ctx = context(U.viewer), first = await service.listActivity(ctx, taskId, { limit: 1 });
      expect(first.items[0]).toMatchObject({ kind: 'schedule_updated', actorDisplayName: 'Current renamed author' });
      const collected = [...first.items]; let cursor = first.nextCursor;
      while (cursor) { const page = await service.listActivity(ctx, taskId, { limit: 1, cursor }); collected.push(...page.items); cursor = page.nextCursor; }
      expect(collected.map(row => row.kind)).toEqual(['schedule_updated', 'restored', 'archived', 'updated', 'created']);
      expect(new Set(collected.map(row => row.id)).size).toBe(collected.length);
      const exposed = JSON.stringify(collected); expect(exposed).not.toContain('secret'); expect(exposed).not.toContain('diff'); expect(exposed).not.toContain('reason'); expect(exposed).not.toContain('body');
      expect((await service.listComments(ctx, taskId, {})).items.find(row => row.id === original.id)?.authorDisplayNameSnapshot).toBe('Synthetic Member A');
    } finally { await target.database.sql`update users set display_name='Synthetic Member A' where id=${U.memberA}`; }
  });

  it('uses one actual read-only repeatable snapshot for authorization and page projection with no read writes', async () => {
    const db = target.database.db; let inspected = false;
    const inspectedDb = new Proxy(db, { get(original, key, receiver) {
      if (key !== 'transaction') return Reflect.get(original, key, receiver) as unknown;
      return async <R>(read: (tx: WorkloomExecutor) => Promise<R>, options: { isolationLevel: 'repeatable read'; accessMode: 'read only' }) => original.transaction(async tx => {
        expect(options).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
        const settings = await tx.execute(sql`select current_setting('transaction_read_only') as read_only, current_setting('transaction_isolation') as isolation`);
        expect(settings[0]).toMatchObject({ read_only: 'on', isolation: 'repeatable read' }); inspected = true;
        await tx.execute(sql`select id from memberships where id=${M.teamViewer}`);
        await target.database.sql`update memberships set state='revoked',revoked_at=now(),revision=revision+1 where id=${M.teamViewer}`;
        return read(tx);
      }, options);
    } }) as WorkloomExecutor;
    try {
      expect((await createTaskCommentsApplication(inspectedDb, { secret }).listComments(context(U.viewer), taskId, {})).items.length).toBeGreaterThan(0);
      await expect(app().listComments(context(U.viewer), taskId, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(inspected).toBe(true);
    } finally { await target.database.sql`update memberships set state='active',revoked_at=null,revision=revision+1 where id=${M.teamViewer}`; }
    const before = await snapshot(target); await app().listComments(context(U.viewer), taskId, {}); await app().listActivity(context(U.viewer), taskId, {}); expect(await snapshot(target)).toEqual(before);
  });

  it('creates comments across an overdue blocked recurrence census without changing task/planning/calendar sources', async () => {
    const planning = createPlanningApplication(target.database), recurrence = createRecurrenceApplication(target.database), owner = context(U.owner);
    const period = await planning.createPeriod(owner, { projectId, name: 'Overdue blocked calendar fixture', localStart: '2027-01-04', timezone: 'UTC', cutoffAt: '2030-01-01T00:00:00.000Z', protectedFieldIds: [], protectEstimate: false });
    const input = { schedule: { startDate: '2027-01-04', localTime: '10:00', timezone: 'UTC', frequency: 'daily' as const, plannedDurationMinutes: 30, end: { kind: 'after_count' as const, count: 1 } }, template: { title: 'Missing synthetic occurrence', statusId, organizerMembershipId: M.teamOwner, attendeeMembershipIds: [M.teamOwner] }, targetPeriodIds: [period.id] };
    const preview = await recurrence.previewCreate(owner, projectId, input); await recurrence.createSeries(context(U.owner), projectId, { ...input, previewHash: preview.previewHash });
    await target.database.sql`update planning_periods set cutoff_at='2020-01-01T00:00:00Z' where id=${period.id}`;
    await target.database.sql`update memberships set state='revoked',revoked_at=now(),revision=revision+1 where id=${M.teamOwner}`;
    try {
      const readiness = await recurrence.getReadiness(context(), period.id); expect(readiness.missingCount).toBeGreaterThan(0); expect(readiness.state).toBe('blocked');
      const allTables = Object.keys(await snapshot(target)), inert = allTables.filter(name => !['task_comments', 'audit_events', 'outbox_events', 'command_idempotency', 'workspaces'].includes(name));
      const before = await snapshot(target, inert);
      await app().createComment(context(), taskId, { body: 'Discussion remains independent of planning cutoff' });
      expect(await snapshot(target, inert)).toEqual(before);
      expect((await recurrence.getReadiness(context(), period.id)).state).toBe('blocked');
    } finally { await target.database.sql`update memberships set state='active',revoked_at=null,revision=revision+1 where id=${M.teamOwner}`; }
  });
});
