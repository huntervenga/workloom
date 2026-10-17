import type {
  CreateTaskInput,
  MoveTaskInput,
  ProjectDto,
  SectionDto,
  TagDto,
  TaskDto,
  TaskListQuery,
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
    /** Filters the service forwarded to `listTasks`, in call order. */
    listInputs: [] as TaskListQuery[],
    /** Test knob: arguments of every planning guard check, in call order. */
    planningChecks: [] as unknown[][],
    /** Test knob: task row writes made outside a unit-of-work run; must stay 0. */
    writesOutsideRun: 0,
    inRun: false,
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
  /** Mirrors the adapter's correlated status-group EXISTS for `completion: 'open'`. */
  const hasOpenStatus = (task: TaskDto): boolean => {
    const status = db.state.statuses.get(task.statusId);
    return status !== undefined && status.workspaceId === task.workspaceId && status.projectId === task.projectId &&
      (status.group === 'todo' || status.group === 'in_progress');
  };

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
      db.listInputs.push(input);
      return [...db.state.tasks.values()]
        .filter(
          (row) =>
            row.workspaceId === ws &&
            row.projectId === input.projectId &&
            (input.includeArchived === true || row.archivedAt === null) &&
            (input.sectionId === undefined || row.sectionId === input.sectionId) &&
            (input.statusId === undefined || row.statusId === input.statusId) &&
            (input.tagId === undefined || (db.state.taskTags.get(row.id) ?? []).includes(input.tagId)) &&
            (input.completion === undefined || hasOpenStatus(row)) &&
            // Literal case-insensitive substring on title/description, like the production ILIKE predicate.
            (input.search === undefined || input.search === '' ||
              [row.title, row.description].some((text) => text.toLowerCase().includes((input.search as string).toLowerCase()))),
        )
        .map(project)
        .sort((left, right) => (input.sort === 'due_asc'
          ? left.dueDate === right.dueDate ? 0 : left.dueDate === null ? 1 : right.dueDate === null ? -1 : left.dueDate < right.dueDate ? -1 : 1
          : left.position - right.position) || (left.id < right.id ? -1 : 1))
        .filter((row) => after === null || ('dueDate' in after
          ? after.dueDate === null ? row.dueDate === null && row.id > after.id
            : row.dueDate === null || row.dueDate > after.dueDate || (row.dueDate === after.dueDate && row.id > after.id)
          : row.position > after.position || (row.position === after.position && row.id > after.id)))
        .slice(0, take);
    },
    insertTaskCore: async (row) => {
      db.writesOutsideRun += db.inRun ? 0 : 1;
      db.state.tasks.set(row.id, row);
    },
    saveTaskCore: async (row) => {
      db.writesOutsideRun += db.inRun ? 0 : 1;
      db.state.tasks.set(row.id, row);
    },
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
      db.inRun = true;
      try {
        return await work({
          context,
          access: loaded,
          barrierAt: new Date(Date.UTC(2026, 9, 16, 9, 0, (second += 1))),
          repository,
          planningGuard: {
            async check(...args: unknown[]) {
              db.planningChecks.push(args);
              return null;
            },
          },
          statusTransitions:{async assertTransition(){}},
          async recordChange(event) {
            events.push(event);
            return { changeSeq: BigInt(events.length), eventOrdinal: 1 };
          },
        });
      } catch (error) {
        db.state = snapshot;
        events.length = eventCount;
        throw error;
      } finally {
        db.inRun = false;
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
    /** Every stored task row as the adapter projects it, archived rows included. */
    projected: (): Map<string, TaskDto> => new Map([...db.state.tasks.values()].map((row) => [row.id, project(row)])),
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
      ['To do', 'todo', 0, 1],
      ['In progress', 'in_progress', 1, 1],
      ['Done', 'done', 2, 1],
      ['Cancelled', 'cancelled', 3, 1],
    ]);
  });

  it('replays an existing project receipt exactly and preserves its stored status names', async () => {
    const h = harness();
    const key = h.key();
    const input = { name: 'Existing project' };
    const original = await h.app.createProject(h.ctx(users.owner, key), input);
    // This fixture represents rows created with the previous template or renamed by their owner.
    const names = ['К выполнению', 'Research', 'Готово', 'Отменено'];
    const statuses = await h.app.listStatuses(h.ctx(users.owner), original.id);
    for (const [index, status] of statuses.entries()) {
      h.db.state.statuses.set(status.id, { ...status, name: names[index] as string });
    }
    const storedBefore = JSON.stringify([...h.db.state.idempotency]);
    const statusesBefore = JSON.stringify([...h.db.state.statuses]);
    const eventCount = h.events.length;

    const replay = await h.app.createProject(h.ctx(users.owner, key), input);

    expect(JSON.stringify(replay)).toBe(JSON.stringify(original));
    expect(JSON.stringify([...h.db.state.idempotency])).toBe(storedBefore);
    expect(JSON.stringify([...h.db.state.statuses])).toBe(statusesBefore);
    expect(h.events).toHaveLength(eventCount);
    expect(h.db.state.projects.size).toBe(1);
    const next = await h.app.createProject(h.owner(), { name: 'New project' });
    expect((await h.app.listStatuses(h.ctx(users.owner), next.id)).map(status => status.name)).toEqual(['To do', 'In progress', 'Done', 'Cancelled']);
    expect((await h.app.listStatuses(h.ctx(users.owner), original.id)).map(status => status.name)).toEqual(names);
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


describe('exact task tag filter', () => {
  it('paginates only tasks with their own tag and binds the cursor to that tag', async () => {
    const s = await setup();
    const tag = await s.app.createTag(s.owner(), { name: 'Design' });
    const other = await s.app.createTag(s.owner(), { name: 'Other' });
    const parent = await s.createTask({ title: 'Tagged parent', tagIds: [tag.id, other.id] });
    await s.createTask({ title: 'Untagged child', parentTaskId: parent.id });
    const child = await s.createTask({ title: 'Tagged child', parentTaskId: parent.id, tagIds: [tag.id] });
    await s.createTask({ title: 'Other tag', tagIds: [other.id] });
    const query = { projectId: s.project.id, tagId: tag.id, limit: 1 };
    const first = await s.app.listTasks(s.ctx(users.owner), query);
    expect(first.items.map(row => row.id)).toEqual([parent.id]);
    const cursor = first.nextCursor as string;
    const second = await s.app.listTasks(s.ctx(users.owner), { ...query, cursor });
    expect(second.items.map(row => row.id)).toEqual([child.id]);
    expect(second.items[0]?.workPackageId).toBe(parent.workPackageId);
    expect(second.nextCursor).toBeNull();
    for (const tagId of [other.id, undefined]) {
      const changed = tagId === undefined ? { projectId: s.project.id, limit: 1, cursor } : { ...query, tagId, cursor };
      expect((await errorOf(s.app.listTasks(s.ctx(users.owner), changed))).code).toBe('VALIDATION_FAILED');
    }
  });

  it('accepts an archived owned tag and validates missing/foreign tags before cursors', async () => {
    const s = await setup();
    const tag = await s.app.createTag(s.owner(), { name: 'Archived' });
    const task = await s.createTask({ tagIds: [tag.id] });
    await s.app.updateTag(s.owner(), tag.id, { expectedRevision: 1, archived: true });
    expect((await s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, tagId: tag.id, limit: 50 })).items.map(row => row.id)).toEqual([task.id]);
    const foreign = { ...tag, id: uuid(901), workspaceId: uuid(902) };
    s.db.state.tags.set(foreign.id, foreign);
    for (const tagId of [uuid(903), foreign.id]) {
      expect((await errorOf(s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, tagId, cursor: 'bad', limit: 50 }))).code).toBe('NOT_FOUND');
    }
    expect((await errorOf(s.app.listTasks(s.ctx(users.revoked), { projectId: s.project.id, tagId: tag.id, cursor: 'bad', limit: 50 }))).code).toBe('NOT_FOUND');
    expect((await errorOf(s.app.listTasks(s.ctx(users.owner), { projectId: uuid(904), tagId: tag.id, cursor: 'bad', limit: 50 }))).code).toBe('NOT_FOUND');
  });

  it('keeps the original untagged v1 canonical query hash and cursor readable', async () => {
    const s = await setup();
    const firstTask = await s.createTask({ title: 'One' });
    const secondTask = await s.createTask({ title: 'Two' });
    const first = await s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, limit: 1 });
    // Literal old query encoding: a tagId null/default would change this binding.
    const legacyPayload = {
      version: 1, workspaceId: WS, actorUserId: users.owner, permissionEpoch: 'epoch-1',
      queryHash: `digest:{"limit":1,"projectId":"${s.project.id}"}`,
      position: firstTask.position, id: firstTask.id,
    };
    expect(JSON.parse(first.nextCursor as string)).toEqual(legacyPayload);
    expect((await s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, limit: 1, cursor: JSON.stringify(legacyPayload) })).items.map(row => row.id)).toEqual([secondTask.id]);
  });
});


