// Frozen P4a dependencies/blocking/own-layout acceptance over real HTTP and isolated PostgreSQL.
// Actor identity is a separate API process; full public-table snapshots prove rejection/rollback.
import { randomUUID } from 'node:crypto';

import { taskDependencyListResponseSchema, taskDependencyResponseSchema, taskResponseSchema } from '@workloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectEnvelope, expectError, statusInGroup, uniqueName } from './support/p1a.js';
import { changedTables, databaseSnapshot, membershipRow, restoreMembership, revokeMembership } from './support/p1b.js';
import { MEMBERS, planningHarness, planningProject, planningTask, TEAM, type PlanningHarness } from './support/p2a-fixture.js';
import { P3bClient, located, pgClockBefore, pgClockPlus, waitPastPgClock } from './support/p3b.js';
import { p4aClients, type P4aClient } from './support/p4a.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;
let owner: P4aClient, replica: P4aClient, member: P4aClient, viewer: P4aClient, outsider: P4aClient;
async function fixture(label: string, count = 3) {
  const f = await planningProject(owner, label);
  const tasks = [];
  for (let i = 0; i < count; i++) tasks.push(await planningTask(owner, f.project, 120, uniqueName(`${label} ${i + 1}`)));
  const [a, b, c] = tasks;
  if (!a || !b) throw new Error('At least two tasks required.');
  return { ...f, tasks, a, b, c };
}
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error('Fixture item required.'); return value; }
async function expectNoChange(run: () => Promise<unknown>) {
  const before = await databaseSnapshot(h.db.sql); await run(); expect(await databaseSnapshot(h.db.sql)).toEqual(before);
}

// Bulk fixture only: valid FK-backed independent tasks/edges in this file's disposable database.
// This seeds graph-size boundaries efficiently; functional edge writes remain actual HTTP above.
async function bulkGraphTasks(projectId: string, statusId: string, count: number) {
  const items = Array.from({ length: count }, (_, position) => ({ id: randomUUID(), packageId: randomUUID(), position }));
  await h.db.sql.begin(async tx => {
    const packages = items.map(t => ({ id: t.packageId, workspace_id: TEAM, project_id: projectId, origin: 'new_task', estimate_minutes: 30 }));
    await tx`insert into work_packages ${tx(packages, 'id', 'workspace_id', 'project_id', 'origin', 'estimate_minutes')}`;
    const tasks = items.map(t => ({ id: t.id, workspace_id: TEAM, project_id: projectId, work_package_id: t.packageId, title: `Пограничный узел ${t.position + 1}`, status_id: statusId, position: t.position }));
    await tx`insert into tasks ${tx(tasks, 'id', 'workspace_id', 'project_id', 'work_package_id', 'title', 'status_id', 'position')}`;
  });
  return items.map(t => t.id);
}
async function bulkGraphEdges(pairs: readonly (readonly [string, string])[]) {
  const now = new Date().toISOString();
  const edges = pairs.map(([predecessor_task_id, successor_task_id]) => ({ id: randomUUID(), workspace_id: TEAM, predecessor_task_id, successor_task_id, type: 'finish_to_start', state: 'active', revision: 1, created_at: now, updated_at: now }));
  await h.db.sql`insert into task_dependencies ${h.db.sql(edges, 'id', 'workspace_id', 'predecessor_task_id', 'successor_task_id', 'type', 'state', 'revision', 'created_at', 'updated_at')}`;
}

