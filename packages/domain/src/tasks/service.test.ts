import type {
  CreateTaskInput,
  ProjectDto,
  SectionDto,
  TagDto,
  TaskDto,
  TaskParticipantDto,
  TaskStatusDto,
} from '@workloom/contracts';
import { describe, expect, it } from 'vitest';

import { authorizeLoadedAccess } from '../access/access-queries.js';
import type { CommandContext } from '../access/context.js';
import type { AccessRepository, MembershipRecord } from '../access/ports.js';
import { DomainError } from '../errors.js';
import type { ChangeEventInput } from '../transactions/ports.js';
import type {
  IdempotencyRecord,
  TaskCursorPayload,
  TaskRepository,
  TaskTools,
  TaskUnitOfWork,
  WorkPackageRecord,
} from './ports.js';
import { createTaskApplication } from './service.js';

// Port doubles for domain decisions only. Persistence, SQL scoping and real transactions are
// covered by the PostgreSQL integration suite.

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WS = uuid(1);
const users = { owner: uuid(11), viewer: uuid(12), revoked: uuid(13) };
const members = { owner: uuid(21), viewer: uuid(22), revoked: uuid(23) };

const memberships: MembershipRecord[] = [
  { id: members.owner, workspaceId: WS, userId: users.owner, displayName: 'Owner', role: 'owner', state: 'active', revision: 1 },
  { id: members.viewer, workspaceId: WS, userId: users.viewer, displayName: 'Viewer', role: 'viewer', state: 'active', revision: 1 },
  { id: members.revoked, workspaceId: WS, userId: users.revoked, displayName: 'Gone', role: 'member', state: 'revoked', revision: 2 },
];

interface State {
  projects: Map<string, ProjectDto>;
  sections: Map<string, SectionDto>;
  statuses: Map<string, TaskStatusDto>;
  tags: Map<string, TagDto>;
  packages: Map<string, WorkPackageRecord>;
  tasks: Map<string, TaskDto>;
  participants: Map<string, TaskParticipantDto[]>;
  taskTags: Map<string, string[]>;
  idempotency: Map<string, IdempotencyRecord>;
}

function cloneState(state: State): State {
  return {
    projects: new Map(state.projects),
    sections: new Map(state.sections),
    statuses: new Map(state.statuses),
    tags: new Map(state.tags),
    packages: new Map(state.packages),
    tasks: new Map(state.tasks),
    participants: new Map(state.participants),
    taskTags: new Map(state.taskTags),
    idempotency: new Map(state.idempotency),
  };
}

