// Real PostgreSQL + source Fastify. Only this file's freshly created disposable child is
// migrated/seeded/mutated/dropped; no DATABASE_URL fallback or shared-runtime use.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CreateTaskInput, TaskDto, TaskListQuery } from '@workloom/contracts';
import type { CommandContext, TaskApplication } from '@workloom/domain';
import { createDatabase, createPlanningApplication, createTaskApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import { tasks, workPackages } from '../../packages/db/src/schema.js';
import { createTaskCursorCodec } from '../../packages/db/src/tasks/cursor.js';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';

requireTestDatabaseUrl();
const secret = 'synthetic-task-ordering-stable-cursor-secret';
const host = '127.0.0.1:4310';
const context = (userId: string = U.owner, workspaceId: string = W.team): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Synthetic ordering', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: randomUUID() });
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected ordering fixture.');
  return value;
}
const ids = (rows: readonly TaskDto[]) => rows.map(row => row.id);
type Placement = 'before' | 'after';
type Row = { id: string; position: number; revision: number; semantic: Record<string, unknown> };
type Table = { order: string[]; rows: Map<string, Row> };
type Fixture = { projectId: string; statusId: string; doneId: string };

/** Independent oracle: remove the source from the BEFORE global order and splice it next to the anchor. */
function splice(order: readonly string[], sourceId: string, anchorId: string, placement: Placement): string[] {
  const rest = order.filter(id => id !== sourceId);
  const at = rest.indexOf(anchorId);
  if (at < 0) throw new Error('Anchor missing from oracle order.');
  rest.splice(placement === 'before' ? at : at + 1, 0, sourceId);
  return rest;
}
const row = (table: Table, id: string): Row => required(table.rows.get(id));
const active = (table: Table): string[] => table.order.filter(id => row(table, id).semantic.archived_at === null);
const withoutSection = ({ section_id: _section, ...rest }: Record<string, unknown>) => rest;

/** Asserts the exact splice, unique integer positions, unchanged semantics and the revision rule for every pre-existing row. */
function expectSplice(before: Table, after: Table, sourceId: string, expected: readonly string[], crossSection = false): void {
  expect(after.order).toEqual(expected);
  const positions = after.order.map(id => row(after, id).position);
  expect(positions.every(position => Number.isInteger(position))).toBe(true);
  expect(new Set(positions).size).toBe(positions.length);
  for (const [id, old] of before.rows) {
    const now = row(after, id);
    if (id === sourceId) {
      expect(now.revision, id).toBe(old.revision + 1);
      expect(crossSection ? withoutSection(now.semantic) : now.semantic, id).toEqual(crossSection ? withoutSection(old.semantic) : old.semantic);
    } else {
      expect(now.semantic, id).toEqual(old.semantic);
      expect(now.revision, id).toBe(old.revision + (now.position === old.position ? 0 : 1));
    }
  }
}

async function digest(db: Database): Promise<Record<string, string>> {
  const tables = await db.sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name`;
  const result: Record<string, string> = {};
  for (const { table_name: table } of tables) {
    // Only identifier-quoted catalog table names; no caller-controlled SQL.
    const [found] = await db.sql.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from "${table.replaceAll('"', '""')}" t`);
    result[table] = required(found).digest;
  }
  return result;
}
const pick = (all: Record<string, string>, test: (name: string) => boolean) => Object.fromEntries(Object.entries(all).filter(([name]) => test(name)));
const orderTables = (all: Record<string, string>) => pick(all, name => name === 'tasks' || name === 'work_packages' || /audit|outbox/.test(name));
const auditTables = (all: Record<string, string>) => pick(all, name => /audit/.test(name));