describe('P4a actual dependency commands and graph projections', () => {
  beforeAll(async () => { h = await planningHarness('p4a_dependencies'); ({ owner, replica, member, viewer, outsider } = p4aClients(h)); }, 60_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  it('serializes opposite concurrent edges so exactly one commits and no cycle exists', async () => {
    const f = await fixture('Конкурентные связи', 2);
    const requests = [owner.post('/dependencies', owner.edgeBody(f.a.id, f.b.id)), replica.post('/dependencies', replica.edgeBody(f.b.id, f.a.id))];
    const responses = await Promise.all(requests);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    expectError(required(responses.find(r => r.status === 409)), 409, 'DEPENDENCY_CYCLE');
    const edge = expectEnvelope(required(responses.find(r => r.status === 201)), 201, taskDependencyResponseSchema).data;
    expect(await owner.edges({ projectId: f.project.id })).toEqual([edge]);
    expect((await owner.graph(f.project.id, [f.a.id], 2)).edges).toEqual([edge]);
  });

  it('rejects a cross-project cycle/self/foreign identity without partial mutation', async () => {
    const f = await fixture('Цепочка', 2), other = await planningProject(owner, 'Соседний проект');
    const c = await planningTask(owner, other.project);
    const ab = await owner.createEdge(f.a.id, f.b.id), bc = await owner.createEdge(f.b.id, c.id);
    await expectNoChange(async () => {
      expectError(await owner.post('/dependencies', owner.edgeBody(c.id, f.a.id)), 409, 'DEPENDENCY_CYCLE');
      expectError(await owner.post('/dependencies', owner.edgeBody(f.a.id, f.a.id)), 422, 'DOMAIN_VALIDATION_FAILED');
    });
    const foreign = await planningProject(outsider, 'Чужой проект'), foreignTask = await planningTask(outsider, foreign.project);
    await expectNoChange(async () => {
      expectError(await owner.post('/dependencies', owner.edgeBody(f.a.id, foreignTask.id)), 404, 'NOT_FOUND', [foreignTask.title]);
      expectError(await owner.get(owner.graphPath(f.project.id, [foreignTask.id])), 404, 'NOT_FOUND', [foreignTask.title]);
      expectError(await viewer.put(viewer.layoutPath(f.project.id), { expectedRevision: 0, positions: [{ taskId: foreignTask.id, x: 0, y: 0 }] }), 404, 'NOT_FOUND', [foreignTask.title]);
    });
    expect((await owner.graph(f.project.id, [f.a.id], 2)).edges.map(e => e.id).sort()).toEqual([ab.id, bc.id].sort());
  });

  it('keeps stable edge identity through remove/restore, no-op and key replay, with route/body mismatch rejected', async () => {
    const f = await fixture('Жизненный цикл связи'); const c = required(f.c), key = randomUUID();
    const body = owner.edgeBody(f.a.id, f.b.id);
    const edge = expectEnvelope(await owner.post('/dependencies', body, key), 201, taskDependencyResponseSchema).data;
    await expectNoChange(async () => {
      expectEnvelope(await owner.post('/dependencies', body, key), 201, taskDependencyResponseSchema);
      expectError(await owner.post('/dependencies', owner.edgeBody(f.a.id, c.id), key), 409, 'IDEMPOTENCY_KEY_REUSED');
      expectError(await owner.post('/dependencies', body), 409, 'REVISION_CONFLICT');
    });
    const removed = await owner.setEdge(edge, 'removed'); expect(removed).toMatchObject({ id: edge.id, revision: 2, state: 'removed' });
    const before = await databaseSnapshot(h.db.sql), unchanged = await owner.setEdge(removed, 'removed');
    expect(unchanged).toEqual(removed); expect(changedTables(before, await databaseSnapshot(h.db.sql))).toEqual(['command_idempotency']);
    expectError(await owner.post('/dependencies', body), 409, 'REVISION_CONFLICT');
    const restored = await owner.setEdge(removed, 'active'); expect(restored).toMatchObject({ id: edge.id, revision: 3 });
    await expectNoChange(async () => { expectError(await owner.patch(`/dependencies/${edge.id}`, { expectedRevision: 1, state: 'removed' }), 409, 'REVISION_CONFLICT'); });
    expect(await owner.edges({ taskId: f.b.id, direction: 'incoming', state: 'all' })).toEqual([restored]);
  });

  it('checks the full graph when restoring a removed edge and when roots exclude an upstream blocker', async () => {
    const f = await fixture('Восстановление цикла'); const c = required(f.c);
    const ab = await owner.createEdge(f.a.id, f.b.id); const removed = await owner.setEdge(ab, 'removed');
    await owner.createEdge(f.b.id, c.id); await owner.createEdge(c.id, f.a.id);
    await expectNoChange(async () => { expectError(await owner.patch(`/dependencies/${ab.id}`, { expectedRevision: removed.revision, state: 'active' }), 409, 'DEPENDENCY_CYCLE'); });
    const graph = await owner.graph(f.project.id, [f.a.id], 0);
    expect(graph.nodes).toHaveLength(1); expect(graph.edges).toEqual([]);
    expect(graph.nodes[0]).toMatchObject({ hasOutsideDependencies: true, outsideUnresolvedPredecessorCount: 1, blocking: { isBlocked: true, unresolvedCount: 1 } });
  });

  it('makes warn/enforce authoritative while metadata and same-status writes remain valid', async () => {
    const f = await fixture('Статусная политика', 2); await owner.createEdge(f.a.id, f.b.id);
    const beforeRead = await databaseSnapshot(h.db.sql);
    expect(await owner.policy(f.project.id)).toEqual({ projectId: f.project.id, mode: 'warn', revision: 0, updatedAt: null });
    expect(await databaseSnapshot(h.db.sql)).toEqual(beforeRead);
    expect((await owner.blocking(f.b.id)).data.summary).toMatchObject({ isBlocked: true, unresolvedCount: 1, canStart: true, canComplete: true, violatesCurrentStatus: false });
    const progress = statusInGroup(await owner.tasks.listStatuses(f.project.id), 'in_progress');
    const statusKey = randomUUID(), statusInput = { expectedRevision: f.b.revision, statusId: progress.id };
    let b = expectEnvelope(await owner.patch(`/tasks/${f.b.id}`, statusInput, statusKey), 200, taskResponseSchema).data;
    const policy = await owner.setPolicy(f.project.id, 'enforce');
    await expectNoChange(async () => { expect(expectEnvelope(await owner.patch(`/tasks/${f.b.id}`, statusInput, statusKey), 200, taskResponseSchema).data).toEqual(b); });
    expect((await owner.blocking(b.id)).data.summary).toMatchObject({ canStart: false, canComplete: false, violatesCurrentStatus: true });
    b = await owner.tasks.updateTask(b.id, { expectedRevision: b.revision, title: 'Метаданные остаются редактируемыми', statusId: b.statusId });
    await expectNoChange(async () => { expectError(await owner.patch(`/tasks/${b.id}`, { expectedRevision: b.revision, statusId: f.done.id }), 422, 'DOMAIN_VALIDATION_FAILED'); });
    await owner.tasks.updateTask(f.a.id, { expectedRevision: f.a.revision, statusId: f.done.id });
    b = await owner.tasks.updateTask(b.id, { expectedRevision: b.revision, statusId: f.done.id });
    expect((await owner.blocking(b.id)).data.summary).toMatchObject({ isBlocked: false, canComplete: true, violatesCurrentStatus: false });
    const currentA = await owner.tasks.getTask(f.a.id); await owner.tasks.updateTask(currentA.id, { expectedRevision: currentA.revision, statusId: f.todo.id });
    expect((await owner.blocking(b.id)).data.summary.violatesCurrentStatus).toBe(true);
    const beforeNoop = await databaseSnapshot(h.db.sql); expect(await owner.setPolicy(f.project.id, 'enforce', policy.revision)).toEqual(policy);
    expect(changedTables(beforeNoop, await databaseSnapshot(h.db.sql))).toEqual(['command_idempotency']);
  });

  it('retains archived/cancelled unresolved blockers and resolves only done status', async () => {
    const f = await fixture('Архив и отмена', 2); await owner.createEdge(f.a.id, f.b.id);
    const cancelled = statusInGroup(await owner.tasks.listStatuses(f.project.id), 'cancelled');
    let a = await owner.tasks.updateTask(f.a.id, { expectedRevision: f.a.revision, statusId: cancelled.id });
    a = await owner.tasks.archiveTask(a.id, a.revision);
    expect((await owner.blocking(f.b.id)).data.summary.unresolvedCount).toBe(1);
    const g = await owner.graph(f.project.id, [f.b.id], 1); expect(g.nodes.some(n => n.task.id === a.id && n.task.archivedAt !== null && n.context.status.group === 'cancelled')).toBe(true);
    a = await owner.tasks.restoreTask(a.id, a.revision); a = await owner.tasks.updateTask(a.id, { expectedRevision: a.revision, statusId: f.done.id });
    await owner.tasks.archiveTask(a.id, a.revision);
    expect((await owner.blocking(f.b.id)).data.summary.unresolvedCount).toBe(0);
  });

  it('rejects new/restored blockers for an already started enforce successor, without rewriting its status', async () => {
    const f = await fixture('Новая блокировка', 2); const edge = await owner.createEdge(f.a.id, f.b.id), removed = await owner.setEdge(edge, 'removed');
    const b = await owner.tasks.updateTask(f.b.id, { expectedRevision: f.b.revision, statusId: f.done.id }); await owner.setPolicy(f.project.id, 'enforce');
    await expectNoChange(async () => { expectError(await owner.patch(`/dependencies/${edge.id}`, { expectedRevision: removed.revision, state: 'active' }), 422, 'DOMAIN_VALIDATION_FAILED'); });
    expect(await owner.tasks.getTask(b.id)).toEqual(b);
  });

  it('returns exact induced neighborhoods with cross-project metadata and strict normalized CSV input', async () => {
    const f = await fixture('Корни графа', 2), other = await planningProject(owner, 'Внешний узел'); const c = await planningTask(owner, other.project);
    await owner.createEdge(f.a.id, f.b.id); await owner.createEdge(f.b.id, c.id);
    const g = await owner.graph(f.project.id, [f.a.id.toUpperCase()], 2);
    expect(g.rootTaskIds).toEqual([f.a.id]); expect(g.nodes.map(n => n.task.id).sort()).toEqual([f.a.id, f.b.id, c.id].sort());
    expect(g.nodes.find(n => n.task.id === c.id)?.context).toMatchObject({ project: { id: other.project.id, name: other.project.name }, status: { id: c.statusId, group: 'todo' } });
    await expectNoChange(async () => {
      for (const query of [`rootTaskIds=${f.a.id},${f.a.id}`, `rootTaskIds=${f.a.id}&rootTaskIds=${f.b.id}`, `rootTaskIds[]=${f.a.id}`, `rootTaskIds=${f.a.id}&neighborDepth=3`]) expectError(await owner.get(`/projects/${f.project.id}/graph?${query}`), 400, 'VALIDATION_FAILED');
      expectError(await owner.get(owner.graphPath(f.project.id, [c.id])), 422, 'DOMAIN_VALIDATION_FAILED');
    });
  });

  it('keeps complete blocker summaries while paging and rejects stale/source-mismatched cursors', async () => {
    const f = await fixture('Страницы блокировок'); const c = required(f.c);
    await owner.createEdge(f.a.id, f.b.id); await owner.createEdge(c.id, f.b.id);
    const first = await owner.blocking(f.b.id, 1); expect(first.data.summary.unresolvedCount).toBe(2); expect(first.data.blockers).toHaveLength(1); const cursor = required(first.meta.nextCursor ?? undefined);
    const second = await owner.blocking(f.b.id, 1, cursor); expect(second.data.summary).toEqual(first.data.summary); expect(second.data.blockers).toHaveLength(1); expect(second.meta.nextCursor).toBeNull();
    expect(new Set([...first.data.blockers, ...second.data.blockers].map(b => b.dependency.id)).size).toBe(2);
    expectError(await member.get(`/tasks/${f.b.id}/blocking?limit=1&cursor=${encodeURIComponent(cursor)}`), 400, 'VALIDATION_FAILED');
    await owner.tasks.updateTask(f.a.id, { expectedRevision: f.a.revision, title: 'Изменён источник страницы' });
    expectError(await owner.get(`/tasks/${f.b.id}/blocking?limit=1&cursor=${encodeURIComponent(cursor)}`), 400, 'VALIDATION_FAILED');
    const page = expectEnvelope(await owner.get(`/dependencies?projectId=${f.project.id}&limit=1&state=all`), 200, taskDependencyListResponseSchema);
    expect(page.meta.nextCursor).not.toBeNull();
    expect(await owner.edges({ projectId: f.project.id, state: 'all' })).toHaveLength(2);
  });

  it('scopes layout to the current member, preserves full hidden positions and rejects stale/foreign writes', async () => {
    const f = await fixture('Личная раскладка'), other = await planningProject(owner, 'Сосед в раскладке'); const c = await planningTask(owner, other.project);
    const before = await databaseSnapshot(h.db.sql), empty = await viewer.layout(f.project.id);
    expect(empty).toMatchObject({ membershipId: MEMBERS.teamViewer, revision: 0, positions: [], updatedAt: null }); expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expect(await owner.saveLayout(f.project.id, [], 0)).toMatchObject({ revision: 0, positions: [], updatedAt: null });
    expect(changedTables(before, await databaseSnapshot(h.db.sql))).toEqual(['command_idempotency']);
    const positions = [{ taskId: f.a.id, x: 10.5, y: -20 }, { taskId: c.id, x: 600, y: 120 }], key = randomUUID();
    const saved = await viewer.saveLayout(f.project.id, positions, 0, key); expect(saved.revision).toBe(1); expect(saved.positions).toHaveLength(2);
    await expectNoChange(async () => { expect(await viewer.saveLayout(f.project.id, positions, 0, key)).toEqual(saved); expectError(await viewer.put(viewer.layoutPath(other.project.id), { expectedRevision: 0, positions }, key), 409, 'IDEMPOTENCY_KEY_REUSED'); });
    expect((await owner.layout(f.project.id)).revision).toBe(0);
    const beforeNoop = await databaseSnapshot(h.db.sql); expect(await viewer.saveLayout(f.project.id, [...positions].reverse(), saved.revision)).toEqual(saved);
    expect(changedTables(beforeNoop, await databaseSnapshot(h.db.sql))).toEqual(['command_idempotency']);
    const onlyVisibleMoved = positions.map(p => p.taskId === f.a.id ? { ...p, x: 40 } : p), edited = await viewer.saveLayout(f.project.id, onlyVisibleMoved, saved.revision);
    expect(edited.positions).toEqual(expect.arrayContaining(onlyVisibleMoved));
    await expectNoChange(async () => { expectError(await viewer.put(viewer.layoutPath(f.project.id), { expectedRevision: saved.revision, positions: [] }), 409, 'REVISION_CONFLICT'); });
    const reset = await viewer.saveLayout(f.project.id, [], edited.revision); expect(reset.positions).toEqual([]); expect(await owner.tasks.getTask(c.id)).toEqual(c);
  });

  it('checks owner/admin management, viewer write restrictions and current access before exact replay', async () => {
    const f = await fixture('Права графа', 2), key = randomUUID(), body = owner.edgeBody(f.a.id, f.b.id);
    expectError(await viewer.post('/dependencies', body), 403, 'CAPABILITY_REQUIRED');
    expectError(await member.patch(`/projects/${f.project.id}/dependency-policy`, { expectedRevision: 0, mode: 'enforce' }), 403, 'CAPABILITY_REQUIRED');
    const edge = await owner.createEdge(f.a.id, f.b.id, key); expect((await viewer.blocking(f.b.id)).data.blockers[0]?.dependency.id).toBe(edge.id);
    const row = await membershipRow(h.db.sql, TEAM, MEMBERS.teamOwner);
    try { await revokeMembership(h.db.sql, TEAM, MEMBERS.teamOwner); await expectNoChange(async () => { expectError(await owner.post('/dependencies', body, key), 404, 'NOT_FOUND'); expectError(await owner.get(owner.graphPath(f.project.id, [f.a.id])), 404, 'NOT_FOUND'); }); }
    finally { await restoreMembership(h.db.sql, TEAM, MEMBERS.teamOwner, row); }
    expect((await owner.graph(f.project.id, [f.a.id])).edges).toEqual([edge]);
  });

  it('rolls back edge/state/audit/outbox/key on a late SQL failure and exact retry commits once', async () => {
    const f = await fixture('Поздний сбой', 2), key = randomUUID(), body = owner.edgeBody(f.a.id, f.b.id);
    await h.db.sql.unsafe("create function qa_dependency_key_fault() returns trigger language plpgsql as $$ begin raise exception 'qa_dependency_key_fault'; end $$");
    await h.db.sql.unsafe('create trigger qa_dependency_key_fault before insert on command_idempotency for each row execute function qa_dependency_key_fault()');
    try { await expectNoChange(async () => { expectError(await owner.post('/dependencies', body, key), 500, 'INTERNAL_ERROR', ['qa_dependency_key_fault']); }); }
    finally { await h.db.sql.unsafe('drop trigger qa_dependency_key_fault on command_idempotency'); await h.db.sql.unsafe('drop function qa_dependency_key_fault()'); }
    const edge = expectEnvelope(await owner.post('/dependencies', body, key), 201, taskDependencyResponseSchema).data;
    await expectNoChange(async () => { expect(expectEnvelope(await replica.post('/dependencies', body, key), 201, taskDependencyResponseSchema).data).toEqual(edge); });
    expect(await owner.edges({ projectId: f.project.id })).toEqual([edge]);
  });

  it('checks recurring template status transitions before any series/task/meeting mutation', async () => {
    const f = await fixture('Встреча и блокировка', 2), r = new P3bClient(owner.api, TEAM);
    const week = await owner.createPeriod({ projectId: f.project.id, name: uniqueName('Неделя серии'), localStart: '2027-01-04', timezone: 'UTC', cutoffAt: '2027-02-01T00:00:00.000Z' });
    const { series } = await r.create(f.project.id, { schedule: { startDate: week.localStart, localTime: '10:00', timezone: 'UTC', frequency: 'daily', plannedDurationMinutes: 30, end: { kind: 'after_count', count: 2 } }, template: { title: 'Шаблон под проверкой', statusId: f.todo.id, organizerMembershipId: MEMBERS.teamOwner, attendeeMembershipIds: [MEMBERS.teamOwner] }, targetPeriodIds: [week.id] });
    await r.materialize(week.id); const instances = (await r.instances(series.id, week.id)).map(located); const blocked = required(instances[1]); await owner.createEdge(f.a.id, blocked.taskId); await owner.setPolicy(f.project.id, 'enforce');
    const edit = { expectedRevision: series.revision, effectiveFromNominalDate: week.localStart, schedule: series.currentVersion.schedule, template: { ...series.currentVersion.template, statusId: f.done.id } };
    const preview = await r.previewEdit(series.id, edit);
    await expectNoChange(async () => { expectError(await r.post(`/recurrence-series/${series.id}/edit`, { ...edit, previewHash: preview.previewHash }), 422, 'DOMAIN_VALIDATION_FAILED'); });
    expect((await r.series(series.id)).revision).toBe(series.revision); for (const i of instances) expect((await owner.tasks.getTask(i.taskId)).statusId).toBe(f.todo.id); expect(await r.recordedWork(week.id)).toEqual([]);
  });

  it('returns exactly500 graph nodes, rejects501 without partial data, and still checks the global cycle', async () => {
    const f = await planningProject(owner, 'Граница500узлов');
    const nodes = await bulkGraphTasks(f.project.id, f.todo.id, 501), root = required(nodes[0]), last = required(nodes[500]);
    await bulkGraphEdges(nodes.slice(1, 500).map(id => [root, id] as const));
    const boundary = await owner.graph(f.project.id, [root], 1);
    expect(boundary.nodes).toHaveLength(500); expect(boundary.edges).toHaveLength(499);
    expect((await owner.graph(f.project.id, nodes.slice(0, 100), 0)).nodes).toHaveLength(100);
    expectError(await owner.get(owner.graphPath(f.project.id, nodes.slice(0, 101), 0)), 400, 'VALIDATION_FAILED');
    //500 positions exceed the ordinary16KiB body cap but fit the explicit256KiB layout route.
    const positions = nodes.slice(0, 500).map((taskId, i) => ({ taskId, x: i * 1.25, y: -i }));
    expect(JSON.stringify({ expectedRevision: 0, positions }).length).toBeGreaterThan(16 * 1024);
    const layout = await viewer.saveLayout(f.project.id, positions); expect(layout.positions).toHaveLength(500);
    expect((await viewer.layout(f.project.id)).positions).toEqual(layout.positions);
    expectError(await viewer.put(viewer.layoutPath(f.project.id), { expectedRevision: layout.revision, positions: [...positions, { taskId: last, x: 0, y: 0 }] }), 400, 'VALIDATION_FAILED');
    await bulkGraphEdges([[root, last]]);
    await expectNoChange(async () => {
      const response = await owner.get(owner.graphPath(f.project.id, [root], 1));
      expectError(response, 422, 'DOMAIN_VALIDATION_FAILED'); expect(response.json()).not.toHaveProperty('data');
      expectError(await owner.post('/dependencies', owner.edgeBody(last, root)), 409, 'DEPENDENCY_CYCLE');
    });
    const hidden = await owner.graph(f.project.id, [last], 0);
    expect(hidden.nodes).toHaveLength(1); expect(hidden.nodes[0]).toMatchObject({ outsideUnresolvedPredecessorCount: 1, blocking: { unresolvedCount: 1, isBlocked: true } });
  }, 60_000);

  it('returns exactly1000 induced edges, rejects1001 without partial data, and keeps complete blockers authoritative', async () => {
    const f = await planningProject(owner, 'Граница1000связей'), nodes = await bulkGraphTasks(f.project.id, f.todo.id, 46);
    const pairs: [string, string][] = [];
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) pairs.push([required(nodes[a]), required(nodes[b])]);
    await bulkGraphEdges(pairs.slice(0, 1000));
    const root = required(nodes[0]), extra = required(pairs[1000]);
    const boundary = await owner.graph(f.project.id, [root], 1);
    expect(boundary.nodes).toHaveLength(46); expect(boundary.edges).toHaveLength(1000);
    await bulkGraphEdges([extra]);
    await expectNoChange(async () => {
      const response = await owner.get(owner.graphPath(f.project.id, [root], 1));
      expectError(response, 422, 'DOMAIN_VALIDATION_FAILED'); expect(response.json()).not.toHaveProperty('data');
      expectError(await owner.post('/dependencies', owner.edgeBody(extra[1], root)), 409, 'DEPENDENCY_CYCLE');
    });
    const blocking = await owner.blocking(extra[1], 1);
    expect(blocking.data.summary.unresolvedCount).toBeGreaterThan(blocking.data.blockers.length);
  }, 60_000);

  it('saves only own layout while complete and incomplete overdue calendars remain entirely untouched', async () => {
    const f = await fixture('Раскладка без фиксации', 2), r = new P3bClient(owner.api, TEAM), cutoff = await pgClockPlus(h.db.sql, 8000);
    const weeks = [];
    for (const localStart of ['2027-01-11', '2027-01-18']) {
      const week = await owner.createPeriod({ projectId: f.project.id, name: uniqueName('Просроченный календарь'), localStart, timezone: 'UTC', cutoffAt: cutoff }); weeks.push(week);
      await r.create(f.project.id, { schedule: { startDate: localStart, localTime: '10:00', timezone: 'UTC', frequency: 'daily', plannedDurationMinutes: 30, end: { kind: 'after_count', count: 1 } }, template: { title: 'Календарь не относится к раскладке', statusId: f.todo.id, organizerMembershipId: MEMBERS.teamOwner, attendeeMembershipIds: [MEMBERS.teamOwner] }, targetPeriodIds: [week.id] });
    }
    await r.materialize(required(weeks[0]).id); expect(await pgClockBefore(h.db.sql, cutoff)).toBe(true); await waitPastPgClock(h.db.sql, cutoff);
    const before = await databaseSnapshot(h.db.sql); await viewer.saveLayout(f.project.id, [{ taskId: f.a.id, x: 12, y: 34 }]);
    const changed = changedTables(before, await databaseSnapshot(h.db.sql)); expect(changed.sort()).toEqual(['audit_events', 'command_idempotency', 'graph_layout_positions', 'graph_layouts', 'outbox_events', 'workspaces'].sort());
    for (const week of weeks) expect(await owner.baselines(week.id)).toEqual([]);
    expect((await r.readiness(required(weeks[1]).id)).missingCount).toBe(1);
  });
});