function harness() {
  const db = {
    state: cloneState({
      projects: new Map(),
      sections: new Map(),
      statuses: new Map(),
      tags: new Map(),
      packages: new Map(),
      tasks: new Map(),
      participants: new Map(),
      taskTags: new Map(),
      idempotency: new Map(),
    }),
    epoch: 'epoch-1',
  };
  const events: ChangeEventInput[] = [];

  const access: AccessRepository = {
    findUser: async () => null,
    findUsers: async () => [],
    listAccessibleWorkspaces: async () => [],
    async findWorkspaceAccess(workspaceId, userId) {
      const membership = memberships.find((item) => item.workspaceId === workspaceId && item.userId === userId);
      return membership === undefined
        ? null
        : { workspace: { id: WS, name: 'Synthetic', timezone: 'UTC', weekStart: 1 }, membership };
    },
    listActiveMemberships: async (workspaceId) =>
      memberships.filter((item) => item.workspaceId === workspaceId && item.state === 'active'),
  };

  /** Joined projection, as the real adapter returns it. */
  const project = (task: TaskDto): TaskDto => {
    const workPackage = db.state.packages.get(task.workPackageId);
    return {
      ...task,
      workPackageRevision: workPackage?.revision ?? 0,
      estimateMinutes: workPackage?.estimateMinutes ?? null,
      participants: db.state.participants.get(task.id) ?? [],
      tags: (db.state.taskTags.get(task.id) ?? []).flatMap((id) => db.state.tags.get(id) ?? []),
    };
  };
  const scoped = <T extends { workspaceId: string }>(row: T | undefined, ws: string): T | null =>
    row !== undefined && row.workspaceId === ws ? row : null;
  const idempotencyKey = (ws: string, actor: string, command: string, key: string) => [ws, actor, command, key].join('|');

  const repository: TaskRepository = {
    access,
    permissionEpoch: async () => db.epoch,
    findProject: async (ws, id) => scoped(db.state.projects.get(id), ws),
    listProjects: async (ws) => [...db.state.projects.values()].filter((row) => row.workspaceId === ws),
    insertProject: async (row) => void db.state.projects.set(row.id, row),
    saveProject: async (row) => void db.state.projects.set(row.id, row),
    findSection: async (ws, id) => scoped(db.state.sections.get(id), ws),
    listSections: async (ws, projectId) =>
      [...db.state.sections.values()].filter((row) => row.workspaceId === ws && row.projectId === projectId),
    insertSection: async (row) => void db.state.sections.set(row.id, row),
    saveSection: async (row) => void db.state.sections.set(row.id, row),
    findStatus: async (ws, id) => scoped(db.state.statuses.get(id), ws),
    listStatuses: async (ws, projectId) =>
      [...db.state.statuses.values()]
        .filter((row) => row.workspaceId === ws && row.projectId === projectId)
        .sort((left, right) => left.position - right.position),
    insertStatus: async (row) => void db.state.statuses.set(row.id, row),
    findTag: async (ws, id) => scoped(db.state.tags.get(id), ws),
    listTags: async (ws) => [...db.state.tags.values()].filter((row) => row.workspaceId === ws && row.archivedAt === null),
    insertTag: async (row) => void db.state.tags.set(row.id, row),
    saveTag: async (row) => void db.state.tags.set(row.id, row),
    findWorkPackage: async (ws, id) => scoped(db.state.packages.get(id), ws),
    insertWorkPackage: async (row) => void db.state.packages.set(row.id, row),
    saveWorkPackage: async (row) => void db.state.packages.set(row.id, row),
    async findTasksByIds(ws,ids) {return [...db.state.tasks.values()].filter(t=>t.workspaceId===ws&&ids.includes(t.id)).map(project);},
    async findTask(ws, id) {
      const row = scoped(db.state.tasks.get(id), ws);
      return row === null ? null : project(row);
    },
    async listTasks(ws, input, after, take) {
      return [...db.state.tasks.values()]
        .filter(
          (row) =>
            row.workspaceId === ws &&
            row.projectId === input.projectId &&
            (input.includeArchived === true || row.archivedAt === null) &&
            (input.sectionId === undefined || row.sectionId === input.sectionId) &&
            (input.statusId === undefined || row.statusId === input.statusId),
        )
        .map(project)
        .sort((left, right) => left.position - right.position || (left.id < right.id ? -1 : 1))
        .filter(
          (row) =>
            after === null || row.position > after.position || (row.position === after.position && row.id > after.id),
        )
        .slice(0, take);
    },
    insertTaskCore: async (row) => void db.state.tasks.set(row.id, row),
    saveTaskCore: async (row) => void db.state.tasks.set(row.id, row),
    async saveParticipants(_ws, taskId, rows) {
      const byMember = new Map((db.state.participants.get(taskId) ?? []).map((row) => [row.membershipId, row]));
      for (const row of rows) byMember.set(row.membershipId, row);
      db.state.participants.set(taskId, [...byMember.values()]);
    },
    setTaskTagIds: async (_ws, taskId, tagIds) => void db.state.taskTags.set(taskId, [...tagIds]),
    findIdempotency: async (ws, actor, command, key) =>
      db.state.idempotency.get(idempotencyKey(ws, actor, command, key)) ?? null,
    insertIdempotency: async (row) =>
      void db.state.idempotency.set(idempotencyKey(row.workspaceId, row.actorUserId, row.command, row.idempotencyKey), row),
  };

  let second = 0;
  const writer: TaskUnitOfWork = {
    async run(context, capability, work) {
      const loaded = authorizeLoadedAccess(
        await access.findWorkspaceAccess(context.workspaceId, context.actor.userId),
        capability,
      );
      const snapshot = cloneState(db.state);
      const eventCount = events.length;
      try {
        return await work({
          context,
          access: loaded,
          barrierAt: new Date(Date.UTC(2026, 9, 16, 9, 0, (second += 1))),
          repository,
          planningGuard: { async check() { return null; } },
          async recordChange(event) {
            events.push(event);
            return { changeSeq: BigInt(events.length), eventOrdinal: 1 };
          },
        });
      } catch (error) {
        db.state = snapshot;
        events.length = eventCount;
        throw error;
      }
    },
  };

  let nextId = 1000;
  const tools: TaskTools = {
    newId: () => uuid((nextId += 1)),
    digest: (value) => `digest:${value}`,
    encodeCursor: (payload) => JSON.stringify(payload),
    decodeCursor(token) {
      try {
        return JSON.parse(token) as TaskCursorPayload;
      } catch {
        throw new DomainError('VALIDATION_FAILED', 'The cursor is no longer valid. Reload the list.');
      }
    },
  };

  let keys = 0;
  let requests = 0;
  const ctx = (userId: string, idempotencyKey?: string, workspaceId = WS): CommandContext => {
    requests += 1;
    const base = {
      actor: { userId, displayName: 'Synthetic', kind: 'fixture' as const },
      source: 'web' as const,
      requestId: `req-${requests}`,
      workspaceId,
    };
    return idempotencyKey === undefined ? base : { ...base, idempotencyKey };
  };

  return {
    app: createTaskApplication({ reader: repository, writer, tools }),
    db,
    events,
    ctx,
    key: () => `key-${(keys += 1)}`,
    /** Owner context with a fresh idempotency key. */
    owner: () => ctx(users.owner, `key-${(keys += 1)}`),
  };
}