describe('open task completion filter', () => {
  /** Default statuses plus custom ones in todo, in_progress and done groups, one task in each. */
  async function completionFixture() {
    const s = await setup();
    const statuses = await s.app.listStatuses(s.ctx(users.owner), s.project.id);
    const inGroup = (group: TaskStatusDto['group']) => statuses.find((status) => status.group === group) as TaskStatusDto;
    const review: TaskStatusDto = { ...inGroup('in_progress'), id: uuid(951), name: 'Review', position: 4 };
    const triage: TaskStatusDto = { ...inGroup('todo'), id: uuid(952), name: 'Triage', position: 5 };
    const shipped: TaskStatusDto = { ...inGroup('done'), id: uuid(953), name: 'Shipped', position: 6 };
    for (const status of [review, triage, shipped]) s.db.state.statuses.set(status.id, status);
    const task = (title: string, status: TaskStatusDto, dueDate: string | null = null) =>
      s.createTask({ title, statusId: status.id, dueDate });
    const tasks = {
      todo: await task('Todo', inGroup('todo'), '2026-10-20'),
      done: await task('Done', inGroup('done'), '2026-10-18'),
      progress: await task('In progress', inGroup('in_progress')),
      cancelled: await task('Cancelled', inGroup('cancelled'), '2026-10-17'),
      review: await task('Review', review, '2026-10-19'),
      shipped: await task('Shipped', shipped),
      triage: await task('Triage', triage),
      archivedOpen: await task('Archived triage', triage),
    };
    await s.app.archiveTask(s.owner(), tasks.archivedOpen.id, { expectedRevision: 1 });
    return { ...s, tasks, review, shipped, inGroup };
  }

  it('pages only todo/in_progress groups, custom statuses included, before the page limit', async () => {
    const s = await completionFixture();
    const query = { projectId: s.project.id, completion: 'open' as const, limit: 2 };
    const first = await s.app.listTasks(s.ctx(users.owner), query);
    expect(s.db.listInputs.at(-1)).toEqual({ projectId: s.project.id, completion: 'open', limit: 2 });
    expect(first.items.map(row => row.id)).toEqual([s.tasks.todo.id, s.tasks.progress.id]);
    const second = await s.app.listTasks(s.ctx(users.owner), { ...query, cursor: first.nextCursor as string });
    expect(second.items.map(row => row.id)).toEqual([s.tasks.review.id, s.tasks.triage.id]);
    expect(second.nextCursor).toBeNull();

    const all = await s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, limit: 50 });
    expect(Object.hasOwn(s.db.listInputs.at(-1) as object, 'completion')).toBe(false);
    expect(all.items.map(row => row.id)).toEqual([
      s.tasks.todo.id, s.tasks.done.id, s.tasks.progress.id, s.tasks.cancelled.id,
      s.tasks.review.id, s.tasks.shipped.id, s.tasks.triage.id,
    ]);
    const withArchived = await s.app.listTasks(s.ctx(users.owner), { ...query, includeArchived: true, limit: 50 });
    expect(withArchived.items.map(row => row.id)).toEqual([
      s.tasks.todo.id, s.tasks.progress.id, s.tasks.review.id, s.tasks.triage.id, s.tasks.archivedOpen.id,
    ]);
  });

  it('keeps the exact status filter in conjunction and orders open tasks by due date', async () => {
    const s = await completionFixture();
    const base = { projectId: s.project.id, completion: 'open' as const, limit: 50 };
    const ids = async (input: TaskListQuery) => (await s.app.listTasks(s.ctx(users.owner), input)).items.map(row => row.id);
    expect(await ids({ ...base, statusId: s.review.id })).toEqual([s.tasks.review.id]);
    expect(await ids({ ...base, statusId: s.shipped.id })).toEqual([]);
    expect(await ids({ ...base, statusId: s.inGroup('cancelled').id })).toEqual([]);
    expect(await ids({ ...base, search: 'Triage' })).toEqual([s.tasks.triage.id]);
    expect(await ids({ ...base, sort: 'due_asc' })).toEqual([
      s.tasks.review.id, s.tasks.todo.id, s.tasks.progress.id, s.tasks.triage.id,
    ]);
  });

  it('binds explicit open into the cursor hash while omitted completion keeps the literal legacy hash', async () => {
    const s = await completionFixture();
    const base = { projectId: s.project.id, limit: 1 };
    const binding = { workspaceId: WS, actorUserId: users.owner, permissionEpoch: 'epoch-1' };
    const legacy = await s.app.listTasks(s.ctx(users.owner), base);
    expect(JSON.parse(legacy.nextCursor as string)).toEqual({
      version: 1, ...binding, queryHash: `digest:{"limit":1,"projectId":"${s.project.id}"}`,
      position: s.tasks.todo.position, id: s.tasks.todo.id,
    });
    const open = await s.app.listTasks(s.ctx(users.owner), { ...base, completion: 'open' });
    expect(JSON.parse(open.nextCursor as string)).toEqual({
      version: 1, ...binding, queryHash: `digest:{"completion":"open","limit":1,"projectId":"${s.project.id}"}`,
      position: s.tasks.todo.position, id: s.tasks.todo.id,
    });
    const openDue = await s.app.listTasks(s.ctx(users.owner), { ...base, completion: 'open', sort: 'due_asc' });
    expect(JSON.parse(openDue.nextCursor as string)).toEqual({
      version: 2, ...binding,
      queryHash: `digest:{"completion":"open","limit":1,"projectId":"${s.project.id}","sort":"due_asc"}`,
      dueDate: s.tasks.review.dueDate, id: s.tasks.review.id,
    });
    expect((await s.app.listTasks(s.ctx(users.owner), { ...base, cursor: legacy.nextCursor as string })).items.map(row => row.id))
      .toEqual([s.tasks.done.id]);
    expect((await s.app.listTasks(s.ctx(users.owner), { ...base, completion: 'open', cursor: open.nextCursor as string })).items.map(row => row.id))
      .toEqual([s.tasks.progress.id]);

    for (const input of [
      { ...base, cursor: open.nextCursor as string },
      { ...base, completion: 'open' as const, cursor: legacy.nextCursor as string },
      { ...base, completion: 'open' as const, statusId: s.review.id, cursor: open.nextCursor as string },
      { ...base, completion: 'open' as const, sort: 'due_asc' as const, cursor: open.nextCursor as string },
      { ...base, sort: 'due_asc' as const, cursor: openDue.nextCursor as string },
      { ...base, completion: 'open' as const, limit: 2, cursor: open.nextCursor as string },
    ]) expect((await errorOf(s.app.listTasks(s.ctx(users.owner), input))).code).toBe('VALIDATION_FAILED');
    expect((await errorOf(s.app.listTasks(s.ctx(users.viewer), { ...base, completion: 'open', cursor: open.nextCursor as string }))).code)
      .toBe('VALIDATION_FAILED');
  });

  it('checks current access before decoding cursors and rejects invalid completion instead of listing all', async () => {
    const s = await completionFixture();
    const base = { projectId: s.project.id, completion: 'open' as const, limit: 1 };
    expect((await errorOf(s.app.listTasks(s.ctx(users.revoked), { ...base, cursor: 'bad' }))).code).toBe('NOT_FOUND');
    expect((await errorOf(s.app.listTasks(s.ctx(users.owner), { ...base, projectId: uuid(990), cursor: 'bad' }))).code).toBe('NOT_FOUND');
    expect((await errorOf(s.app.listTasks(s.ctx(users.owner), { ...base, statusId: uuid(991), cursor: 'bad' }))).code).toBe('NOT_FOUND');
    const open = await s.app.listTasks(s.ctx(users.owner), base);
    s.db.epoch = 'epoch-2';
    expect((await errorOf(s.app.listTasks(s.ctx(users.owner), { ...base, cursor: open.nextCursor as string }))).code).toBe('VALIDATION_FAILED');
    const calls = s.db.listInputs.length;
    for (const completion of ['all', 'done', 'OPEN', '', null]) {
      const input = { projectId: s.project.id, completion, limit: 50 } as unknown as TaskListQuery;
      expect((await errorOf(s.app.listTasks(s.ctx(users.owner), input))).code).toBe('VALIDATION_FAILED');
    }
    expect(s.db.listInputs).toHaveLength(calls);
  });
});


