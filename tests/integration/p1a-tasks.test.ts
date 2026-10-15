// Black-box acceptance for P1a projects, sections and tasks: the real API source entrypoint on a
// real PostgreSQL throwaway database, migrated and seeded by the actual @workloom/db CLIs. Actors
// come only from DEV_ACTOR_ID per API process (owner, a second owner process for persistence,
// viewer, outsider). Every independent scenario creates its own project so seed data or test
// order cannot fake correctness. Database evidence is row counts and whole-row digests of the
// confirmed P1a tables plus P0 audit/outbox and workspaces.change_seq; only the participant
// scenario reads named task_participants columns (migration 0001) to prove row stability.
import { randomUUID } from 'node:crypto';

import {
  taskResponseSchema,
  type CreateTaskInput,
  type ProjectDto,
  type TaskDto,
  type TaskParticipantDto,
  type TaskStatusDto,
} from '@workloom/contracts';
import { DEMO_WORKSPACES, FIXTURE_MEMBERSHIP_IDS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS } from '@workloom/db/fixtures';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApi, type ApiProcess } from './support/api-process.js';
import { migrateAndSeed } from './support/db-cli.js';
import type { RawResponse } from './support/http.js';
import {
  P1aClient,
  expectEnvelope,
  expectError,
  rowDelta,
  statusInGroup,
  uniqueName,
  writeSnapshot,
  type WriteSnapshot,
} from './support/p1a.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

// Fails the file at collection time when TEST_DATABASE_URL is missing or unsafe.
requireTestDatabaseUrl();

const TEAM_ID = FIXTURE_WORKSPACE_IDS.team;
const OUTSIDE_ID = FIXTURE_WORKSPACE_IDS.outside;
const M = FIXTURE_MEMBERSHIP_IDS;

function workspaceName(id: string): string {
  const workspace = DEMO_WORKSPACES.find((candidate) => candidate.id === id);
  if (!workspace) throw new Error('Demo workspace fixture missing from @workloom/db/fixtures.');
  return workspace.name;
}

interface ProjectFixture {
  readonly project: ProjectDto;
  readonly statuses: TaskStatusDto[];
  readonly todo: TaskStatusDto;
  readonly done: TaskStatusDto;
}

/** A new project and its bootstrapped statuses; status IDs are derived by group, never invented. */
async function freshProject(client: P1aClient, label: string): Promise<ProjectFixture> {
  const project = await client.createProject(uniqueName(label));
  expect(project).toMatchObject({ workspaceId: client.workspaceId, revision: 1, archivedAt: null });
  const statuses = await client.listStatuses(project.id);
  for (const status of statuses) {
    expect(status).toMatchObject({ workspaceId: client.workspaceId, projectId: project.id });
  }
  expect(new Set(statuses.map((status) => status.id)).size).toBe(statuses.length);
  return { project, statuses, todo: statusInGroup(statuses, 'todo'), done: statusInGroup(statuses, 'done') };
}

function taskInput(fixture: ProjectFixture, overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return { projectId: fixture.project.id, statusId: fixture.todo.id, title: uniqueName('Task'), ...overrides };
}

function byMembership(participants: readonly TaskParticipantDto[]): TaskParticipantDto[] {
  return [...participants].sort((a, b) => a.membershipId.localeCompare(b.membershipId));
}

function participant(task: TaskDto, membershipId: string): TaskParticipantDto {
  const row = task.participants.find((candidate) => candidate.membershipId === membershipId);
  if (!row) throw new Error(`Task ${task.id} has no participant row for membership ${membershipId}.`);
  return row;
}

function sortedIds(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id).sort();
}

/** Team budget of a task list: each work package counted once, whatever its task or participant count. */
function packageTotal(tasks: readonly TaskDto[]): number {
  const byPackage = new Map<string, number | null>();
  for (const task of tasks) {
    if (byPackage.has(task.workPackageId)) {
      expect(task.estimateMinutes, `tasks of package ${task.workPackageId} disagree`).toBe(byPackage.get(task.workPackageId));
    }
    byPackage.set(task.workPackageId, task.estimateMinutes);
  }
  return [...byPackage.values()].reduce<number>((sum, minutes) => sum + (minutes ?? 0), 0);
}

interface ParticipantRow {
  readonly active: boolean;
  readonly revision: number;
  readonly created_at: string;
}

/** P0 memberships columns (migration 0000); timestamps as text so a restore writes them back exactly. */
interface MembershipRow {
  readonly state: 'active' | 'revoked';
  readonly revision: number;
  readonly revoked_at: string | null;
  readonly updated_at: string;
}

type RejectionCase = readonly [label: string, run: () => Promise<RawResponse>];

async function expectAllRejected(
  cases: readonly RejectionCase[],
  status: number,
  code: string,
  hidden: readonly string[] = [],
): Promise<void> {
  for (const [label, run] of cases) {
    const response = await run();
    expect(response.status, `${label}: ${response.text()}`).toBe(status);
    expectError(response, status, code, hidden);
  }
}