describe('global manual task ordering on owned disposable PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined;
  let db: Database;
  let app: TaskApplication;
  let api: FastifyInstance | undefined;
  let viewerApi: FastifyInstance | undefined;
  const config = (actor: string, url: string) => loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DEV_ACTOR_ID: actor, DATABASE_URL: url });

  async function table(projectId: string, reader: Database = db): Promise<Table> {
    const rows = await reader.sql<Row[]>`select id, position, revision, to_jsonb(t) - 'position' - 'revision' - 'updated_at' as semantic from tasks t where project_id = ${projectId} order by position, id`;
    return { order: rows.map(found => found.id), rows: new Map(rows.map(found => [found.id, found])) };
  }
  async function packages(projectId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.sql<{ pkg: Record<string, unknown> }[]>`select to_jsonb(w) as pkg from work_packages w where project_id = ${projectId} order by id`;
    return rows.map(found => found.pkg);
  }
  async function revisionOf(id: string): Promise<number> {
    const [found] = await db.sql<{ revision: number }[]>`select revision from tasks where id = ${id}`;
    return required(found).revision;
  }
  async function setPositions(entries: readonly (readonly [string, number])[]): Promise<void> {
    // Legacy ties/gaps seeded only on this file's owned child rows.
    for (const [id, position] of entries) await db.sql`update tasks set position = ${position} where id = ${id}`;
  }
  async function project(name: string): Promise<Fixture> {
    const projectId = (await app.createProject(context(), { name })).id;
    const statuses = await app.listStatuses(context(), projectId);
    return { projectId, statusId: required(statuses.find(status => status.group === 'todo')).id, doneId: required(statuses.find(status => status.group === 'done')).id };
  }
  const create = (fixture: Fixture, input: Partial<CreateTaskInput>, ctx: CommandContext = context()) =>
    app.createTask(ctx, { projectId: fixture.projectId, statusId: fixture.statusId, title: 'Ordering task', ...input });
  const move = async (id: string, anchorTaskId: string, placement: Placement, ctx: CommandContext = context()) =>
    app.moveTask(ctx, id, { expectedRevision: await revisionOf(id), anchorTaskId, placement });
  const post = (server: FastifyInstance | undefined, path: string, payload: Record<string, unknown>, key: string = randomUUID()) =>
    required(server).inject({ method: 'POST', url: `/api/v1/workspaces/${W.team}${path}`, headers: { host, origin: `http://${host}`, 'idempotency-key': key }, payload });
  const getList = (server: FastifyInstance | undefined, projectId: string) =>
    required(server).inject({ method: 'GET', url: `/api/v1/workspaces/${W.team}/tasks?projectId=${projectId}&limit=200`, headers: { host } });

  async function exhaust(q: TaskListQuery, reader: TaskApplication = app): Promise<string[]> {
    const found: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 400; page += 1) {
      const result = await reader.listTasks(context(), { ...q, ...(cursor ? { cursor } : {}) });
      expect(result.items.length).toBeLessThanOrEqual(q.limit);
      found.push(...ids(result.items));
      if (!result.nextCursor) {
        expect(new Set(found).size).toBe(found.length);
        return found;
      }
      expect(result.items).toHaveLength(q.limit);
      cursor = result.nextCursor;
    }
    throw new Error('Task pagination did not terminate.');
  }
  /** Fresh paging only: every page size from the first page, archived included internally. */
  async function expectPages(projectId: string, final: Table, reader: TaskApplication = app): Promise<void> {
    for (const limit of [1, 2, 200]) {
      expect(await exhaust({ projectId, limit }, reader)).toEqual(active(final));
      expect(await exhaust({ projectId, limit, includeArchived: true }, reader)).toEqual(final.order);
    }
  }

  /** Interleaved sections, parents, archived row and explicit legacy position ties/gaps. */
  async function globalFixture(name: string) {
    const fixture = await project(name);
    const s1 = (await app.createSection(context(), fixture.projectId, { name: 'Ordering S1' })).id;
    const s2 = (await app.createSection(context(), fixture.projectId, { name: 'Ordering S2' })).id;
    const parent = await create(fixture, { title: 'P', estimateMinutes: 90 });
    const r1 = await create(fixture, { title: 'R1' });
    const c1 = await create(fixture, { title: 'C1', parentTaskId: parent.id });
    const archivedDraft = await create(fixture, { title: 'Archived root' });
    const r2 = await create(fixture, { title: 'R2', sectionId: s1 });
    const c2 = await create(fixture, { title: 'C2', parentTaskId: parent.id });
    const q = await create(fixture, { title: 'Q', estimateMinutes: 30 });
    const d1 = await create(fixture, { title: 'D1', parentTaskId: q.id });
    const r3 = await create(fixture, { title: 'R3', sectionId: s2 });
    const c3 = await create(fixture, { title: 'C3', parentTaskId: parent.id });
    const r4 = await create(fixture, { title: 'R4' });
    const archived = await app.archiveTask(context(), archivedDraft.id, { expectedRevision: archivedDraft.revision });
    await setPositions([[parent.id, 0], [r1.id, 5], [c1.id, 5], [archived.id, 5], [r2.id, 9], [c2.id, 20], [q.id, 20], [d1.id, 21], [r3.id, 40], [c3.id, 40], [r4.id, 100]]);
    return { fixture, s1, s2, parent, r1, c1, archived, r2, c2, q, d1, r3, c3, r4 };
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase('task_ordering');
    console.info(`TASK_ORDERING_OWNED_DB=${target.name}`);
    db = createDatabase(target.url, { requireLoopback: true });
    const existing = await db.sql`select 1 from information_schema.tables where table_schema='public' limit 1`;
    if (existing.length) throw new Error('Refusing to migrate/seed a nonempty task-ordering child database.');
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
    app = createTaskApplication(db, { cursorSecret: secret });
    api = await createApp(config(U.owner, target.url), { database: db, taskApplication: app, webDistDir: null, logger: false });
    viewerApi = await createApp(config(U.viewer, target.url), { database: db, taskApplication: app, webDistDir: null, logger: false });
  }, 60_000);
  afterAll(async () => {
    try { await viewerApi?.close(); }
    finally {
      try { await api?.close(); }
      finally { try { await db?.close(); } finally { await target?.drop(); } }
    }
  });

  it('inserts next to anchors durably, keeps legacy append and pages fresh manual order once', async () => {
    const fixture = await project('Ordering basics');
    const a = await create(fixture, { title: 'A' });
    const b = await create(fixture, { title: 'B' });
    const c = await create(fixture, { title: 'C' });
    const beforeX = await table(fixture.projectId);
    const x = await create(fixture, { title: 'X', insertion: { anchorTaskId: b.id, placement: 'after' } });
    const afterX = await table(fixture.projectId);
    expectSplice(beforeX, afterX, x.id, splice(beforeX.order, x.id, b.id, 'after'));
    expect(x).toMatchObject({ revision: 1, position: row(afterX, x.id).position, sectionId: null, parentTaskId: null });
    const y = await create(fixture, { title: 'Y', insertion: { anchorTaskId: x.id, placement: 'after' } });
    const afterY = await table(fixture.projectId);
    expectSplice(afterX, afterY, y.id, splice(afterX.order, y.id, x.id, 'after'));
    const expected = [a, b, x, y, c].map(task => task.id);
    expect(afterY.order).toEqual(expected);
    await expectPages(fixture.projectId, afterY);
    const http = await getList(api, fixture.projectId);
    expect(http.statusCode).toBe(200);
    expect(http.json().data.map((task: TaskDto) => task.id)).toEqual(expected);

    // Fresh connection, facade and HTTP app read the committed order, not in-process state.
    const reader = createDatabase(required(target).url, { requireLoopback: true });
    let readerApi: FastifyInstance | undefined;
    try {
      const readerApp = createTaskApplication(reader, { cursorSecret: secret });
      expect((await table(fixture.projectId, reader)).order).toEqual(expected);
      await expectPages(fixture.projectId, afterY, readerApp);
      readerApi = await createApp(config(U.owner, required(target).url), { database: reader, taskApplication: readerApp, webDistDir: null, logger: false });
      expect((await getList(readerApi, fixture.projectId)).json().data.map((task: TaskDto) => task.id)).toEqual(expected);
    } finally {
      try { await readerApi?.close(); } finally { await reader.close(); }
    }

    // Legacy create without insertion is an exact append: no other row moves or bumps.
    const z = await create(fixture, { title: 'Z' });
    const afterZ = await table(fixture.projectId);
    expect(afterZ.order).toEqual([...expected, z.id]);
    expect(z.position).toBeGreaterThan(Math.max(...expected.map(id => row(afterY, id).position)));
    for (const id of expected) expect(row(afterZ, id)).toEqual(row(afterY, id));

    // Cursor format and legacy hash binding are unchanged by the ordering work.
    const first = await app.listTasks(context(), { projectId: fixture.projectId, limit: 1 });
    const legacyHash = createHash('sha256').update(`{"limit":1,"projectId":"${fixture.projectId}"}`).digest('hex');
    expect(createTaskCursorCodec({ secret }).decode(required(first.nextCursor))).toMatchObject({ version: 1, queryHash: legacyHash, id: a.id, position: row(afterZ, a.id).position });
  });

  it('splices the whole project globally across sections, parents, ties, gaps and archived rows', async () => {
    const f = await globalFixture('Ordering global');
    const pkgBefore = await packages(f.fixture.projectId);
    // Global positions: a child moved inside its parent never jumps ahead of that parent.
    let before = await table(f.fixture.projectId);
    const child = await move(f.c3.id, f.c1.id, 'before');
    let after = await table(f.fixture.projectId);
    expectSplice(before, after, f.c3.id, splice(before.order, f.c3.id, f.c1.id, 'before'));
    expect(after.order.indexOf(f.parent.id)).toBeLessThan(after.order.indexOf(f.c3.id));
    expect(child).toMatchObject({ id: f.c3.id, parentTaskId: f.parent.id, sectionId: null, workPackageId: f.parent.workPackageId, position: row(after, f.c3.id).position, revision: row(after, f.c3.id).revision });

    before = after;
    await move(f.r4.id, f.r1.id, 'after');
    after = await table(f.fixture.projectId);
    expectSplice(before, after, f.r4.id, splice(before.order, f.r4.id, f.r1.id, 'after'));

    before = after;
    const rootX = await create(f.fixture, { title: 'X root', sectionId: f.s1, insertion: { anchorTaskId: f.r2.id, placement: 'before' } });
    after = await table(f.fixture.projectId);
    expectSplice(before, after, rootX.id, splice(before.order, rootX.id, f.r2.id, 'before'));
    expect(rootX).toMatchObject({ sectionId: f.s1, parentTaskId: null, position: row(after, rootX.id).position });

    before = after;
    const detail = await create(f.fixture, { title: 'Detail after C2', parentTaskId: f.parent.id, insertion: { anchorTaskId: f.c2.id, placement: 'after' } });
    after = await table(f.fixture.projectId);
    expectSplice(before, after, detail.id, splice(before.order, detail.id, f.c2.id, 'after'));
    expect(detail).toMatchObject({ parentTaskId: f.parent.id, workPackageId: f.parent.workPackageId });
    expect(after.order.indexOf(f.parent.id)).toBeLessThan(after.order.indexOf(detail.id));

    expect(after.order).toContain(f.archived.id);
    expect(row(after, f.archived.id).semantic.archived_at).not.toBeNull();
    expect((await packages(f.fixture.projectId)).filter(pkg => pkg.id !== rootX.workPackageId)).toEqual(pkgBefore);
    await expectPages(f.fixture.projectId, after);
  });

  it('moves and inserts past 200 unloaded rows and still pages every row exactly once', async () => {
    const fixture = await project('Ordering bulk');
    const tagId = (await app.createTag(context(), { name: 'Ordering bulk tag' })).id;
    const bulk = Array.from({ length: 205 }, (_, n) => `ab000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    // Direct fixture insertion is restricted to the owned child, never application state.
    await db.db.insert(workPackages).values(bulk.map(id => ({ id, workspaceId: W.team, projectId: fixture.projectId, origin: 'new_task' as const })));
    await db.db.insert(tasks).values(bulk.map((id, n) => ({ id, workspaceId: W.team, projectId: fixture.projectId, workPackageId: id, title: `Bulk ${n}`, statusId: n % 7 === 0 ? fixture.doneId : fixture.statusId, position: Math.floor(n / 2) * 2 })));
    const at = (n: number) => required(bulk[n]);
    const tagged = new Set([10, 201, 203].map(at));
    const done = new Set(bulk.filter((_, n) => n % 7 === 0));
    for (const id of tagged) await app.updateTask(context(), id, { expectedRevision: await revisionOf(id), tagIds: [tagId] });
    for (const id of [50, 200, 204].map(at)) await app.archiveTask(context(), id, { expectedRevision: await revisionOf(id) });

    let before = await table(fixture.projectId);
    expect(before.order).toEqual(bulk);
    await move(at(5), at(202), 'after');
    let after = await table(fixture.projectId);
    expectSplice(before, after, at(5), splice(before.order, at(5), at(202), 'after'));
    before = after;
    const inserted = await create(fixture, { title: 'Inserted past page', insertion: { anchorTaskId: at(201), placement: 'before' } });
    after = await table(fixture.projectId);
    expectSplice(before, after, inserted.id, splice(before.order, inserted.id, at(201), 'before'));
    before = after;
    await move(at(203), at(1), 'before');
    after = await table(fixture.projectId);
    expectSplice(before, after, at(203), splice(before.order, at(203), at(1), 'before'));

    expect(after.order).toHaveLength(206);
    expect(new Set(after.order).size).toBe(206);
    await expectPages(fixture.projectId, after);
    // Filters narrow the read only; ordering was computed over the full project set.
    expect(await exhaust({ projectId: fixture.projectId, statusId: fixture.doneId, limit: 2 })).toEqual(active(after).filter(id => done.has(id)));
    expect(await exhaust({ projectId: fixture.projectId, statusId: fixture.doneId, includeArchived: true, limit: 2 })).toEqual(after.order.filter(id => done.has(id)));
    expect(await exhaust({ projectId: fixture.projectId, tagId, limit: 2 })).toEqual(active(after).filter(id => tagged.has(id)));
  });

  it('derives root sections, keeps child packages and rejects invalid anchors without writes', async () => {
    const f = await globalFixture('Ordering rules');
    let before = await table(f.fixture.projectId);
    const crossed = await move(f.r2.id, f.r3.id, 'after');
    let after = await table(f.fixture.projectId);
    expectSplice(before, after, f.r2.id, splice(before.order, f.r2.id, f.r3.id, 'after'), true);
    expect(crossed.sectionId).toBe(f.s2);
    expect(row(after, f.r2.id).semantic.section_id).toBe(f.s2);

    before = after;
    const unsectioned = await move(f.r3.id, f.r1.id, 'before');
    after = await table(f.fixture.projectId);
    expectSplice(before, after, f.r3.id, splice(before.order, f.r3.id, f.r1.id, 'before'), true);
    expect(unsectioned.sectionId).toBeNull();

    before = after;
    const child = await move(f.c1.id, f.c3.id, 'after');
    after = await table(f.fixture.projectId);
    expectSplice(before, after, f.c1.id, splice(before.order, f.c1.id, f.c3.id, 'after'));
    expect(child).toMatchObject({ parentTaskId: f.parent.id, workPackageId: f.parent.workPackageId, sectionId: null });

    const foreign = await create(await project('Ordering foreign'), { title: 'Foreign anchor' });
    const sectioned = await create(f.fixture, { title: 'C4 sectioned', parentTaskId: f.parent.id });
    await db.sql`update tasks set section_id = ${f.s1} where id = ${sectioned.id}`;
    const snapshot = await digest(db);
    const invalid: [string, string][] = [
      [f.c1.id, f.d1.id], // other parent
      [f.c1.id, f.r1.id], // child next to root would reparent
      [f.r1.id, f.c1.id], // root next to child would reparent
      [f.r1.id, foreign.id], // other project
      [f.c1.id, sectioned.id], // subtask section mismatch
      [f.r1.id, f.r1.id], // self
      [f.r1.id, f.archived.id], // archived anchor
      [f.archived.id, f.r1.id], // archived source
    ];
    for (const [source, anchor] of invalid) {
      for (const placement of ['before', 'after'] as const) {
        await expect(move(source, anchor, placement)).rejects.toMatchObject({ code: expect.stringMatching(/^[A-Z_]+$/) });
      }
    }
    expect(await digest(db)).toEqual(snapshot);

    const current = await revisionOf(f.r1.id);
    const path = `/tasks/${f.r1.id}/move`;
    expect((await post(api, path, { expectedRevision: current > 1 ? current - 1 : current + 1, anchorTaskId: f.r4.id, placement: 'after' })).statusCode).toBe(409);
    for (const extra of [{ position: 0 }, { sectionId: f.s1 }, { parentTaskId: null }]) {
      expect((await post(api, path, { expectedRevision: current, anchorTaskId: f.r4.id, placement: 'after', ...extra })).statusCode).toBe(400);
    }
    expect(await digest(db)).toEqual(snapshot);
  });

  it('replays keyed moves/creates exactly and checks current ACL before an existing receipt', async () => {
    const fixture = await project('Ordering idempotency');
    const [a, b, c, d] = [await create(fixture, { title: 'A' }), await create(fixture, { title: 'B' }), await create(fixture, { title: 'C' }), await create(fixture, { title: 'D' })];
    const moveCtx = context();
    const moveInput = { expectedRevision: d.revision, anchorTaskId: a.id, placement: 'after' as const };
    const moved = await app.moveTask(moveCtx, d.id, moveInput);
    const afterMove = await digest(db);
    expect(await app.moveTask(moveCtx, d.id, moveInput)).toEqual(moved);
    expect(await digest(db)).toEqual(afterMove);

    const createCtx = context();
    const createInput: CreateTaskInput = { projectId: fixture.projectId, statusId: fixture.statusId, title: 'Keyed insert', insertion: { anchorTaskId: b.id, placement: 'before' } };
    const created = await app.createTask(createCtx, createInput);
    const afterCreate = await digest(db);
    expect(await app.createTask(createCtx, createInput)).toEqual(created);
    expect(await digest(db)).toEqual(afterCreate);
    expect((await table(fixture.projectId)).order).toEqual([a.id, d.id, created.id, b.id, c.id]);

    const key = randomUUID();
    const path = `/tasks/${c.id}/move`;
    const body = { expectedRevision: await revisionOf(c.id), anchorTaskId: a.id, placement: 'before' };
    const first = await post(api, path, body, key);
    expect(first.statusCode).toBe(200);
    const afterHttp = await digest(db);
    const replay = await post(api, path, body, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual(first.json().data);
    expect((await post(api, path, { ...body, placement: 'after' }, key)).statusCode).toBe(409);
    expect(await digest(db)).toEqual(afterHttp);

    // A read-only viewer cannot obtain the existing receipt; a revoked membership sees nothing.
    expect((await getList(viewerApi, fixture.projectId)).statusCode).toBe(200);
    expect((await post(viewerApi, path, body, key)).statusCode).toBe(403);
    expect((await post(viewerApi, path, body)).statusCode).toBe(403);
    await db.sql`update memberships set state='revoked', revoked_at=now() where id=${M.teamViewer}`;
    try {
      expect((await getList(viewerApi, fixture.projectId)).statusCode).toBe(404);
      expect((await post(viewerApi, path, body, key)).statusCode).toBe(404);
    } finally { await db.sql`update memberships set state='active', revoked_at=null where id=${M.teamViewer}`; }
    expect(await digest(db)).toEqual(afterHttp);
  });

  it('treats globally adjacent placement as a no-op and bumps the source when a legacy tie flips', async () => {
    const fixture = await project('Ordering ties');
    const lead = await create(fixture, { title: 'Lead' });
    const t1 = await create(fixture, { title: 'Tie 1' });
    const t2 = await create(fixture, { title: 'Tie 2' });
    const tail = await create(fixture, { title: 'Tail' });
    await setPositions([[lead.id, 0], [t1.id, 7], [t2.id, 7], [tail.id, 9]]);
    const [first, second] = [t1.id, t2.id].sort((l, r) => (l < r ? -1 : l > r ? 1 : 0)) as [string, string];
    const start = await table(fixture.projectId);
    expect(start.order).toEqual([lead.id, first, second, tail.id]);

    const quiet = await digest(db);
    expect(Object.keys(orderTables(quiet))).toEqual(expect.arrayContaining(['tasks', 'work_packages']));
    expect(Object.keys(auditTables(quiet)).length).toBeGreaterThan(0);
    for (const [source, anchor, placement] of [[second, first, 'after'], [first, second, 'before'], [first, lead.id, 'after'], [tail.id, second, 'after'], [lead.id, first, 'before']] as const) {
      const noop = await move(source, anchor, placement);
      expect(noop).toMatchObject({ id: source, position: row(start, source).position, revision: row(start, source).revision });
    }
    expect(orderTables(await digest(db))).toEqual(orderTables(quiet));
    expect(await table(fixture.projectId)).toEqual(start);

    const flipped = await move(first, second, 'after');
    const after = await table(fixture.projectId);
    expectSplice(start, after, first, [lead.id, second, first, tail.id]);
    expect(flipped.revision).toBe(row(start, first).revision + 1);
    expect(auditTables(await digest(db))).not.toEqual(auditTables(quiet));
  });

  it('rolls back the whole command when PostgreSQL fails one shifted row mid-renumber', async () => {
    const fixture = await project('Ordering rollback');
    const rows: TaskDto[] = [];
    for (let n = 0; n < 5; n += 1) rows.push(await create(fixture, { title: `Rollback ${n}` }));
    await setPositions(rows.map((task, n) => [task.id, n] as const));
    const victim = required(rows[0]).id, source = required(rows[4]).id;
    // Inserting before position 0 forces the victim to shift; the id is validated before interpolation.
    if (!/^[0-9a-f-]{36}$/.test(victim)) throw new Error('Unexpected victim id.');
    await db.sql.unsafe(`create function task_ordering_test_fail() returns trigger language plpgsql as $$ begin if new.id = '${victim}'::uuid and new.position is distinct from old.position then raise exception 'synthetic renumber failure'; end if; return new; end $$`);
    try {
      await db.sql.unsafe('create trigger task_ordering_test_fail before update on tasks for each row execute function task_ordering_test_fail()');
      const before = await digest(db);
      await expect(move(source, victim, 'before')).rejects.toThrow();
      expect(await digest(db)).toEqual(before);
      await expect(create(fixture, { title: 'Rolled back insert', insertion: { anchorTaskId: victim, placement: 'before' } })).rejects.toThrow();
      expect(await digest(db)).toEqual(before);
    } finally {
      await db.sql.unsafe('drop trigger if exists task_ordering_test_fail on tasks');
      await db.sql.unsafe('drop function if exists task_ordering_test_fail()');
    }
    const before = await table(fixture.projectId);
    await move(source, victim, 'before');
    expectSplice(before, await table(fixture.projectId), source, splice(before.order, source, victim, 'before'));
  });

  it('reorders after a populated project freeze without touching the pinned baseline', async () => {
    const planning = createPlanningApplication(db);
    const fixture = await project('Ordering baseline');
    const root = await create(fixture, { title: 'Pinned root', estimateMinutes: 120 });
    const detail = await create(fixture, { title: 'Pinned detail', parentTaskId: root.id });
    const detail2 = await create(fixture, { title: 'Pinned detail 2', parentTaskId: root.id });
    const sibling = await create(fixture, { title: 'Pinned sibling', estimateMinutes: 45 });
    const period = await planning.createPeriod(context(), { projectId: fixture.projectId, name: 'Ordering freeze', localStart: '2030-01-07', timezone: 'UTC', cutoffAt: '2030-01-06T12:00:00.000Z', protectedFieldIds: [], protectEstimate: true });
    await planning.createCommitment(context(), period.id, { workPackageId: root.workPackageId, membershipId: M.teamOwner, expectedAbsent: true, plannedMinutes: 120, allocations: [{ taskId: root.id, minutes: 120 }] });
    // The baseline only snapshots committed packages; plan the sibling too so every package moved below is pinned.
    await planning.createCommitment(context(), period.id, { workPackageId: sibling.workPackageId, membershipId: M.teamOwner, expectedAbsent: true, plannedMinutes: 45, allocations: [{ taskId: sibling.id, minutes: 45 }] });
    const preview = await planning.previewFreeze(context(), period.id, { scope: 'project' });
    const frozen = await planning.freezePlan(context(), period.id, { scope: 'project', previewHash: preview.previewHash });
    const original = await planning.getBaseline(context(), frozen.id);
    expect(original.snapshot.tasks.map(task => task.id)).toEqual(expect.arrayContaining([root.id, detail.id, detail2.id, sibling.id]));
    expect(original.snapshot.packages).toContainEqual(expect.objectContaining({ id: root.workPackageId, estimateMinutes: 120 }));
    expect(original.snapshot.packages).toContainEqual(expect.objectContaining({ id: sibling.workPackageId, estimateMinutes: 45 }));
    expect(original.snapshot.commitments).toHaveLength(2);
    const pkgBefore = await packages(fixture.projectId);

    let before = await table(fixture.projectId);
    await move(sibling.id, root.id, 'before');
    let after = await table(fixture.projectId);
    expectSplice(before, after, sibling.id, splice(before.order, sibling.id, root.id, 'before'));
    before = after;
    await move(detail2.id, detail.id, 'before');
    after = await table(fixture.projectId);
    expectSplice(before, after, detail2.id, splice(before.order, detail2.id, detail.id, 'before'));
    expect(row(after, detail2.id).semantic).toMatchObject({ parent_task_id: root.id, work_package_id: root.workPackageId });
    before = after;
    const inserted = await create(fixture, { title: 'Post-freeze insert', insertion: { anchorTaskId: sibling.id, placement: 'after' } });
    after = await table(fixture.projectId);
    expectSplice(before, after, inserted.id, splice(before.order, inserted.id, sibling.id, 'after'));

    expect(await planning.getBaseline(context(), frozen.id)).toEqual(original);
    expect((await packages(fixture.projectId)).filter(pkg => pkg.id !== inserted.workPackageId)).toEqual(pkgBefore);
  });
});