describe('server task due sorting', () => {
  it('orders all tasks before paging, including date ties and the dated/null boundary', async () => {
    const s = await setup();
    const undated1 = await s.createTask({ title: 'Undated first' });
    const later = await s.createTask({ title: 'Later', dueDate: '9999-12-31' });
    const earliest = await s.createTask({ title: 'Earliest after manual first page', dueDate: '0001-01-01' });
    const tied = await s.createTask({ title: 'Same date', dueDate: '0001-01-01' });
    const undated2 = await s.createTask({ title: 'Undated last' });
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await s.app.listTasks(s.ctx(users.owner), { projectId: s.project.id, sort: 'due_asc', limit: 1, ...(cursor ? { cursor } : {}) });
      found.push(...page.items.map(row => row.id));
      if (page.nextCursor) {
        const payload = JSON.parse(page.nextCursor);
        expect(payload.version).toBe(2);
        expect(payload).not.toHaveProperty('position');
        expect(payload.dueDate).toBe(page.items[0]?.dueDate);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual([earliest.id, tied.id, later.id, undated1.id, undated2.id]);
    expect(new Set(found).size).toBe(found.length);
  });

  it('keeps omitted/manual hashes and cursor payloads exactly identical and mutually readable', async () => {
    const s = await setup();
    const firstTask = await s.createTask({ title: 'One' });
    const secondTask = await s.createTask({ title: 'Two' });
    const base = { projectId: s.project.id, limit: 1 };
    const omitted = await s.app.listTasks(s.ctx(users.owner), base);
    const manual = await s.app.listTasks(s.ctx(users.owner), { ...base, sort: 'manual' });
    const literal = { version: 1, workspaceId: WS, actorUserId: users.owner, permissionEpoch: 'epoch-1', queryHash: `digest:{"limit":1,"projectId":"${s.project.id}"}`, position: firstTask.position, id: firstTask.id };
    expect(manual).toEqual(omitted);
    expect(JSON.parse(manual.nextCursor as string)).toEqual(literal);
    for (const sort of [undefined, 'manual'] as const) {
      const next = await s.app.listTasks(s.ctx(users.owner), { ...base, ...(sort ? { sort } : {}), cursor: JSON.stringify(literal) });
      expect(next.items.map(row => row.id)).toEqual([secondTask.id]);
    }
  });

  it('rejects cross-sort, cross-filter, limit, actor and permission-epoch cursor reuse', async () => {
    const s = await setup();
    for (const title of ['One', 'Two']) await s.createTask({ title });
    const base = { projectId: s.project.id, limit: 1 };
    const manual = await s.app.listTasks(s.ctx(users.owner), base);
    const due = await s.app.listTasks(s.ctx(users.owner), { ...base, sort: 'due_asc' });
    const cursor = due.nextCursor as string;
    for (const input of [
      { ...base, sort: 'due_asc' as const, cursor: manual.nextCursor as string },
      { ...base, cursor },
      { ...base, sort: 'manual' as const, cursor },
      { ...base, sort: 'due_asc' as const, search: 'One', cursor },
      { ...base, sort: 'due_asc' as const, includeArchived: true, cursor },
      { ...base, sort: 'due_asc' as const, limit: 2, cursor },
    ]) expect((await errorOf(s.app.listTasks(s.ctx(users.owner), input))).code).toBe('VALIDATION_FAILED');
    expect((await errorOf(s.app.listTasks(s.ctx(users.viewer), { ...base, sort: 'due_asc', cursor }))).code).toBe('VALIDATION_FAILED');
    s.db.epoch = 'epoch-2';
    expect((await errorOf(s.app.listTasks(s.ctx(users.owner), { ...base, sort: 'due_asc', cursor }))).code).toBe('VALIDATION_FAILED');
    expect((await errorOf(s.app.listTasks(s.ctx(users.revoked), { ...base, sort: 'due_asc', cursor: 'bad' }))).code).toBe('NOT_FOUND');
    expect((await errorOf(s.app.listTasks(s.ctx(users.owner), { ...base, projectId: uuid(990), sort: 'due_asc', cursor: 'bad' }))).code).toBe('NOT_FOUND');
  });
});


type OrderFixture = Awaited<ReturnType<typeof setup>>;
type Placement = MoveTaskInput['placement'];
interface OrderSnapshot {
  readonly rows: Map<string, TaskDto>;
  readonly events: number;
  readonly side: string;
}

const ARCHIVED_AT = '2026-10-01T09:00:00.000Z';
/** Everything but task rows and receipts; an order write must leave all of it alone. */
const SIDE_TABLES = ['projects', 'sections', 'statuses', 'tags', 'packages', 'participants', 'taskTags'] as const;

const dumpOf = (state: State, ...names: readonly (keyof State)[]): string =>
  JSON.stringify(names.map((name) => Array.from(state[name] as Map<string, unknown>)));
const idsOf = (...tasks: readonly TaskDto[]): string[] => tasks.map((task) => task.id);
const insertion = (anchorTaskId: string, placement: Placement) => ({ insertion: { anchorTaskId, placement } });
/** Task fields an order write never touches; position, revision and updatedAt are the write itself. */
const semantic = (row: TaskDto) => ({ ...row, position: 0, revision: 0, updatedAt: '' });

/** The order model: every row of the project, archived and never-loaded ones included, by (position, id). */
function globalOrder(rows: ReadonlyMap<string, TaskDto>, projectId: string): string[] {
  return [...rows.values()]
    .filter((row) => row.workspaceId === WS && row.projectId === projectId)
    .sort((left, right) => left.position - right.position || (left.id < right.id ? -1 : 1))
    .map((row) => row.id);
}

/** Stores a copy of `template` directly, like a legacy or never-loaded row: no command, receipt or audit. */
function seedTask(s: OrderFixture, template: TaskDto, n: number, patch: Partial<TaskDto> = {}): TaskDto {
  const row: TaskDto = { ...(s.db.state.tasks.get(template.id) as TaskDto), id: uuid(n), title: `Seeded ${n}`, ...patch };
  s.db.state.tasks.set(row.id, row);
  return row;
}

/** Moves with the current stored revision of the source. */
function moveTo(s: OrderFixture, taskId: string, anchorTaskId: string, placement: Placement, context = s.owner()) {
  const expectedRevision = (s.db.state.tasks.get(taskId) as TaskDto).revision;
  return s.app.moveTask(context, taskId, { expectedRevision, anchorTaskId, placement });
}

function orderSnapshot(s: OrderFixture): OrderSnapshot {
  return { rows: s.projected(), events: s.events.length, side: dumpOf(s.db.state, ...SIDE_TABLES) };
}

/**
 * Asserts the project now reads `order` with distinct integer positions, and that the command wrote
 * nothing but order: every earlier row keeps its semantic fields (the moved root may take a new
 * section) and bumps its revision, with one audit event, exactly when its position changed. A
 * moved source always bumps. `createEvents` is the audit of a plain create, for insertions.
 */
function expectOrderWrite(
  s: OrderFixture,
  before: OrderSnapshot,
  order: readonly string[],
  moved: { readonly id: string; readonly sectionId?: string | null } | null,
  options: { readonly createEvents?: number } = {},
): void {
  const after = s.projected();
  expect(globalOrder(after, s.project.id)).toEqual(order);
  const positions = order.map((id) => (after.get(id) as TaskDto).position);
  expect(positions.every(Number.isInteger)).toBe(true);
  expect(new Set(positions).size).toBe(positions.length);

  let bumped = 0;
  for (const [id, old] of before.rows) {
    const row = after.get(id) as TaskDto;
    const isSource = moved !== null && moved.id === id;
    const sectionId = moved !== null && moved.id === id && moved.sectionId !== undefined ? moved.sectionId : old.sectionId;
    expect(semantic(row)).toEqual(semantic({ ...old, sectionId }));
    const delta = isSource || row.position !== old.position ? 1 : 0;
    expect({ id, revisionDelta: row.revision - old.revision }).toEqual({ id, revisionDelta: delta });
    bumped += delta;
  }
  expect(s.events.length - before.events).toBe((options.createEvents ?? 0) + bumped);
  if (options.createEvents === undefined) expect(dumpOf(s.db.state, ...SIDE_TABLES)).toBe(before.side);
  expect(s.db.writesOutsideRun).toBe(0);
}

/** A placement that keeps the ID order and section returns the original task and stores only a receipt. */
async function expectNoop(s: OrderFixture, taskId: string, anchorTaskId: string, placement: Placement) {
  const original = await s.app.getTask(s.ctx(users.owner), taskId);
  const rows = dumpOf(s.db.state, 'tasks', ...SIDE_TABLES);
  const events = s.events.length;
  const receipts = s.db.state.idempotency.size;
  const input = { expectedRevision: original.revision, anchorTaskId, placement };

  const context = s.owner();
  expect(await s.app.moveTask(context, taskId, input)).toEqual(original);
  expect(await s.app.moveTask(s.ctx(users.owner, context.idempotencyKey), taskId, input)).toEqual(original);
  const stale = await errorOf(s.app.moveTask(s.owner(), taskId, { ...input, expectedRevision: original.revision + 1 }));
  expect(stale.code).toBe('REVISION_CONFLICT');

  expect(dumpOf(s.db.state, 'tasks', ...SIDE_TABLES)).toBe(rows);
  expect(s.events).toHaveLength(events);
  expect(s.db.state.idempotency.size).toBe(receipts + 1);
}

async function expectRejectedWithoutWrites(s: OrderFixture, label: string, run: () => Promise<unknown>, code: string) {
  const state = dumpOf(s.db.state, 'tasks', 'idempotency', ...SIDE_TABLES);
  const events = s.events.length;
  expect({ label, code: (await errorOf(run())).code }).toEqual({ label, code });
  expect(dumpOf(s.db.state, 'tasks', 'idempotency', ...SIDE_TABLES)).toBe(state);
  expect(s.events).toHaveLength(events);
}

describe('manual task order', () => {
  it('creates tasks next to an anchor and keeps the plain create append path', async () => {
    const s = await setup();
    const a = await s.createTask({ title: 'A' });
    const b = await s.createTask({ title: 'B' });
    const eventsBefore = s.events.length;
    const c = await s.createTask({ title: 'C' });
    const createEvents = s.events.length - eventsBefore;

    let before = orderSnapshot(s);
    const x = await s.createTask({ title: 'X', ...insertion(b.id, 'after') });
    expect(x).toMatchObject({ title: 'X', revision: 1, sectionId: null, parentTaskId: null });
    expect(x).toEqual(await s.app.getTask(s.ctx(users.owner), x.id));
    expectOrderWrite(s, before, idsOf(a, b, x, c), null, { createEvents });

    before = orderSnapshot(s);
    const y = await s.createTask({ title: 'Y', ...insertion(x.id, 'after') });
    expectOrderWrite(s, before, idsOf(a, b, x, y, c), null, { createEvents });

    before = orderSnapshot(s);
    const z = await s.createTask({ title: 'Z' });
    expectOrderWrite(s, before, idsOf(a, b, x, y, c, z), null, { createEvents });
  });

  it('replays an insertion receipt and binds the anchor and placement into its key', async () => {
    const s = await setup();
    const a = await s.createTask({ title: 'A' });
    const b = await s.createTask({ title: 'B' });
    const key = s.key();
    const plain = { projectId: s.project.id, statusId: s.statusId, title: 'X' };
    const input = { ...plain, ...insertion(a.id, 'after') };
    const first = await s.app.createTask(s.ctx(users.owner, key), input);
    const state = dumpOf(s.db.state, 'tasks', 'idempotency', ...SIDE_TABLES);
    const events = s.events.length;

    expect(JSON.stringify(await s.app.createTask(s.ctx(users.owner, key), input))).toBe(JSON.stringify(first));
    expect(dumpOf(s.db.state, 'tasks', 'idempotency', ...SIDE_TABLES)).toBe(state);
    expect(s.events).toHaveLength(events);
    expect(globalOrder(s.projected(), s.project.id)).toEqual(idsOf(a, first, b));

    for (const [label, body] of [
      ['other placement', { ...plain, ...insertion(a.id, 'before') }],
      ['other anchor', { ...plain, ...insertion(b.id, 'after') }],
      ['no insertion', plain],
    ] as const) {
      await expectRejectedWithoutWrites(s, label, () => s.app.createTask(s.ctx(users.owner, key), body), 'IDEMPOTENCY_KEY_REUSED');
    }
  });

  it('moves a root task before or after the first and last siblings', async () => {
    const s = await setup();
    const a = await s.createTask({ title: 'A' });
    const b = await s.createTask({ title: 'B' });
    const c = await s.createTask({ title: 'C' });
    const d = await s.createTask({ title: 'D' });
    const steps: [TaskDto, TaskDto, Placement, TaskDto[]][] = [
      [d, a, 'before', [d, a, b, c]],
      [d, c, 'after', [a, b, c, d]],
      [a, d, 'after', [b, c, d, a]],
      [a, b, 'before', [a, b, c, d]],
    ];
    for (const [source, anchor, placement, order] of steps) {
      const before = orderSnapshot(s);
      const planningChecks = s.db.planningChecks.length;
      const moved = await moveTo(s, source.id, anchor.id, placement);
      expect(moved).toEqual(await s.app.getTask(s.ctx(users.owner), source.id));
      expectOrderWrite(s, before, idsOf(...order), { id: source.id });
      expect(s.db.planningChecks.length).toBeGreaterThan(planningChecks);
    }
  });

  it('treats a placement that keeps the ID order and section as a receipt-only no-op', async () => {
    const s = await setup();
    const a = await s.createTask({ title: 'A' });
    const b = await s.createTask({ title: 'B' });
    const c = await s.createTask({ title: 'C' });

    await expectNoop(s, b.id, a.id, 'after');
    await expectNoop(s, b.id, c.id, 'before');
    await expectNoop(s, a.id, b.id, 'before');
    await expectNoop(s, c.id, b.id, 'after');
  });

  it('keeps legacy ties on a no-op and bumps the source on a real reorder even if its key could stay', async () => {
    const s = await setup();
    const head = await s.createTask({ title: 'Head' });
    s.db.state.tasks.set(head.id, { ...(s.db.state.tasks.get(head.id) as TaskDto), position: 0 });
    const first = seedTask(s, head, 5001, { position: 1 });
    const tiedLow = seedTask(s, head, 5002, { position: 2 });
    const tiedHigh = seedTask(s, head, 5003, { position: 2 });
    expect(globalOrder(s.projected(), s.project.id)).toEqual(idsOf(head, first, tiedLow, tiedHigh));

    await expectNoop(s, tiedHigh.id, tiedLow.id, 'after');
    await expectNoop(s, tiedLow.id, tiedHigh.id, 'before');
    await expectNoop(s, first.id, tiedLow.id, 'before');

    // Renumbered 0..3 the source would keep position 2; the order still changed, so it bumps.
    const before = orderSnapshot(s);
    await moveTo(s, tiedHigh.id, tiedLow.id, 'before');
    expectOrderWrite(s, before, idsOf(head, first, tiedHigh, tiedLow), { id: tiedHigh.id });
  });

  it('splices roots and subtasks into the project-global order around other sections, parents and archived rows', async () => {
    const s = await setup();
    const section = await s.app.createSection(s.owner(), s.project.id, { name: 'Later' });
    const a = await s.createTask({ title: 'A' });
    const inSection = await s.createTask({ title: 'In section', sectionId: section.id });
    const p = await s.createTask({ title: 'P', estimateMinutes: 120 });
    const p1 = await s.createTask({ title: 'P1', parentTaskId: p.id });
    const b = await s.createTask({ title: 'B' });
    const q = await s.createTask({ title: 'Q' });
    const q1 = await s.createTask({ title: 'Q1', parentTaskId: q.id });
    const archived = await s.createTask({ title: 'Archived' });
    await s.app.archiveTask(s.owner(), archived.id, { expectedRevision: 1 });
    const p2 = await s.createTask({ title: 'P2', parentTaskId: p.id });
    const eventsBefore = s.events.length;
    const c = await s.createTask({ title: 'C' });
    const createEvents = s.events.length - eventsBefore;

    let before = orderSnapshot(s);
    await moveTo(s, c.id, a.id, 'after');
    expectOrderWrite(s, before, idsOf(a, c, inSection, p, p1, b, q, q1, archived, p2), { id: c.id });

    before = orderSnapshot(s);
    await moveTo(s, a.id, q.id, 'after');
    expectOrderWrite(s, before, idsOf(c, inSection, p, p1, b, q, a, q1, archived, p2), { id: a.id });

    before = orderSnapshot(s);
    const child = await moveTo(s, p2.id, p1.id, 'before');
    expect(child).toMatchObject({ parentTaskId: p.id, workPackageId: p.workPackageId, estimateMinutes: 120 });
    expectOrderWrite(s, before, idsOf(c, inSection, p, p2, p1, b, q, a, q1, archived), { id: p2.id });

    before = orderSnapshot(s);
    const x = await s.createTask({ title: 'X', ...insertion(b.id, 'before') });
    expectOrderWrite(s, before, idsOf(c, inSection, p, p2, p1, x, b, q, a, q1, archived), null, { createEvents });

    // The archived row keeps its relative place above, but can be neither source nor anchor.
    const archivedRevision = (s.db.state.tasks.get(archived.id) as TaskDto).revision;
    await expectRejectedWithoutWrites(s, 'archived source', () =>
      s.app.moveTask(s.owner(), archived.id, { expectedRevision: archivedRevision, anchorTaskId: b.id, placement: 'after' }),
    'DOMAIN_VALIDATION_FAILED');
    await expectRejectedWithoutWrites(s, 'archived anchor', () => moveTo(s, b.id, archived.id, 'after'), 'DOMAIN_VALIDATION_FAILED');
    await expectRejectedWithoutWrites(s, 'archived insertion anchor', () => s.createTask(insertion(archived.id, 'before')), 'DOMAIN_VALIDATION_FAILED');
  });

  it('lets a root task take the anchor section and writes a section-only change', async () => {
    const s = await setup();
    const section = await s.app.createSection(s.owner(), s.project.id, { name: 'Later' });
    const a = await s.createTask({ title: 'A' });
    const b = await s.createTask({ title: 'B', sectionId: section.id });
    const c = await s.createTask({ title: 'C' });

    let before = orderSnapshot(s);
    expect((await moveTo(s, c.id, b.id, 'before')).sectionId).toBe(section.id);
    expectOrderWrite(s, before, idsOf(a, c, b), { id: c.id, sectionId: section.id });

    // Same ID order, other section: a real write, not a no-op.
    before = orderSnapshot(s);
    expect((await moveTo(s, c.id, a.id, 'after')).sectionId).toBeNull();
    expectOrderWrite(s, before, idsOf(a, c, b), { id: c.id, sectionId: null });
  });

  it('keeps subtasks under their parent and in their section, without reparenting', async () => {
    const s = await setup();
    const section = await s.app.createSection(s.owner(), s.project.id, { name: 'Later' });
    const p = await s.createTask({ title: 'P' });
    const p1 = await s.createTask({ title: 'P1', parentTaskId: p.id });
    const q = await s.createTask({ title: 'Q' });
    const q1 = await s.createTask({ title: 'Q1', parentTaskId: q.id });
    const p2 = seedTask(s, p1, 5101, {
      position: (s.db.state.tasks.get(q1.id) as TaskDto).position + 1,
      sectionId: section.id,
    });

    for (const [label, source, anchor] of [
      ['subtask next to another parent child', p1, q1],
      ['subtask next to its parent', p1, p],
      ['root next to a subtask', q, p1],
      ['subtask next to a sibling in another section', p1, p2],
    ] as const) {
      await expectRejectedWithoutWrites(s, label, () => moveTo(s, source.id, anchor.id, 'after'), 'DOMAIN_VALIDATION_FAILED');
    }
    await expectRejectedWithoutWrites(s, 'subtask create next to another parent child', () =>
      s.createTask({ parentTaskId: p.id, ...insertion(q1.id, 'after') }), 'DOMAIN_VALIDATION_FAILED');
    await expectRejectedWithoutWrites(s, 'root create in another section than the anchor', () =>
      s.createTask({ sectionId: section.id, ...insertion(q.id, 'before') }), 'DOMAIN_VALIDATION_FAILED');
  });

  it('rejects self, missing, foreign, cross-project, stale, unauthorized and closed-project moves without writes', async () => {
    const s = await setup();
    const a = await s.createTask({ title: 'A' });
    const b = await s.createTask({ title: 'B' });
    const other = await s.app.createProject(s.owner(), { name: 'Other project' });
    const [otherStatus] = await s.app.listStatuses(s.ctx(users.owner), other.id);
    const otherProjectTask = await s.createTask({ projectId: other.id, statusId: otherStatus?.id ?? '' });
    const otherWorkspaceTask = seedTask(s, b, 5201, { workspaceId: uuid(902), projectId: uuid(903) });
    const valid = { expectedRevision: 1, anchorTaskId: a.id, placement: 'before' } as const;

    const cases: [string, () => Promise<unknown>, string][] = [
      ['self anchor', () => moveTo(s, a.id, a.id, 'after'), 'DOMAIN_VALIDATION_FAILED'],
      ['missing anchor', () => moveTo(s, b.id, uuid(999), 'before'), 'NOT_FOUND'],
      ['anchor in another workspace', () => moveTo(s, b.id, otherWorkspaceTask.id, 'before'), 'NOT_FOUND'],
      ['anchor in another project', () => moveTo(s, b.id, otherProjectTask.id, 'before'), 'DOMAIN_VALIDATION_FAILED'],
      ['missing source', () => s.app.moveTask(s.owner(), uuid(998), valid), 'NOT_FOUND'],
      ['stale revision', () => s.app.moveTask(s.owner(), b.id, { ...valid, expectedRevision: 2 }), 'REVISION_CONFLICT'],
      ['viewer', () => moveTo(s, b.id, a.id, 'before', s.ctx(users.viewer, s.key())), 'CAPABILITY_REQUIRED'],
      ['revoked member', () => moveTo(s, b.id, a.id, 'before', s.ctx(users.revoked, s.key())), 'NOT_FOUND'],
      ['other workspace context', () => moveTo(s, b.id, a.id, 'before', s.ctx(users.owner, s.key(), uuid(902))), 'NOT_FOUND'],
      ['missing idempotency key', () => moveTo(s, b.id, a.id, 'before', s.ctx(users.owner)), 'VALIDATION_FAILED'],
      ['unparsed placement', () => s.app.moveTask(s.owner(), b.id, { ...valid, placement: 'inside' } as unknown as MoveTaskInput), 'VALIDATION_FAILED'],
      ['position in a direct call', () => s.app.moveTask(s.owner(), b.id, { ...valid, position: 0 } as unknown as MoveTaskInput), 'VALIDATION_FAILED'],
    ];
    for (const [label, run, code] of cases) await expectRejectedWithoutWrites(s, label, run, code);

    await s.app.updateProject(s.owner(), s.project.id, { expectedRevision: 1, archived: true });
    await expectRejectedWithoutWrites(s, 'archived project', () => moveTo(s, b.id, a.id, 'before'), 'DOMAIN_VALIDATION_FAILED');
  });

  it('replays a move receipt exactly, binds it to the body and target, and checks access first', async () => {
    const s = await setup();
    const a = await s.createTask({ title: 'A' });
    const b = await s.createTask({ title: 'B' });
    const c = await s.createTask({ title: 'C' });
    const key = s.key();
    const input = { expectedRevision: 1, anchorTaskId: a.id, placement: 'before' } as const;
    const first = await s.app.moveTask(s.ctx(users.owner, key), c.id, input);
    expect(globalOrder(s.projected(), s.project.id)).toEqual(idsOf(c, a, b));
    const state = dumpOf(s.db.state, 'tasks', 'idempotency', ...SIDE_TABLES);
    const events = s.events.length;

    // The receipt wins over the now stale expectedRevision.
    expect(JSON.stringify(await s.app.moveTask(s.ctx(users.owner, key), c.id, input))).toBe(JSON.stringify(first));
    expect(dumpOf(s.db.state, 'tasks', 'idempotency', ...SIDE_TABLES)).toBe(state);
    expect(s.events).toHaveLength(events);

    const reuses: [string, () => Promise<unknown>][] = [
      ['other placement', () => s.app.moveTask(s.ctx(users.owner, key), c.id, { ...input, placement: 'after' })],
      ['other anchor', () => s.app.moveTask(s.ctx(users.owner, key), c.id, { ...input, anchorTaskId: b.id })],
      ['other revision', () => s.app.moveTask(s.ctx(users.owner, key), c.id, { ...input, expectedRevision: 2 })],
      ['other target', () => s.app.moveTask(s.ctx(users.owner, key), b.id, input)],
    ];
    for (const [label, run] of reuses) await expectRejectedWithoutWrites(s, label, run, 'IDEMPOTENCY_KEY_REUSED');

    const restore = revokeMembership(members.owner);
    try {
      await expectRejectedWithoutWrites(s, 'replay after revocation', () => s.app.moveTask(s.ctx(users.owner, key), c.id, input), 'NOT_FOUND');
    } finally {
      restore();
    }
    expect(JSON.stringify(await s.app.moveTask(s.ctx(users.owner, key), c.id, input))).toBe(JSON.stringify(first));
  });

  it('keeps the old create payload hash and replays its stored receipt unchanged', async () => {
    const s = await setup();
    const key = s.key();
    const input = { projectId: s.project.id, statusId: s.statusId, title: 'Draft plan' };
    const first = await s.app.createTask(s.ctx(users.owner, key), input);
    const receipt = [...s.db.state.idempotency.values()].find((row) => row.idempotencyKey === key);
    // Literal pre-insertion encoding of {command,target,input}: an insertion default or null would change this hash.
    expect(receipt?.payloadHash).toBe(
      `digest:{"command":"task.create","input":{"projectId":"${s.project.id}","statusId":"${s.statusId}","title":"Draft plan"},"target":null}`,
    );
    const state = dumpOf(s.db.state, 'tasks', 'idempotency', ...SIDE_TABLES);
    const events = s.events.length;

    expect(JSON.stringify(await s.app.createTask(s.ctx(users.owner, key), { ...input }))).toBe(JSON.stringify(first));
    expect(dumpOf(s.db.state, 'tasks', 'idempotency', ...SIDE_TABLES)).toBe(state);
    expect(s.events).toHaveLength(events);
    await expectRejectedWithoutWrites(s, 'insertion on the old key', () =>
      s.app.createTask(s.ctx(users.owner, key), { ...input, ...insertion(first.id, 'after') }), 'IDEMPOTENCY_KEY_REUSED');
  });

  it('renumbers the whole project past one 200-row page and keeps every hidden row in place', async () => {
    const s = await setup();
    const section = await s.app.createSection(s.owner(), s.project.id, { name: 'Later' });
    const head = await s.createTask({ title: 'Head', estimateMinutes: 15 });
    const eventsBefore = s.events.length;
    const parent = await s.createTask({ title: 'Parent' });
    const createEvents = s.events.length - eventsBefore;
    const start = (s.db.state.tasks.get(parent.id) as TaskDto).position + 1;
    // Pairs share a legacy position; kinds rotate root, root, root, other section, subtask, archived.
    const seeded = Array.from({ length: 240 }, (_, index) =>
      seedTask(s, parent, 6000 + index, {
        position: start + Math.floor(index / 2),
        ...(index % 6 === 3 ? { sectionId: section.id } : {}),
        ...(index % 6 === 4 ? { parentTaskId: parent.id } : {}),
        ...(index % 6 === 5 ? { archivedAt: ARCHIVED_AT } : {}),
      }),
    );
    const seededIds = (from: number, to?: number) => idsOf(...seeded.slice(from, to));
    expect(globalOrder(s.projected(), s.project.id)).toEqual([head.id, parent.id, ...seededIds(0)]);

    let before = orderSnapshot(s);
    await moveTo(s, head.id, (seeded[234] as TaskDto).id, 'after');
    const moved = [parent.id, ...seededIds(0, 235), head.id, ...seededIds(235)];
    expect(moved).toHaveLength(242);
    expectOrderWrite(s, before, moved, { id: head.id });

    before = orderSnapshot(s);
    const late = await s.createTask({ title: 'Late', ...insertion((seeded[228] as TaskDto).id, 'before') });
    expectOrderWrite(s, before, [parent.id, ...seededIds(0, 228), late.id, ...seededIds(228, 235), head.id, ...seededIds(235)], null, {
      createEvents,
    });
  });
});
