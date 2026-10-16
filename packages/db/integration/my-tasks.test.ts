import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MyTasksQueryInput } from '@workloom/contracts';
import type { CommandContext, DomainError } from '@workloom/domain';
import { createMyTasksApplication } from '../src/my-tasks/application.js';
import { createMyTasksReadRepository } from '../src/my-tasks/repository.js';
import type { WorkloomExecutor } from '../src/client.js';
import { FIXTURE_MEMBERSHIP_IDS as M, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W } from '../src/fixtures.js';
import { runMigrations } from '../src/migrations.js';
import { seedDemoData } from '../src/seed/demo-seed.js';
import { projects, tasks, taskStatuses, taskParticipants, workPackages } from '../src/schema.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support.js';

const id = (prefix: string, n: number) => `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = (n: number) => id('bc', n), T = (n: number) => id('bd', n), S = (n: number) => id('be', n), B = (n: number) => id('bf', n);
const context = (userId: string = U.viewer, workspaceId: string = W.team): CommandContext => ({ actor: { userId, displayName: 'Synthetic viewer', kind: 'fixture' }, source: 'web', requestId: 'my-tasks-pg', workspaceId });
async function rejected(promise: Promise<unknown>): Promise<DomainError> { try { await promise; } catch (error) { return error as DomainError; } throw new Error('Expected a domain error'); }

interface FixtureRow { n: number; project: number; due: string | null; title: string; responsible?: string | null; participant?: boolean; group?: 'done' | 'cancelled'; archived?: boolean; outside?: boolean }
const fixtureRows: FixtureRow[] = [
  { n: 1, project: 0, due: '2026-10-14', title: 'Both roles', responsible: M.teamViewer, participant: true },
  { n: 2, project: 1, due: '2026-10-14', title: 'Participation only', responsible: M.teamOwner, participant: true },
  { n: 3, project: 0, due: null, title: 'Responsible with inactive participation', responsible: M.teamViewer, participant: false },
  { n: 4, project: 0, due: '2026-10-15', title: 'Inactive participation only', responsible: M.teamOwner, participant: false },
  { n: 5, project: 0, due: null, title: 'Other person', responsible: M.teamOwner },
  { n: 6, project: 0, due: '2026-10-16', title: 'Completed', responsible: M.teamViewer, group: 'done' },
  { n: 7, project: 0, due: null, title: 'Cancelled', responsible: M.teamViewer, group: 'cancelled' },
  { n: 8, project: 0, due: '2026-10-17', title: 'Archived task', responsible: M.teamViewer, archived: true },
  { n: 9, project: 501, due: '2026-10-18', title: 'Archived project task', responsible: M.teamViewer },
  { n: 10, project: 500, due: '2026-10-19', title: 'Beyond the first five hundred projects', responsible: M.teamViewer },
  { n: 11, project: 600, due: '2026-10-13', title: 'Outside workspace', responsible: M.outsideOwner, outside: true },
  { n: 12, project: 0, due: '2026-10-20', title: 'Literal % mark', responsible: M.teamViewer },
  { n: 13, project: 0, due: '2026-10-20', title: 'Literal _ mark', responsible: M.teamViewer },
  { n: 14, project: 0, due: '2026-10-20', title: 'Literal \\ mark', responsible: M.teamViewer },
  { n: 15, project: 0, due: '2026-10-21', title: 'No special mark', responsible: M.teamViewer },
  { n: 16, project: 1, due: null, title: 'Another undated task', responsible: M.teamViewer },
];

async function digest(target: ThrowawayDatabase): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of ['users', 'workspaces', 'memberships', 'projects', 'task_statuses', 'work_packages', 'tasks', 'task_participants', 'audit_events', 'outbox_events', 'command_idempotency', 'planning_periods', 'plan_baselines', 'work_logs']) {
    const rows = await target.database.sql.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) as digest from "${table}" t`);
    result[table] = rows[0]?.digest ?? '';
  }
  return result;
}