describe('P1a projects, sections and tasks over HTTP on PostgreSQL', () => {
  let db: ThrowawayDatabase | undefined;
  const apis: ApiProcess[] = [];
  let owner: P1aClient;
  let replica: P1aClient;
  let viewer: P1aClient;
  let outsider: P1aClient;

  function sql(): postgres.Sql {
    if (!db) throw new Error('Throwaway database was not created.');
    return db.sql;
  }

  function snapshot(): Promise<WriteSnapshot> {
    return writeSnapshot(sql());
  }

  /** Stored task_participants rows for one (team workspace, task, membership) primary key. */
  async function participantRows(taskId: string, membershipId: string): Promise<ParticipantRow[]> {
    const db = sql();
    const rows = await db<ParticipantRow[]>`
      select active, revision, created_at::text as created_at
      from task_participants
      where workspace_id = ${TEAM_ID} and task_id = ${taskId} and membership_id = ${membershipId}`;
    return [...rows];
  }

  async function membershipRow(membershipId: string): Promise<MembershipRow> {
    const db = sql();
    const [row, ...extra] = await db<MembershipRow[]>`
      select state, revision, revoked_at::text as revoked_at, updated_at::text as updated_at
      from memberships
      where workspace_id = ${TEAM_ID} and id = ${membershipId}`;
    if (!row || extra.length > 0) throw new Error(`Expected one memberships row for ${membershipId}.`);
    return row;
  }

  async function start(actorId: string): Promise<ApiProcess> {
    if (!db) throw new Error('Throwaway database was not created.');
    const api = await startApi({ entry: 'source', databaseUrl: db.url, env: { DEV_ACTOR_ID: actorId } });
    apis.push(api);
    return api;
  }

  beforeAll(async () => {
    db = await createThrowawayDatabase('p1a');
    await migrateAndSeed(db.url);
    owner = new P1aClient(await start(FIXTURE_USER_IDS.owner), TEAM_ID);
    // Same actor, separate process: reads prove the rows are in PostgreSQL, not process memory.
    replica = new P1aClient(await start(FIXTURE_USER_IDS.owner), TEAM_ID);
    viewer = new P1aClient(await start(FIXTURE_USER_IDS.viewer), TEAM_ID);
    outsider = new P1aClient(await start(FIXTURE_USER_IDS.outsider), OUTSIDE_ID);
  });

  afterAll(async () => {
    // Stop every API before dropping its database.
    await Promise.all(apis.map((api) => api.stop()));
    await db?.drop();
  });

  describe('create, read and update', () => {
    it('persists a project, section and fully specified task, renamed by expected revision', async () => {
      const fixture = await freshProject(owner, 'Persist project');
      const { project } = fixture;
      expect(fixture.statuses.length).toBeGreaterThanOrEqual(2);

      const section = await owner.createSection(project.id, { name: uniqueName('Persist section') });
      expect(section).toMatchObject({ workspaceId: TEAM_ID, projectId: project.id, revision: 1, archivedAt: null });

      const input: CreateTaskInput = {
        projectId: project.id,
        sectionId: section.id,
        title: uniqueName('Persist task'),
        description: 'Synthetic description for the persistence scenario.',
        statusId: fixture.todo.id,
        responsibleMembershipId: M.teamMemberA,
        participantMembershipIds: [M.teamOwner, M.teamMemberA],
        dueDate: '2026-11-20',
        priority: 'high',
        estimateMinutes: 240,
      };
      const task = await owner.createTask(input);
      expect(task).toMatchObject({
        workspaceId: TEAM_ID,
        projectId: project.id,
        sectionId: section.id,
        parentTaskId: null,
        title: input.title,
        description: input.description,
        statusId: fixture.todo.id,
        responsibleMembershipId: M.teamMemberA,
        dueDate: '2026-11-20',
        priority: 'high',
        tags: [],
        estimateMinutes: 240,
        revision: 1,
        visibility: 'workspace',
        archivedAt: null,
      });
      expect(byMembership(task.participants)).toEqual(
        byMembership([
          { membershipId: M.teamOwner, role: 'assignee', active: true, revision: 1 },
          { membershipId: M.teamMemberA, role: 'assignee', active: true, revision: 1 },
        ]),
      );

      const renamedProject = await owner.updateProject(project.id, {
        expectedRevision: project.revision,
        name: uniqueName('Renamed project'),
      });
      expect(renamedProject.id).toBe(project.id);
      expect(renamedProject.name).not.toBe(project.name);
      expect(renamedProject.revision).toBeGreaterThan(project.revision);

      const renamedSection = await owner.updateSection(section.id, {
        expectedRevision: section.revision,
        name: uniqueName('Renamed section'),
      });
      expect(renamedSection).toMatchObject({ id: section.id, projectId: project.id });
      expect(renamedSection.name).not.toBe(section.name);
      expect(renamedSection.revision).toBeGreaterThan(section.revision);

      const retitled = await owner.updateTask(task.id, { expectedRevision: task.revision, title: uniqueName('Retitled task') });
      // Title edits move only the task revision; package and participant-set revisions are independent.
      expect(retitled).toMatchObject({
        id: task.id,
        workPackageId: task.workPackageId,
        workPackageRevision: task.workPackageRevision,
        participantsRevision: task.participantsRevision,
        estimateMinutes: 240,
      });
      expect(retitled.title).not.toBe(task.title);
      expect(retitled.revision).toBeGreaterThan(task.revision);

      expect(await replica.getProject(project.id)).toEqual(renamedProject);
      expect((await replica.listProjects()).find((row) => row.id === project.id)).toEqual(renamedProject);
      expect((await replica.listSections(project.id)).find((row) => row.id === section.id)).toEqual(renamedSection);
      expect(await replica.getTask(task.id)).toEqual(retitled);

      const before = await snapshot();
      expectError(
        await owner.patch(`/tasks/${task.id}`, { expectedRevision: task.revision, title: 'Stale title must not apply' }),
        409,
        'REVISION_CONFLICT',
      );
      expect(await snapshot()).toEqual(before);
      expect(await replica.getTask(task.id)).toEqual(retitled);
    });

    it('archives a project and a section by flag and keeps both rows', async () => {
      const fixture = await freshProject(owner, 'Archive flag project');
      const section = await owner.createSection(fixture.project.id, { name: uniqueName('Archive flag section') });
      const before = await snapshot();

      const archivedSection = await owner.updateSection(section.id, { expectedRevision: section.revision, archived: true });
      expect(archivedSection).toMatchObject({ id: section.id, name: section.name, projectId: fixture.project.id });
      expect(archivedSection.archivedAt).not.toBeNull();
      expect(archivedSection.revision).toBeGreaterThan(section.revision);

      const archivedProject = await owner.updateProject(fixture.project.id, {
        expectedRevision: fixture.project.revision,
        archived: true,
      });
      expect(archivedProject).toMatchObject({ id: fixture.project.id, name: fixture.project.name });
      expect(archivedProject.archivedAt).not.toBeNull();
      expect(archivedProject.revision).toBeGreaterThan(fixture.project.revision);
      expect(await replica.getProject(fixture.project.id)).toEqual(archivedProject);

      const delta = rowDelta(before, await snapshot());
      expect({ projects: delta.projects, sections: delta.sections }).toEqual({ projects: 0, sections: 0 });
    });
  });

  describe('shared work packages', () => {
    it('shares one estimate across detail subtasks, keeps added scope separate and guards the package revision', async () => {
      const fixture = await freshProject(owner, 'Package project');
      const projectId = fixture.project.id;

      const root = await owner.createTask(
        taskInput(fixture, {
          title: uniqueName('Package root'),
          estimateMinutes: 480,
          participantMembershipIds: [M.teamOwner, M.teamMemberA, M.teamMemberB],
        }),
      );
      expect(root.estimateMinutes).toBe(480);
      expect(root.participants.filter((row) => row.active)).toHaveLength(3);

      const child = await owner.createTask(taskInput(fixture, { title: uniqueName('Detail child'), parentTaskId: root.id }));
      const sibling = await owner.createTask(
        taskInput(fixture, { title: uniqueName('Detail sibling'), parentTaskId: root.id, workScope: 'detail' }),
      );
      const added = await owner.createTask(
        taskInput(fixture, {
          title: uniqueName('Added scope child'),
          parentTaskId: root.id,
          workScope: 'added_scope',
          estimateMinutes: 120,
        }),
      );
      for (const detail of [child, sibling]) {
        expect(detail).toMatchObject({
          parentTaskId: root.id,
          workPackageId: root.workPackageId,
          workPackageRevision: root.workPackageRevision,
          estimateMinutes: 480,
        });
      }
      expect(added).toMatchObject({ parentTaskId: root.id, estimateMinutes: 120 });
      expect(added.workPackageId).not.toBe(root.workPackageId);

      const rows = await owner.listAllTasks({ projectId });
      expect(sortedIds(rows)).toEqual(sortedIds([root, child, sibling, added]));
      expect(new Set(rows.map((row) => row.workPackageId)).size).toBe(2);
      // Three participants on one package: the budget is neither split nor multiplied per person.
      expect(rows.find((row) => row.id === root.id)).toMatchObject({ estimateMinutes: 480 });
      expect(packageTotal(rows)).toBe(600);

      const edited = await owner.updateTask(child.id, {
        expectedRevision: child.revision,
        expectedWorkPackageRevision: child.workPackageRevision,
        estimateMinutes: 600,
      });
      expect(edited).toMatchObject({ id: child.id, workPackageId: root.workPackageId, estimateMinutes: 600 });
      expect(edited.workPackageRevision).toBeGreaterThan(root.workPackageRevision);

      for (const id of [root.id, child.id, sibling.id]) {
        expect(await owner.getTask(id)).toMatchObject({
          id,
          workPackageId: root.workPackageId,
          workPackageRevision: edited.workPackageRevision,
          estimateMinutes: 600,
        });
      }
      expect(await owner.getTask(added.id)).toMatchObject({
        id: added.id,
        workPackageId: added.workPackageId,
        workPackageRevision: added.workPackageRevision,
        estimateMinutes: 120,
      });
      expect(packageTotal(await owner.listAllTasks({ projectId }))).toBe(720);

      // Current task revision, stale package revision.
      const fresh = await owner.getTask(child.id);
      const before = await snapshot();
      expectError(
        await owner.patch(`/tasks/${child.id}`, {
          expectedRevision: fresh.revision,
          expectedWorkPackageRevision: child.workPackageRevision,
          estimateMinutes: 900,
        }),
        409,
        'REVISION_CONFLICT',
      );
      expect(await snapshot()).toEqual(before);
      const after = await owner.listAllTasks({ projectId });
      for (const id of [root.id, child.id, sibling.id]) {
        expect(after.find((row) => row.id === id)).toMatchObject({
          estimateMinutes: 600,
          workPackageRevision: edited.workPackageRevision,
        });
      }
      expect(after.find((row) => row.id === added.id)).toMatchObject({ estimateMinutes: 120 });
      expect(await owner.getTask(child.id)).toEqual(fresh);
    });
  });

  describe('participants', () => {
    it('soft-removes and re-adds participant rows under an independent participants revision', async () => {
      const fixture = await freshProject(owner, 'Participants project');
      const beforeCreate = await snapshot();
      const task = await owner.createTask(
        taskInput(fixture, { participantMembershipIds: [M.teamOwner, M.teamMemberA, M.teamMemberB] }),
      );
      const afterCreate = await snapshot();
      expect(rowDelta(beforeCreate, afterCreate).task_participants).toBe(3);
      const allThree = [M.teamOwner, M.teamMemberA, M.teamMemberB].sort();
      const [createdRow, ...extraCreated] = await participantRows(task.id, M.teamMemberB);
      if (!createdRow) throw new Error(`No task_participants row for membership ${M.teamMemberB} after create.`);
      expect(extraCreated).toEqual([]);
      expect(createdRow).toMatchObject({ active: true, revision: participant(task, M.teamMemberB).revision });

      const removed = await owner.updateTask(task.id, {
        expectedRevision: task.revision,
        expectedParticipantsRevision: task.participantsRevision,
        participantMembershipIds: [M.teamOwner, M.teamMemberA],
      });
      expect(removed.participantsRevision).toBeGreaterThan(task.participantsRevision);
      expect(removed.participants.map((row) => row.membershipId).sort()).toEqual(allThree);
      expect(participant(removed, M.teamMemberB)).toMatchObject({ role: 'assignee', active: false });
      expect(participant(removed, M.teamMemberB).revision).toBeGreaterThan(participant(task, M.teamMemberB).revision);
      expect(participant(removed, M.teamOwner)).toEqual(participant(task, M.teamOwner));
      expect(participant(removed, M.teamMemberA)).toEqual(participant(task, M.teamMemberA));
      const afterRemove = await snapshot();
      // The removed row stays in task_participants.
      expect(rowDelta(afterCreate, afterRemove).task_participants).toBe(0);
      // Same stored row, deactivated in place: original created_at, revision as reported by the DTO.
      expect(await participantRows(task.id, M.teamMemberB)).toEqual([
        { active: false, revision: participant(removed, M.teamMemberB).revision, created_at: createdRow.created_at },
      ]);

      const readded = await owner.updateTask(task.id, {
        expectedRevision: removed.revision,
        expectedParticipantsRevision: removed.participantsRevision,
        participantMembershipIds: [M.teamOwner, M.teamMemberA, M.teamMemberB],
      });
      expect(readded.participantsRevision).toBeGreaterThan(removed.participantsRevision);
      expect(readded.participants.map((row) => row.membershipId).sort()).toEqual(allThree);
      expect(participant(readded, M.teamMemberB)).toMatchObject({ role: 'assignee', active: true });
      expect(participant(readded, M.teamMemberB).revision).toBeGreaterThan(participant(removed, M.teamMemberB).revision);
      // Re-adding reactivates the same row instead of inserting a second one.
      expect(rowDelta(afterRemove, await snapshot()).task_participants).toBe(0);
      expect(await participantRows(task.id, M.teamMemberB)).toEqual([
        { active: true, revision: participant(readded, M.teamMemberB).revision, created_at: createdRow.created_at },
      ]);

      const fresh = await owner.getTask(task.id);
      expect(fresh).toEqual(readded);
      const beforeStale = await snapshot();
      expectError(
        await owner.patch(`/tasks/${task.id}`, {
          expectedRevision: fresh.revision,
          expectedParticipantsRevision: removed.participantsRevision,
          participantMembershipIds: [M.teamOwner],
          title: 'Partial change must not apply',
        }),
        409,
        'REVISION_CONFLICT',
      );
      expect(await snapshot()).toEqual(beforeStale);
      expect(await owner.getTask(task.id)).toEqual(fresh);
    });

    it('keeps a revoked member already on a task but refuses reactivating or newly assigning them with 404', async () => {
      const fixture = await freshProject(owner, 'Revoked member project');
      const task = await owner.createTask(
        taskInput(fixture, { responsibleMembershipId: M.teamMemberB, participantMembershipIds: [M.teamMemberA, M.teamMemberB] }),
      );
      expect(task.responsibleMembershipId).toBe(M.teamMemberB);
      expect(participant(task, M.teamMemberB)).toMatchObject({ active: true });

      const original = await membershipRow(M.teamMemberB);
      expect(original).toMatchObject({ state: 'active', revoked_at: null });
      await sql()`
        update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1, updated_at = now()
        where workspace_id = ${TEAM_ID} and id = ${M.teamMemberB}`;
      try {
        const revoked = await membershipRow(M.teamMemberB);
        expect(revoked).toMatchObject({ state: 'revoked', revision: original.revision + 1 });
        expect(revoked.revoked_at).not.toBeNull();

        // Holding the reference is not a new assignment: a title edit leaves both in place.
        const retitled = await owner.updateTask(task.id, { expectedRevision: task.revision, title: uniqueName('Revoked retitle') });
        expect(retitled.responsibleMembershipId).toBe(M.teamMemberB);
        expect(participant(retitled, M.teamMemberB)).toEqual(participant(task, M.teamMemberB));

        // Re-sending the same responsible person and active participant set is allowed too.
        const resent = await owner.updateTask(task.id, {
          expectedRevision: retitled.revision,
          responsibleMembershipId: M.teamMemberB,
          expectedParticipantsRevision: retitled.participantsRevision,
          participantMembershipIds: [M.teamMemberA, M.teamMemberB],
        });
        expect(resent.responsibleMembershipId).toBe(M.teamMemberB);
        expect(byMembership(resent.participants)).toEqual(byMembership(retitled.participants));
        expect(await replica.getTask(task.id)).toEqual(resent);

        // Removing never needs an active membership; the row stays, inactive.
        const removed = await owner.updateTask(task.id, {
          expectedRevision: resent.revision,
          expectedParticipantsRevision: resent.participantsRevision,
          participantMembershipIds: [M.teamMemberA],
        });
        expect(participant(removed, M.teamMemberB)).toMatchObject({ active: false });
        expect(removed.responsibleMembershipId).toBe(M.teamMemberB);

        const before = await snapshot();
        await expectAllRejected(
          [
            [
              'reactivate the revoked participant row',
              () =>
                owner.patch(`/tasks/${task.id}`, {
                  expectedRevision: removed.revision,
                  expectedParticipantsRevision: removed.participantsRevision,
                  participantMembershipIds: [M.teamMemberA, M.teamMemberB],
                }),
            ],
            [
              'create with revoked responsible',
              () => owner.post('/tasks', taskInput(fixture, { responsibleMembershipId: M.teamMemberB })),
            ],
            [
              'create with revoked participant',
              () => owner.post('/tasks', taskInput(fixture, { participantMembershipIds: [M.teamMemberA, M.teamMemberB] })),
            ],
          ],
          404,
          'NOT_FOUND',
        );
        expect(await snapshot()).toEqual(before);
        expect(await owner.getTask(task.id)).toEqual(removed);
        expect(await membershipRow(M.teamMemberB)).toEqual(revoked);
      } finally {
        // Bind timestamps as text: an inferred timestamptz parameter goes through Date and drops microseconds.
        await sql()`
          update memberships
          set state = ${original.state}::membership_state, revoked_at = ${original.revoked_at}::text::timestamptz,
            revision = ${original.revision}, updated_at = ${original.updated_at}::text::timestamptz
          where workspace_id = ${TEAM_ID} and id = ${M.teamMemberB}`;
      }
      expect(await membershipRow(M.teamMemberB)).toEqual(original);
    });
  });

  describe('cross-reference validation', () => {
    it('rejects same-workspace wrong-project references and parent cycles with 422 and writes nothing', async () => {
      const a = await freshProject(owner, 'Reference project A');
      const b = await freshProject(owner, 'Reference project B');
      const allStatusIds = [...a.statuses, ...b.statuses].map((status) => status.id);
      expect(new Set(allStatusIds).size).toBe(allStatusIds.length);

      const sectionA = await owner.createSection(a.project.id, { name: uniqueName('Section A') });
      const sectionB = await owner.createSection(b.project.id, { name: uniqueName('Section B') });
      const parentB = await owner.createTask(taskInput(b, { sectionId: sectionB.id, title: uniqueName('Parent in B') }));
      const created = await owner.createTask(taskInput(a, { sectionId: sectionA.id, title: uniqueName('Task in A') }));
      const firstCreated = await owner.createTask(taskInput(a, { title: uniqueName('Tree first') }));
      const secondCreated = await owner.createTask(taskInput(a, { title: uniqueName('Tree second'), parentTaskId: firstCreated.id }));
      const thirdCreated = await owner.createTask(taskInput(a, { title: uniqueName('Tree third'), parentTaskId: secondCreated.id }));

      // Fresh reads after the whole tree exists, so revisions are current.
      const [taskA, first, second, third] = await Promise.all(
        [created, firstCreated, secondCreated, thirdCreated].map((task) => owner.getTask(task.id)),
      );
      expect(second.workPackageId).toBe(first.workPackageId);
      expect(third.workPackageId).toBe(first.workPackageId);
      const before = await snapshot();

      await expectAllRejected(
        [
          ['create with section of B', () => owner.post('/tasks', taskInput(a, { sectionId: sectionB.id }))],
          ['create with status of B', () => owner.post('/tasks', taskInput(a, { statusId: b.todo.id }))],
          ['create with parent in B', () => owner.post('/tasks', taskInput(a, { parentTaskId: parentB.id }))],
          [
            'move to section of B',
            () => owner.patch(`/tasks/${taskA.id}`, { expectedRevision: taskA.revision, sectionId: sectionB.id }),
          ],
          [
            'move to status of B',
            () => owner.patch(`/tasks/${taskA.id}`, { expectedRevision: taskA.revision, statusId: b.todo.id }),
          ],
          [
            'reparent under task in B',
            () => owner.patch(`/tasks/${taskA.id}`, { expectedRevision: taskA.revision, parentTaskId: parentB.id }),
          ],
          [
            'parent is itself',
            () => owner.patch(`/tasks/${first.id}`, { expectedRevision: first.revision, parentTaskId: first.id }),
          ],
          [
            'first → second → third, then first under third',
            () => owner.patch(`/tasks/${first.id}`, { expectedRevision: first.revision, parentTaskId: third.id }),
          ],
        ],
        422,
        'DOMAIN_VALIDATION_FAILED',
      );

      expect(await snapshot()).toEqual(before);
      for (const task of [taskA, first, second, third]) expect(await owner.getTask(task.id)).toEqual(task);
    });

    it('answers 404 without foreign names for references into another workspace', async () => {
      const foreign = await freshProject(outsider, 'Outside secret project');
      const foreignSection = await outsider.createSection(foreign.project.id, { name: uniqueName('Outside secret section') });
      const foreignTag = await outsider.createTag({ name: uniqueName('Outside secret tag') });
      const foreignTask = await outsider.createTask(taskInput(foreign, { title: uniqueName('Outside secret task') }));
      // Bootstrapped status names are generic defaults, so only names the outsider chose are secrets.
      const hidden = [workspaceName(OUTSIDE_ID), foreign.project.name, foreignSection.name, foreignTag.name, foreignTask.title];

      const team = await freshProject(owner, 'Reference project team');
      const teamTask = await owner.createTask(taskInput(team));
      const before = await snapshot();

      await expectAllRejected(
        [
          ['read foreign project', () => owner.get(`/projects/${foreign.project.id}`)],
          ['read foreign task', () => owner.get(`/tasks/${foreignTask.id}`)],
          [
            'create task in foreign project',
            () => owner.post('/tasks', { projectId: foreign.project.id, statusId: foreign.todo.id, title: uniqueName('Rejected') }),
          ],
          [
            'create section in foreign project',
            () => owner.post(`/projects/${foreign.project.id}/sections`, { name: uniqueName('Rejected section') }),
          ],
          ['create with foreign section', () => owner.post('/tasks', taskInput(team, { sectionId: foreignSection.id }))],
          ['create with foreign status', () => owner.post('/tasks', taskInput(team, { statusId: foreign.todo.id }))],
          ['create with foreign parent', () => owner.post('/tasks', taskInput(team, { parentTaskId: foreignTask.id }))],
          [
            'create with foreign participant membership',
            () => owner.post('/tasks', taskInput(team, { participantMembershipIds: [M.teamOwner, M.outsideOwner] })),
          ],
          ['create with foreign tag', () => owner.post('/tasks', taskInput(team, { tagIds: [foreignTag.id] }))],
          [
            'move to foreign status',
            () => owner.patch(`/tasks/${teamTask.id}`, { expectedRevision: teamTask.revision, statusId: foreign.todo.id }),
          ],
          [
            'reparent under foreign task',
            () => owner.patch(`/tasks/${teamTask.id}`, { expectedRevision: teamTask.revision, parentTaskId: foreignTask.id }),
          ],
        ],
        404,
        'NOT_FOUND',
        hidden,
      );

      expect(await snapshot()).toEqual(before);
      expect(await owner.getTask(teamTask.id)).toEqual(teamTask);
      expect(await outsider.getTask(foreignTask.id)).toEqual(foreignTask);
    });
  });

  describe('archived tags', () => {
    it('keeps an archived tag on the task that holds it but refuses new assignments with 422', async () => {
      const fixture = await freshProject(owner, 'Archived tag project');
      const tag = await owner.createTag({ name: uniqueName('Archived tag') });
      const tagged = await owner.createTask(taskInput(fixture, { title: uniqueName('Tagged task'), tagIds: [tag.id] }));
      const clean = await owner.createTask(taskInput(fixture, { title: uniqueName('Untagged task') }));
      expect(tagged.tags).toEqual([tag]);
      expect(clean.tags).toEqual([]);

      const archivedTag = await owner.updateTag(tag.id, { expectedRevision: tag.revision, archived: true });
      expect(archivedTag).toMatchObject({ id: tag.id, name: tag.name });
      expect(archivedTag.archivedAt).not.toBeNull();
      expect(archivedTag.revision).toBeGreaterThan(tag.revision);
      // The holding task reads the same tag ID, now archived.
      expect((await owner.getTask(tagged.id)).tags).toEqual([archivedTag]);

      const retitled = await owner.updateTask(tagged.id, { expectedRevision: tagged.revision, title: uniqueName('Tagged retitle') });
      expect(retitled.tags).toEqual([archivedTag]);
      const resent = await owner.updateTask(tagged.id, { expectedRevision: retitled.revision, tagIds: [tag.id] });
      expect(resent.tags).toEqual([archivedTag]);
      expect(await replica.getTask(tagged.id)).toEqual(resent);

      const freshClean = await owner.getTask(clean.id);
      const before = await snapshot();
      await expectAllRejected(
        [
          ['create with archived tag', () => owner.post('/tasks', taskInput(fixture, { tagIds: [tag.id] }))],
          [
            'attach archived tag to an untagged task',
            () => owner.patch(`/tasks/${clean.id}`, { expectedRevision: freshClean.revision, tagIds: [tag.id] }),
          ],
        ],
        422,
        'DOMAIN_VALIDATION_FAILED',
      );
      expect(await snapshot()).toEqual(before);
      expect(await owner.getTask(clean.id)).toEqual(freshClean);
      expect(await owner.getTask(tagged.id)).toEqual(resent);
    });
  });

  describe('access', () => {
    it('lets a viewer read projects and tasks but refuses writes with 403 and no write evidence', async () => {
      const fixture = await freshProject(owner, 'Viewer project');
      const task = await owner.createTask(taskInput(fixture, { title: uniqueName('Viewer visible task') }));

      expect(await viewer.getProject(fixture.project.id)).toEqual(await owner.getProject(fixture.project.id));
      expect(await viewer.getTask(task.id)).toEqual(task);
      expect(sortedIds(await viewer.listAllTasks({ projectId: fixture.project.id }))).toEqual([task.id]);

      const before = await snapshot();
      await expectAllRejected(
        [
          ['viewer creates a task', () => viewer.post('/tasks', taskInput(fixture))],
          [
            'viewer edits a task',
            () => viewer.patch(`/tasks/${task.id}`, { expectedRevision: task.revision, title: 'Viewer edit must not apply' }),
          ],
          ['viewer creates a project', () => viewer.post('/projects', { name: uniqueName('Viewer project') })],
        ],
        403,
        'CAPABILITY_REQUIRED',
      );
      expect(await snapshot()).toEqual(before);
      expect(await owner.getTask(task.id)).toEqual(task);
    });

    it('does not replay an earlier idempotent result after the owner membership is revoked', async () => {
      const fixture = await freshProject(owner, 'Revocation project');
      const key = randomUUID();
      const input = taskInput(fixture, { title: uniqueName('Revocation task') });
      const created = await owner.createTask(input, key);
      const before = await snapshot();

      await sql()`
        update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1
        where id = ${M.teamOwner}`;
      try {
        expectError(await owner.post('/tasks', input, key), 404, 'NOT_FOUND', [workspaceName(TEAM_ID), created.id, input.title]);
        expect(await snapshot()).toEqual(before);
      } finally {
        await sql()`
          update memberships set state = 'active', revoked_at = null, revision = revision + 1
          where id = ${M.teamOwner}`;
      }

      // With access re-checked and restored, the same key replays the original result again.
      expect(await owner.createTask(input, key)).toEqual(created);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('idempotency', () => {
    it('replays an exact retry, refuses a reused key with another payload and requires a valid key', async () => {
      const fixture = await freshProject(owner, 'Idempotency project');
      const key = randomUUID();
      const input = taskInput(fixture, { title: uniqueName('Idempotent task') });

      const beforeFirst = await snapshot();
      const first = await owner.createTask(input, key);
      const afterFirst = await snapshot();
      const firstDelta = rowDelta(beforeFirst, afterFirst);
      expect({ tasks: firstDelta.tasks, workPackages: firstDelta.work_packages }).toEqual({ tasks: 1, workPackages: 1 });
      expect(firstDelta.command_idempotency).toBeGreaterThanOrEqual(1);
      expect(firstDelta.audit_events).toBeGreaterThanOrEqual(1);
      expect(firstDelta.outbox_events).toBeGreaterThanOrEqual(1);
      expect(afterFirst.changeSeq[TEAM_ID]).not.toBe(beforeFirst.changeSeq[TEAM_ID]);

      const replay = await owner.createTask(input, key);
      expect(replay).toEqual(first);
      expect(await snapshot()).toEqual(afterFirst);

      expectError(
        await owner.post('/tasks', { ...input, title: uniqueName('Changed title') }, key),
        409,
        'IDEMPOTENCY_KEY_REUSED',
      );
      expect(await snapshot()).toEqual(afterFirst);
      expect(await owner.getTask(first.id)).toEqual(first);

      const invalidKeys: readonly (readonly [string, string | null])[] = [
        ['missing', null],
        ['empty', ''],
        ['longer than 128', 'k'.repeat(129)],
        ['with a space', 'not printable'],
      ];
      for (const [label, invalidKey] of invalidKeys) {
        const response = await owner.post('/tasks', taskInput(fixture, { title: uniqueName('Keyless task') }), invalidKey);
        expect(response.status, `${label}: ${response.text()}`).toBe(400);
        expectError(response, 400, 'VALIDATION_FAILED');
      }
      expect(await snapshot()).toEqual(afterFirst);

      // 128 printable characters is the inclusive upper bound.
      const longKey = randomUUID().replace(/-/g, '').padEnd(128, 'k');
      const longKeyTask = await owner.createTask(taskInput(fixture, { title: uniqueName('Long key task') }), longKey);
      expect(sortedIds(await owner.listAllTasks({ projectId: fixture.project.id }))).toEqual(sortedIds([first, longKeyTask]));
    });

    it('replays a task edit before the revision check and refuses the same key and body on another task', async () => {
      const fixture = await freshProject(owner, 'Route target project');
      const taskA = await owner.createTask(taskInput(fixture, { title: uniqueName('Route target A') }));
      const taskB = await owner.createTask(taskInput(fixture, { title: uniqueName('Route target B') }));
      expect([taskA.revision, taskB.revision]).toEqual([1, 1]);
      const key = randomUUID();
      const body = { expectedRevision: 1, title: uniqueName('Route bound title') };

      const first = expectEnvelope(await owner.patch(`/tasks/${taskA.id}`, body, key), 200, taskResponseSchema).data;
      expect(first).toMatchObject({ id: taskA.id, title: body.title });
      expect(first.revision).toBeGreaterThan(1);
      const afterFirst = await snapshot();

      // A is past revision 1 now, so only a replay of the stored result can answer 200.
      const replay = expectEnvelope(await owner.patch(`/tasks/${taskA.id}`, body, key), 200, taskResponseSchema).data;
      expect(replay).toEqual(first);
      expect(await snapshot()).toEqual(afterFirst);

      // Identical key and body, different route target: the request hash covers the task ID.
      expectError(await owner.patch(`/tasks/${taskB.id}`, body, key), 409, 'IDEMPOTENCY_KEY_REUSED');
      expect(await snapshot()).toEqual(afterFirst);
      expect(await owner.getTask(taskB.id)).toEqual(taskB);
      expect(await owner.getTask(taskA.id)).toEqual(first);
    });
  });

  describe('archive and restore', () => {
    it('archives and restores a task by revision, keeping its ID, work package and participant rows', async () => {
      const fixture = await freshProject(owner, 'Archive project');
      const projectId = fixture.project.id;
      const created = await owner.createTask(
        taskInput(fixture, { estimateMinutes: 60, participantMembershipIds: [M.teamOwner, M.teamMemberA] }),
      );
      // Moves the task revision on, so `created.revision` is stale from here.
      const task = await owner.updateTask(created.id, { expectedRevision: created.revision, title: uniqueName('Archive task') });
      const before = await snapshot();

      expectError(
        await owner.post(`/tasks/${task.id}/archive`, { expectedRevision: created.revision }),
        409,
        'REVISION_CONFLICT',
      );
      expect(await owner.getTask(task.id)).toEqual(task);

      const archived = await owner.archiveTask(task.id, task.revision);
      expect(archived).toMatchObject({
        id: task.id,
        workPackageId: task.workPackageId,
        workPackageRevision: task.workPackageRevision,
        estimateMinutes: 60,
      });
      expect(byMembership(archived.participants)).toEqual(byMembership(task.participants));
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.revision).toBeGreaterThan(task.revision);
      expect(await owner.getTask(task.id)).toEqual(archived);

      expect(sortedIds(await owner.listAllTasks({ projectId }))).not.toContain(task.id);
      expect((await owner.listAllTasks({ projectId, includeArchived: true })).find((row) => row.id === task.id)).toEqual(
        archived,
      );

      expectError(
        await owner.post(`/tasks/${task.id}/restore`, { expectedRevision: task.revision }),
        409,
        'REVISION_CONFLICT',
      );
      expect(await owner.getTask(task.id)).toEqual(archived);

      const restored = await owner.restoreTask(task.id, archived.revision);
      expect(restored).toMatchObject({
        id: task.id,
        workPackageId: task.workPackageId,
        workPackageRevision: task.workPackageRevision,
        estimateMinutes: 60,
        archivedAt: null,
      });
      expect(byMembership(restored.participants)).toEqual(byMembership(task.participants));
      expect(restored.revision).toBeGreaterThan(archived.revision);
      expect((await owner.listAllTasks({ projectId })).find((row) => row.id === task.id)).toEqual(restored);

      const delta = rowDelta(before, await snapshot());
      expect({ tasks: delta.tasks, workPackages: delta.work_packages, participants: delta.task_participants }).toEqual({
        tasks: 0,
        workPackages: 0,
        participants: 0,
      });
    });
  });

  describe('pagination and filters', () => {
    it('pages with opaque cursors to exhaustion and filters by participant, search, status and section', async () => {
      const fixture = await freshProject(owner, 'Paging project');
      const projectId = fixture.project.id;
      const first = await owner.createSection(projectId, { name: uniqueName('Paging section one') });
      const second = await owner.createSection(projectId, { name: uniqueName('Paging section two') });
      const token = `needle${randomUUID().slice(0, 8)}`;

      const specs = [
        { section: first, status: fixture.todo, needle: false, participants: [M.teamMemberA, M.teamMemberB] },
        { section: first, status: fixture.done, needle: false, participants: [M.teamMemberB] },
        { section: second, status: fixture.todo, needle: false, participants: [] },
        { section: second, status: fixture.todo, needle: true, participants: [] },
        { section: first, status: fixture.done, needle: false, participants: [] },
        { section: first, status: fixture.todo, needle: true, participants: [] },
        { section: second, status: fixture.todo, needle: false, participants: [] },
      ];
      const tasks: TaskDto[] = [];
      for (const [index, spec] of specs.entries()) {
        tasks.push(
          await owner.createTask({
            projectId,
            sectionId: spec.section.id,
            statusId: spec.status.id,
            title: uniqueName(`Paged task ${index + 1}${spec.needle ? ` ${token}` : ''}`),
            participantMembershipIds: spec.participants,
          }),
        );
      }
      const [withB] = tasks;
      if (!withB) throw new Error('Paging fixture tasks were not created.');
      const withoutB = await owner.updateTask(withB.id, {
        expectedRevision: withB.revision,
        expectedParticipantsRevision: withB.participantsRevision,
        participantMembershipIds: [M.teamMemberA],
      });
      expect(participant(withoutB, M.teamMemberB).active).toBe(false);

      const pages = await owner.pageThroughTasks({ projectId, limit: 2 }, 8);
      expect(pages.length).toBeGreaterThanOrEqual(4);
      for (const page of pages) expect(page.length).toBeLessThanOrEqual(2);
      const pagedIds = pages.flat().map((row) => row.id);
      expect(new Set(pagedIds).size).toBe(pagedIds.length);
      expect([...pagedIds].sort()).toEqual(sortedIds(tasks));

      const expected = (indexes: readonly number[]): string[] =>
        indexes.map((index) => tasks[index]?.id ?? `missing task ${index}`).sort();
      const filtered = async (filters: { participantMembershipId?: string; search?: string; statusId?: string; sectionId?: string }) =>
        sortedIds(await owner.listAllTasks({ projectId, ...filters }));

      // The soft-removed participant no longer matches; the remaining one still does.
      expect(await filtered({ participantMembershipId: M.teamMemberB })).toEqual(expected([1]));
      expect(await filtered({ participantMembershipId: M.teamMemberA })).toEqual(expected([0]));
      expect(await filtered({ search: token })).toEqual(expected([3, 5]));
      expect(await filtered({ statusId: fixture.done.id })).toEqual(expected([1, 4]));
      expect(await filtered({ sectionId: second.id })).toEqual(expected([2, 3, 6]));
      expect(await filtered({ sectionId: second.id, search: token })).toEqual(expected([3]));
    });
  });
});