async function setup() {
  const h = harness();
  const project = await h.app.createProject(h.owner(), { name: 'Synthetic project' });
  const [todo] = await h.app.listStatuses(h.ctx(users.owner), project.id);
  if (todo === undefined) throw new Error('Default statuses missing.');
  const createTask = (input: Partial<CreateTaskInput> = {}) =>
    h.app.createTask(h.owner(), { projectId: project.id, statusId: todo.id, title: 'Synthetic task', ...input });
  return { ...h, project, statusId: todo.id, createTask };
}

/** Revokes a membership of the shared fixture; call the returned function to restore it. */
function revokeMembership(membershipId: string): () => void {
  const index = memberships.findIndex((membership) => membership.id === membershipId);
  const original = memberships[index];
  if (original === undefined) throw new Error('Unknown fixture membership.');
  memberships[index] = { ...original, state: 'revoked' };
  return () => {
    memberships[index] = original;
  };
}

async function errorOf(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('Expected a DomainError');
}

describe('projects', () => {
  it('creates the four default statuses with the project', async () => {
    const { app, ctx, project } = await setup();
    const statuses = await app.listStatuses(ctx(users.viewer), project.id);

    expect(statuses.map((status) => [status.name, status.group, status.position, status.revision])).toEqual([
      ['К выполнению', 'todo', 0, 1],
      ['В работе', 'in_progress', 1, 1],
      ['Готово', 'done', 2, 1],
      ['Отменено', 'cancelled', 3, 1],
    ]);
  });

  it('rejects new tasks in an archived project', async () => {
    const s = await setup();
    await s.app.updateProject(s.owner(), s.project.id, { expectedRevision: 1, archived: true });

    expect((await errorOf(s.createTask())).code).toBe('DOMAIN_VALIDATION_FAILED');
  });
});