describe('personal task read model on a disposable PostgreSQL database', () => {
  let target: ThrowawayDatabase;
  beforeAll(async () => {
    target = await createThrowawayDatabase('mytasks');
    console.info(`MY_TASKS_DISPOSABLE_DB=${target.name}`);
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(target.database);
    const db = target.database.db;
    await db.insert(projects).values(Array.from({ length: 502 }, (_, n) => ({ id: P(n), workspaceId: W.team, name: `Project ${String(n).padStart(3, '0')}`, archivedAt: n === 501 ? new Date('2026-10-01T00:00:00Z') : null })));
    await db.insert(projects).values({ id: P(600), workspaceId: W.outside, name: 'Outside project' });
    await db.insert(taskStatuses).values([...Array.from({ length: 502 }, (_, n) => ({ id: S(n), workspaceId: W.team, projectId: P(n), name: 'To do', group: 'todo' as const, position: 0 })), { id: S(600), workspaceId: W.outside, projectId: P(600), name: 'To do', group: 'todo' as const, position: 0 }]);
    await db.insert(taskStatuses).values([{ id: S(1000), workspaceId: W.team, projectId: P(0), name: 'Done', group: 'done', position: 1 }, { id: S(1001), workspaceId: W.team, projectId: P(0), name: 'Cancelled', group: 'cancelled', position: 2 }]);
    await db.insert(workPackages).values(fixtureRows.map(row => ({ id: B(row.n), workspaceId: row.outside ? W.outside : W.team, projectId: P(row.project), origin: 'new_task' as const, sourcePackageId: null, estimateMinutes: row.n === 1 ? 120 : null })));
    await db.insert(tasks).values(fixtureRows.map(row => ({ id: T(row.n), workspaceId: row.outside ? W.outside : W.team, projectId: P(row.project), workPackageId: B(row.n), title: row.title, description: row.n === 16 ? 'Description-only needle' : '', statusId: row.group === 'done' ? S(1000) : row.group === 'cancelled' ? S(1001) : S(row.project), responsibleMembershipId: row.responsible ?? null, position: row.n, dueDate: row.due, archivedAt: row.archived ? new Date('2026-10-01T00:00:00Z') : null })));
    await db.insert(taskParticipants).values(fixtureRows.filter(row => row.participant !== undefined).map(row => ({ workspaceId: W.team, taskId: T(row.n), membershipId: M.teamViewer, role: 'assignee' as const, active: row.participant as boolean })));
  }, 60_000);
  afterAll(async () => { await target?.drop(); });
  const app = () => createMyTasksApplication(target.database, { secret: 'synthetic-personal-task-cursor-test-secret' });

  it('reads viewer involvement across more than 500 projects without multiplying participants', async () => {
    const service = app();
    const all = await service.list(context(), {});
    expect(all.items.map(row => row.task.id)).toEqual([1, 2, 10, 12, 13, 14, 15, 3, 16].map(T));
    expect(all.items.filter(row => row.task.id === T(1))).toHaveLength(1);
    expect(all.items.find(row => row.task.id === T(10))?.project).toMatchObject({ id: P(500), name: 'Project 500' });
    expect(all.items[0]?.task.estimateMinutes).toBe(120);
    expect((await service.list(context(), { relation: 'assigned' })).items.map(row => row.task.id)).toEqual([1, 10, 12, 13, 14, 15, 3, 16].map(T));
    expect((await service.list(context(), { relation: 'participating' })).items.map(row => row.task.id)).toEqual([T(1), T(2)]);
  });

  it('filters completed/cancelled and archived tasks/projects explicitly, and escapes all LIKE metacharacters', async () => {
    const service = app();
    expect((await service.list(context(), { completion: 'closed' })).items.map(row => row.task.id)).toEqual([T(6), T(7)]);
    const archived = (await service.list(context(), { includeArchived: true })).items.map(row => row.task.id);
    expect(archived).toContain(T(8)); expect(archived).toContain(T(9));
    for (const [search, task] of [['%', 12], ['_', 13], ['\\', 14], ['needle', 16]] as const) expect((await service.list(context(), { search })).items.map(row => row.task.id), search).toEqual([T(task)]);
    expect((await service.list(context(), { search: 'no match' })).items).toEqual([]);
  });

  it('paginates same-date ties and both null-date boundaries with no missing or duplicated identities', async () => {
    const service = app();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const query: MyTasksQueryInput = cursor ? { limit: 1, cursor } : { limit: 1 };
      const page = await service.list(context(), query);
      expect(page.items).toHaveLength(1);
      ids.push(...page.items.map(row => row.task.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual([1, 2, 10, 12, 13, 14, 15, 3, 16].map(T));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reauthorizes a viewer before a bad/stale cursor and never reads outside their workspace', async () => {
    const service = app();
    expect((await rejected(service.list(context(U.viewer, W.outside), { cursor: 'bad' }))).code).toBe('NOT_FOUND');
    await target.database.sql`update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1 where id = ${M.teamViewer}`;
    try { expect((await rejected(service.list(context(), { cursor: 'bad' }))).code).toBe('NOT_FOUND'); }
    finally { await target.database.sql`update memberships set state = 'active', revoked_at = null, revision = revision + 1 where id = ${M.teamViewer}`; }
    const first = await service.list(context(), { limit: 1 });
    await target.database.sql`update workspaces set permission_epoch = permission_epoch + 1 where id = ${W.team}`;
    expect((await rejected(service.list(context(), { limit: 1, cursor: first.nextCursor as string }))).code).toBe('VALIDATION_FAILED');
  });

  it('uses actual repeatable-read/read-only settings and keeps task decoration in that snapshot', async () => {
    const db = target.database.db;
    let configured: unknown;
    const instrumented = new Proxy(db, { get(original, key, receiver) {
      if (key !== 'transaction') return Reflect.get(original, key, receiver) as unknown;
      return async <R>(read: (tx: WorkloomExecutor) => Promise<R>, options: { isolationLevel: 'repeatable read'; accessMode: 'read only' }) => {
        configured = options;
        return original.transaction(async tx => {
          const settings = await tx.execute(sql`select current_setting('transaction_read_only') as read_only, current_setting('transaction_isolation') as isolation`);
          expect(settings[0]).toMatchObject({ read_only: 'on', isolation: 'repeatable read' });
          await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, T(1)));
          await target.database.sql`update tasks set title = 'Concurrent edit', revision = revision + 1 where id = ${T(1)}`;
          return read(tx);
        }, options);
      };
    } }) as WorkloomExecutor;
    try {
      const service = createMyTasksApplication(instrumented);
      expect((await service.list(context(), { limit: 1 })).items[0]?.task.title).toBe('Both roles');
      expect(configured).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
      expect((await app().list(context(), { limit: 1 })).items[0]?.task.title).toBe('Concurrent edit');
    } finally { await target.database.sql`update tasks set title = 'Both roles', revision = 1 where id = ${T(1)}`; }
  });

  it('leaves task/identity/planning data, idempotency receipts, audit, outbox and workspace sequences unchanged', async () => {
    const before = await digest(target);
    await app().list(context(), {});
    await app().list(context(), { completion: 'all', includeArchived: true, search: 'mark' });
    expect(await digest(target)).toEqual(before);
    // The repository itself also refuses callers that try to bypass the domain's fixed bound.
    await expect(createMyTasksReadRepository(target.database.db).list(W.team, M.teamViewer, { relation: 'all', completion: 'all', includeArchived: true, limit: 200 }, null, 202)).rejects.toThrow('bounded to 201');
  });
});