describe('idempotency', () => {
  it('replays the stored result for the same key and payload without new state or audit', async () => {
    const s = await setup();
    const key = s.key();
    const input = { projectId: s.project.id, statusId: s.statusId, title: 'Draft plan', estimateMinutes: 30 };
    const first = await s.app.createTask(s.ctx(users.owner, key), input);
    const events = s.events.length;

    // Uppercase IDs in context and body canonicalize to the same scope and payload.
    const replay = await s.app.createTask(s.ctx(users.owner.toUpperCase(), key, WS.toUpperCase()), {
      ...input,
      projectId: s.project.id.toUpperCase(),
    });

    expect(replay).toEqual(first);
    expect(s.events.length).toBe(events);
    expect(s.db.state.tasks.size).toBe(1);
  });

  it('rejects a reused key with another payload or another target', async () => {
    const s = await setup();
    const key = s.key();
    const input = { projectId: s.project.id, statusId: s.statusId, title: 'Draft plan' };
    const first = await s.app.createTask(s.ctx(users.owner, key), input);
    const second = await s.createTask({ title: 'Second' });

    const otherPayload = await errorOf(s.app.createTask(s.ctx(users.owner, key), { ...input, title: 'Changed' }));
    expect(otherPayload.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const updateKey = s.key();
    await s.app.updateTask(s.ctx(users.owner, updateKey), first.id, { expectedRevision: 1, priority: 'high' });
    const otherTarget = await errorOf(
      s.app.updateTask(s.ctx(users.owner, updateKey), second.id, { expectedRevision: 1, priority: 'high' }),
    );
    expect(otherTarget.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await s.app.getTask(s.ctx(users.owner), second.id)).priority).toBe('none');
  });

  it('requires a visible-ASCII key and re-validates direct calls', async () => {
    const s = await setup();
    const input = { projectId: s.project.id, statusId: s.statusId, title: 'Draft plan' };

    expect((await errorOf(s.app.createTask(s.ctx(users.owner), input))).code).toBe('VALIDATION_FAILED');
    expect((await errorOf(s.app.createTask(s.ctx(users.owner, 'has space'), input))).code).toBe('VALIDATION_FAILED');
    const spoofed = { ...input, actor: users.viewer } as unknown as CreateTaskInput;
    expect((await errorOf(s.app.createTask(s.owner(), spoofed))).code).toBe('VALIDATION_FAILED');
  });
});

describe('access', () => {
  it('lets viewers read but not write, and hides the workspace from revoked members', async () => {
    const s = await setup();
    const input = { projectId: s.project.id, statusId: s.statusId, title: 'Draft plan' };

    expect((await s.app.listProjects(s.ctx(users.viewer))).map((project) => project.id)).toEqual([s.project.id]);
    expect((await errorOf(s.app.createTask(s.ctx(users.viewer, s.key()), input))).code).toBe('CAPABILITY_REQUIRED');
    expect((await errorOf(s.app.createTask(s.ctx(users.revoked, s.key()), input))).code).toBe('NOT_FOUND');
    expect((await errorOf(s.app.listProjects(s.ctx(users.revoked)))).code).toBe('NOT_FOUND');
  });

  it('answers unknown references with NOT_FOUND', async () => {
    const s = await setup();

    expect((await errorOf(s.createTask({ statusId: uuid(999) }))).code).toBe('NOT_FOUND');
    expect((await errorOf(s.app.getTask(s.ctx(users.owner), 'not-a-uuid'))).code).toBe('NOT_FOUND');
  });
});

describe('work packages', () => {
  it('keeps a 0 estimate distinct from no estimate', async () => {
    const s = await setup();

    expect((await s.createTask({ estimateMinutes: 0 })).estimateMinutes).toBe(0);
    expect((await s.createTask()).estimateMinutes).toBeNull();
  });

  it('lets a detail subtask share the parent package without copying its budget', async () => {
    const s = await setup();
    const parent = await s.createTask({ estimateMinutes: 120 });
    const child = await s.createTask({ parentTaskId: parent.id });

    expect(child.workPackageId).toBe(parent.workPackageId);
    expect(child.estimateMinutes).toBe(120);
    expect(s.db.state.packages.size).toBe(1);
    expect((await errorOf(s.createTask({ parentTaskId: parent.id, estimateMinutes: 0 }))).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('gives added scope its own package linked to the parent package', async () => {
    const s = await setup();
    const parent = await s.createTask({ estimateMinutes: 120 });
    const extra = await s.createTask({ parentTaskId: parent.id, workScope: 'added_scope', estimateMinutes: 0 });

    expect(extra.workPackageId).not.toBe(parent.workPackageId);
    expect(extra.estimateMinutes).toBe(0);
    expect(s.db.state.packages.get(extra.workPackageId)).toMatchObject({
      origin: 'added_scope',
      sourcePackageId: parent.workPackageId,
    });
  });

  it('changes the shared estimate once, guarded by the package revision, without task revisions', async () => {
    const s = await setup();
    const parent = await s.createTask({ estimateMinutes: 120 });
    const child = await s.createTask({ parentTaskId: parent.id });

    const stale = await errorOf(
      s.app.updateTask(s.owner(), child.id, { expectedRevision: 1, estimateMinutes: 90, expectedWorkPackageRevision: 2 }),
    );
    expect(stale.code).toBe('REVISION_CONFLICT');

    const updated = await s.app.updateTask(s.owner(), child.id, {
      expectedRevision: 1,
      estimateMinutes: null,
      expectedWorkPackageRevision: 1,
    });
    const reloadedParent = await s.app.getTask(s.ctx(users.owner), parent.id);

    expect(updated).toMatchObject({ estimateMinutes: null, workPackageRevision: 2, revision: 1 });
    expect(reloadedParent).toMatchObject({ estimateMinutes: null, workPackageRevision: 2, revision: 1 });
    expect(s.db.state.packages.size).toBe(1);
  });
});

describe('participants', () => {
  it('soft-removes and reactivates the same rows with their own revisions', async () => {
    const s = await setup();
    const task = await s.createTask({ participantMembershipIds: [members.owner] });
    const setParticipants = (ids: string[], expectedParticipantsRevision: number) =>
      s.app.updateTask(s.owner(), task.id, {
        expectedRevision: 1,
        participantMembershipIds: ids,
        expectedParticipantsRevision,
      });

    await setParticipants([members.owner, members.viewer], 1);
    const removed = await setParticipants([members.owner], 2);
    expect(removed.participants).toContainEqual({ membershipId: members.viewer, role: 'assignee', active: false, revision: 2 });

    const restored = await setParticipants([members.owner, members.viewer], 3);
    expect(restored.participants).toHaveLength(2);
    expect(restored.participants).toContainEqual({ membershipId: members.viewer, role: 'assignee', active: true, revision: 3 });
    expect(restored.participants).toContainEqual({ membershipId: members.owner, role: 'assignee', active: true, revision: 1 });
    expect(restored).toMatchObject({ participantsRevision: 4, revision: 1 });
  });

  it('answers new assignments of revoked or unknown members with NOT_FOUND', async () => {
    const s = await setup();

    expect((await errorOf(s.createTask({ participantMembershipIds: [members.revoked] }))).code).toBe('NOT_FOUND');
    expect((await errorOf(s.createTask({ responsibleMembershipId: uuid(998) }))).code).toBe('NOT_FOUND');
  });

  it('keeps existing assignments after a revocation but rejects new ones and reactivation', async () => {
    const s = await setup();
    const task = await s.createTask({
      participantMembershipIds: [members.owner, members.viewer],
      responsibleMembershipId: members.viewer,
    });
    const other = await s.createTask();
    const restore = revokeMembership(members.viewer);
    try {
      const kept = await s.app.updateTask(s.owner(), task.id, {
        expectedRevision: 1,
        title: 'Renamed',
        responsibleMembershipId: members.viewer,
        participantMembershipIds: [members.owner, members.viewer],
        expectedParticipantsRevision: 1,
      });
      expect(kept).toMatchObject({ responsibleMembershipId: members.viewer, revision: 2, participantsRevision: 2 });

      const removed = await s.app.updateTask(s.owner(), task.id, {
        expectedRevision: 2,
        participantMembershipIds: [members.owner],
        expectedParticipantsRevision: 2,
      });
      expect(removed.participants).toContainEqual({ membershipId: members.viewer, role: 'assignee', active: false, revision: 2 });

      const reactivate = await errorOf(
        s.app.updateTask(s.owner(), task.id, {
          expectedRevision: 2,
          participantMembershipIds: [members.owner, members.viewer],
          expectedParticipantsRevision: 3,
        }),
      );
      expect(reactivate.code).toBe('NOT_FOUND');
      const newResponsible = await errorOf(
        s.app.updateTask(s.owner(), other.id, { expectedRevision: 1, responsibleMembershipId: members.viewer }),
      );
      expect(newResponsible.code).toBe('NOT_FOUND');

      const cleared = await s.app.updateTask(s.owner(), task.id, { expectedRevision: 2, responsibleMembershipId: null });
      expect(cleared.responsibleMembershipId).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('tags on tasks', () => {
  it('keeps an archived tag where it is attached but never attaches it anew', async () => {
    const s = await setup();
    const legacy = await s.app.createTag(s.owner(), { name: 'Legacy' });
    const fresh = await s.app.createTag(s.owner(), { name: 'Fresh' });
    const tagged = await s.createTask({ tagIds: [legacy.id] });
    const other = await s.createTask();
    await s.app.updateTag(s.owner(), legacy.id, { expectedRevision: 1, archived: true });

    const kept = await s.app.updateTask(s.owner(), tagged.id, { expectedRevision: 1, tagIds: [legacy.id, fresh.id] });
    expect(kept.tags.map((tag) => tag.id)).toEqual([legacy.id, fresh.id]);

    const attachElsewhere = s.app.updateTask(s.owner(), other.id, { expectedRevision: 1, tagIds: [legacy.id] });
    expect((await errorOf(attachElsewhere)).code).toBe('DOMAIN_VALIDATION_FAILED');
    expect((await errorOf(s.createTask({ tagIds: [legacy.id] }))).code).toBe('DOMAIN_VALIDATION_FAILED');
  });
});

describe('reparenting', () => {
  it('rejects cycles and parents from another project', async () => {
    const s = await setup();
    const root = await s.createTask();
    const child = await s.createTask({ parentTaskId: root.id });
    const grandchild = await s.createTask({ parentTaskId: child.id });
    const otherProject = await s.app.createProject(s.owner(), { name: 'Other project' });
    const [otherStatus] = await s.app.listStatuses(s.ctx(users.owner), otherProject.id);
    const foreign = await s.createTask({ projectId: otherProject.id, statusId: otherStatus?.id ?? '' });

    for (const parentTaskId of [grandchild.id, root.id, foreign.id]) {
      const target = parentTaskId === foreign.id ? child : root;
      const error = await errorOf(s.app.updateTask(s.owner(), target.id, { expectedRevision: 1, parentTaskId }));
      expect(error.code).toBe('DOMAIN_VALIDATION_FAILED');
    }
  });

  it('keeps the subtask work package when it moves under another parent', async () => {
    const s = await setup();
    const first = await s.createTask({ estimateMinutes: 60 });
    const second = await s.createTask({ estimateMinutes: 30 });
    const child = await s.createTask({ parentTaskId: first.id });

    const moved = await s.app.updateTask(s.owner(), child.id, { expectedRevision: 1, parentTaskId: second.id });

    expect(moved).toMatchObject({ parentTaskId: second.id, workPackageId: first.workPackageId, revision: 2 });
    expect(moved.estimateMinutes).toBe(60);
  });
});

describe('task list cursors', () => {
  it('pages through every task without gaps', async () => {
    const s = await setup();
    for (const title of ['One', 'Two', 'Three']) await s.createTask({ title });

    const first = await s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await s.app.listTasks(s.ctx(users.owner), {
      projectId: s.project.id,
      limit: 2,
      cursor: first.nextCursor ?? '',
    });
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((task) => task.title)).toEqual(['One', 'Two', 'Three']);
  });

  it('rejects a cursor used for another query, another actor or after an access change', async () => {
    const s = await setup();
    for (const title of ['One', 'Two']) await s.createTask({ title });
    const { nextCursor } = await s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, limit: 1 });
    const cursor = nextCursor ?? '';

    const otherQuery = s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, limit: 2, cursor });
    const otherActor = s.app.listTasks(s.ctx(users.viewer), { projectId: s.project.id, limit: 1, cursor });
    expect((await errorOf(otherQuery)).code).toBe('VALIDATION_FAILED');
    expect((await errorOf(otherActor)).code).toBe('VALIDATION_FAILED');

    s.db.epoch = 'epoch-2';
    const afterChange = s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, limit: 1, cursor });
    expect((await errorOf(afterChange)).code).toBe('VALIDATION_FAILED');
  });
});
