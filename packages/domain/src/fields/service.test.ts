import type {
  CreateTaskFieldInput,
  ProjectColumnsDto,
  ProjectDto,
  SetTaskFieldValueInput,
  TaskDto,
  TaskFieldData,
  TaskFieldDefinitionDto,
  TaskFieldValueDto,
  TaskFieldValueHistoryDto,
} from '@workloom/contracts';
import { describe, expect, it } from 'vitest';

import { authorizeLoadedAccess } from '../access/access-queries.js';
import type { CommandContext, CommandSource } from '../access/context.js';
import type { AccessRepository, MembershipRecord } from '../access/ports.js';
import { DomainError } from '../errors.js';
import type { IdempotencyRecord, TaskRepository } from '../tasks/ports.js';
import type { ChangeEventInput } from '../transactions/ports.js';
import type {
  TaskFieldHistoryCursorPayload,
  TaskFieldOptionRecord,
  TaskFieldRepository,
  TaskFieldTools,
  TaskFieldUnitOfWork,
} from './ports.js';
import { createTaskFieldApplication } from './service.js';

// Port doubles for domain decisions only. SQL scoping, constraints, races and real transactions
// are covered by the PostgreSQL integration suite.

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WS = uuid(1);
const OTHER_WS = uuid(2);
const P = uuid(3);
const Q = uuid(4);
const ARCHIVED_P = uuid(5);
const tasks = { a: uuid(31), b: uuid(32), inQ: uuid(33), archived: uuid(34) };
const users = { owner: uuid(11), member: uuid(12), viewer: uuid(13), colleague: uuid(14) };
const members = { owner: uuid(21), member: uuid(22), viewer: uuid(23), colleague: uuid(24) };
const T0 = '2026-10-01T00:00:00.000Z';

interface State {
  projects: Map<string, ProjectDto>;
  tasks: Map<string, TaskDto>;
  fields: Map<string, TaskFieldDefinitionDto>;
  options: Map<string, TaskFieldOptionRecord>;
  versions: Map<string, TaskFieldDefinitionDto>;
  columns: Map<string, ProjectColumnsDto>;
  values: Map<string, TaskFieldValueDto>;
  history: TaskFieldValueHistoryDto[];
  idempotency: Map<string, IdempotencyRecord>;
}

function cloneState(state: State): State {
  return {
    projects: new Map(state.projects),
    tasks: new Map(state.tasks),
    fields: new Map(state.fields),
    options: new Map(state.options),
    versions: new Map(state.versions),
    columns: new Map(state.columns),
    values: new Map(state.values),
    history: [...state.history],
    idempotency: new Map(state.idempotency),
  };
}

const project = (id: string, archivedAt: string | null = null): ProjectDto => ({
  id,
  workspaceId: WS,
  name: `Project ${id.slice(-2)}`,
  revision: 1,
  archivedAt,
  createdAt: T0,
  updatedAt: T0,
});

const task = (id: string, projectId: string, archivedAt: string | null = null): TaskDto => ({
  id,
  workspaceId: WS,
  projectId,
  sectionId: null,
  parentTaskId: null,
  workPackageId: uuid(900),
  workPackageRevision: 1,
  title: 'Synthetic task',
  description: '',
  statusId: uuid(800),
  responsibleMembershipId: null,
  participants: [],
  participantsRevision: 1,
  dueDate: null,
  priority: 'none',
  tags: [],
  estimateMinutes: null,
  revision: 1,
  position: 0,
  visibility: 'workspace',
  archivedAt,
  createdAt: T0,
  updatedAt: T0,
});

interface RecordedEvent {
  readonly event: ChangeEventInput;
  readonly changeSeq: bigint;
  readonly eventOrdinal: number;
}

const unused = async (): Promise<never> => {
  throw new Error('Not used by field tests.');
};

function harness() {
  const memberships: MembershipRecord[] = [
    { id: members.owner, workspaceId: WS, userId: users.owner, displayName: 'Olivia Owner', role: 'owner', state: 'active', revision: 1 },
    { id: members.member, workspaceId: WS, userId: users.member, displayName: 'Max Member', role: 'member', state: 'active', revision: 1 },
    { id: members.viewer, workspaceId: WS, userId: users.viewer, displayName: 'Vera Viewer', role: 'viewer', state: 'active', revision: 1 },
    { id: members.colleague, workspaceId: WS, userId: users.colleague, displayName: 'Cole', role: 'member', state: 'active', revision: 1 },
  ];
  const setMembership = (id: string, change: Partial<Pick<MembershipRecord, 'role' | 'state'>>) => {
    const index = memberships.findIndex((membership) => membership.id === id);
    const current = memberships[index];
    if (current === undefined) throw new Error('Unknown fixture membership.');
    memberships[index] = { ...current, ...change };
  };

  const db = {
    state: cloneState({
      projects: new Map([P, Q].map((id) => [id, project(id)])).set(ARCHIVED_P, project(ARCHIVED_P, T0)),
      tasks: new Map([
        [tasks.a, task(tasks.a, P)],
        [tasks.b, task(tasks.b, P)],
        [tasks.inQ, task(tasks.inQ, Q)],
        [tasks.archived, task(tasks.archived, P, T0)],
      ]),
      fields: new Map(),
      options: new Map(),
      versions: new Map(),
      columns: new Map(),
      values: new Map(),
      history: [],
      idempotency: new Map(),
    }),
    epoch: 'epoch-1',
  };
  const events: RecordedEvent[] = [];

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

  const scoped = <T extends { workspaceId: string }>(row: T | undefined, ws: string): T | null =>
    row !== undefined && row.workspaceId === ws ? row : null;
  const idempotencyKey = (ws: string, actor: string, command: string, key: string) => [ws, actor, command, key].join('|');

  const taskRepository: TaskRepository = {
    access,
    permissionEpoch: async () => db.epoch,
    findProject: async (ws, id) => scoped(db.state.projects.get(id), ws),
    listProjects: unused,
    insertProject: unused,
    saveProject: unused,
    findSection: unused,
    listSections: unused,
    insertSection: unused,
    saveSection: unused,
    findStatus: unused,
    listStatuses: unused,
    insertStatus: unused,
    findTag: unused,
    listTags: unused,
    insertTag: unused,
    saveTag: unused,
    findWorkPackage: unused,
    insertWorkPackage: unused,
    saveWorkPackage: unused,
    findTask: async (ws, id) => scoped(db.state.tasks.get(id), ws),
    listTasks: unused,
    insertTaskCore: unused,
    saveTaskCore: unused,
    saveParticipants: unused,
    setTaskTagIds: unused,
    findIdempotency: async (ws, actor, command, key) =>
      db.state.idempotency.get(idempotencyKey(ws, actor, command, key)) ?? null,
    insertIdempotency: async (row) =>
      void db.state.idempotency.set(idempotencyKey(row.workspaceId, row.actorUserId, row.command, row.idempotencyKey), row),
  };

  /** Field columns only; the catalog is joined from option rows, as the real adapter does. */
  const joinField = (row: TaskFieldDefinitionDto): TaskFieldDefinitionDto => ({
    ...row,
    options: [...db.state.options.values()]
      .filter((option) => option.fieldId === row.id)
      .sort((left, right) => left.position - right.position || (left.id < right.id ? -1 : 1))
      .map((option) => ({
        id: option.id,
        name: option.name,
        color: option.color,
        position: option.position,
        revision: option.revision,
        archivedAt: option.archivedAt,
      })),
  });
  const valueKey = (taskId: string, fieldId: string) => `${taskId}|${fieldId}`;

  const repository: TaskFieldRepository = {
    tasks: taskRepository,
    async findField(ws, id) {
      const row = scoped(db.state.fields.get(id), ws);
      return row === null ? null : joinField(row);
    },
    listFields: async (ws, projectId) =>
      [...db.state.fields.values()]
        .filter((row) => row.workspaceId === ws && row.projectId === projectId)
        .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : 1))
        .map(joinField),
    insertField: async (row) => void db.state.fields.set(row.id, { ...row, options: [] }),
    saveField: async (row) => void db.state.fields.set(row.id, { ...row, options: [] }),
    async insertDefinitionVersion(snapshot) {
      if (db.state.versions.has(snapshot.definitionVersionId)) throw new Error('Definition versions are immutable.');
      db.state.versions.set(snapshot.definitionVersionId, snapshot);
    },
    findOption: async (ws, id) => scoped(db.state.options.get(id), ws),
    insertOption: async (row) => void db.state.options.set(row.id, row),
    saveOption: async (row) => void db.state.options.set(row.id, row),
    findProjectColumns: async (ws, projectId) => scoped(db.state.columns.get(projectId), ws),
    saveProjectColumns: async (row) => void db.state.columns.set(row.projectId, { ...row, columns: [...row.columns] }),
    findValue: async (ws, taskId, fieldId) => scoped(db.state.values.get(valueKey(taskId, fieldId)), ws),
    listTaskValues: async (ws, taskId) =>
      [...db.state.values.values()].filter((row) => row.workspaceId === ws && row.taskId === taskId),
    listProjectValues: async (ws, projectId, taskIds) =>
      [...db.state.values.values()].filter(
        (row) => row.workspaceId === ws && row.projectId === projectId && taskIds.includes(row.taskId),
      ),
    saveValue: async (row) => void db.state.values.set(valueKey(row.taskId, row.fieldId), row),
    insertValueHistory: async (row) => void db.state.history.push(row),
    async listValueHistory(ws, taskId, fieldId, after, take) {
      const order = (row: { changeSeq: string; eventOrdinal: number; id: string }) =>
        [BigInt(row.changeSeq), row.eventOrdinal, row.id] as const;
      const compare = (left: ReturnType<typeof order>, right: ReturnType<typeof order>) =>
        left[0] !== right[0] ? (left[0] < right[0] ? -1 : 1) : left[1] !== right[1] ? left[1] - right[1] : left[2] < right[2] ? -1 : 1;
      return db.state.history
        .filter((row) => row.workspaceId === ws && row.taskId === taskId && row.fieldId === fieldId)
        .sort((left, right) => compare(order(right), order(left)))
        .filter((row) => after === null || compare(order(row), order(after)) < 0)
        .slice(0, take);
    },
  };

  let second = 0;
  let transactions = 0;
  const writer: TaskFieldUnitOfWork = {
    async run(context, capability, work) {
      const loaded = authorizeLoadedAccess(
        await access.findWorkspaceAccess(context.workspaceId, context.actor.userId),
        capability,
      );
      const snapshot = cloneState(db.state);
      const eventCount = events.length;
      const changeSeq = BigInt((transactions += 1));
      let ordinal = 0;
      try {
        return await work({
          context,
          access: loaded,
          barrierAt: new Date(Date.UTC(2026, 9, 16, 9, 0, (second += 1))),
          repository,
          async recordChange(event) {
            ordinal += 1;
            events.push({ event, changeSeq, eventOrdinal: ordinal });
            return { changeSeq, eventOrdinal: ordinal };
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
  const tools: TaskFieldTools = {
    newId: () => uuid((nextId += 1)),
    digest: (value) => `digest:${value}`,
    encodeHistoryCursor: (payload) => JSON.stringify(payload),
    decodeHistoryCursor(token) {
      try {
        return JSON.parse(token) as TaskFieldHistoryCursorPayload;
      } catch {
        throw new DomainError('VALIDATION_FAILED', 'The cursor is no longer valid.');
      }
    },
  };

  let keys = 0;
  const ctx = (userId: string, idempotencyKey?: string, source: CommandSource = 'web'): CommandContext => {
    const base = {
      actor: { userId, displayName: 'Synthetic', kind: 'fixture' as const },
      source,
      requestId: `req-${keys}`,
      workspaceId: WS,
    };
    return idempotencyKey === undefined ? base : { ...base, idempotencyKey };
  };
  const key = () => `key-${(keys += 1)}`;
  const owner = () => ctx(users.owner, key());
  const app = createTaskFieldApplication({ reader: repository, writer, tools });

  const fieldInput = (input: Partial<CreateTaskFieldInput> & Pick<CreateTaskFieldInput, 'name' | 'type'>): CreateTaskFieldInput => ({
    projectId: P,
    historyEnabled: true,
    locked: false,
    options: [],
    ...input,
  });
  const createField = (input: Partial<CreateTaskFieldInput> & Pick<CreateTaskFieldInput, 'name' | 'type'>) =>
    app.createField(owner(), fieldInput(input));
  const setValue = (
    taskId: string,
    fieldId: string,
    value: TaskFieldData,
    expectedRevision: number,
    expectedDefinitionRevision = 1,
    context: CommandContext = owner(),
  ) => app.setTaskValue(context, taskId, fieldId, { expectedRevision, expectedDefinitionRevision, value });

  return { app, db, events, ctx, key, owner, setMembership, createField, setValue };
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

const optionId = (field: TaskFieldDefinitionDto, name: string): string => {
  const option = field.options.find((item) => item.name === name);
  if (option === undefined) throw new Error(`Option ${name} is missing.`);
  return option.id;
};

describe('field definitions', () => {
  it('creates a field with server option IDs, a first version and an appended shared column', async () => {
    const h = harness();
    const field = await h.createField({
      name: 'Stage',
      type: 'single_select',
      options: [
        { name: 'Draft', color: null },
        { name: 'Done', color: '#aabbcc' },
      ],
    });

    expect(field).toMatchObject({ revision: 1, historyEnabled: true, locked: false, archivedAt: null });
    expect(field.options.map((option) => [option.name, option.position, option.revision])).toEqual([
      ['Draft', 0, 1],
      ['Done', 1, 1],
    ]);
    expect(h.db.state.versions.get(field.definitionVersionId)).toEqual(field);
    expect(h.events.map((item) => [item.event.entityType, item.eventOrdinal])).toEqual([
      ['task_field', 1],
      ['project_columns', 2],
    ]);

    const second = await h.createField({ name: 'Notes', type: 'text' });
    const columns = await h.app.getProjectColumns(h.ctx(users.viewer), P);
    expect(columns).toEqual({
      workspaceId: WS,
      projectId: P,
      revision: 3,
      columns: [
        { fieldId: field.id, visible: true, width: 160, position: 0 },
        { fieldId: second.id, visible: true, width: 160, position: 1 },
      ],
    });
    expect(await h.app.getProjectColumns(h.ctx(users.viewer), Q)).toEqual({ workspaceId: WS, projectId: Q, revision: 1, columns: [] });
  });

  it('rejects options on non-select fields, reserved names, archived projects and any type change', async () => {
    const h = harness();
    expect((await errorOf(h.createField({ name: 'Notes', type: 'text', options: [{ name: 'A', color: null }] }))).code).toBe(
      'DOMAIN_VALIDATION_FAILED',
    );
    expect((await errorOf(h.createField({ name: 'Notes', type: 'text', projectId: ARCHIVED_P }))).code).toBe(
      'DOMAIN_VALIDATION_FAILED',
    );

    const owner = await h.createField({ name: 'Owner', type: 'text' });
    await h.app.updateField(h.owner(), owner.id, { expectedRevision: 1, archived: true });
    expect((await errorOf(h.createField({ name: 'owner', type: 'text' }))).code).toBe('DOMAIN_VALIDATION_FAILED');

    const field = await h.createField({ name: 'Notes', type: 'text' });
    const retype = await errorOf(h.app.updateField(h.owner(), field.id, { expectedRevision: 1, type: 'number' }));
    expect(retype.code).toBe('DOMAIN_VALIDATION_FAILED');

    const renamed = await h.app.updateField(h.owner(), field.id, { expectedRevision: 1, type: 'text', name: 'Remarks' });
    expect(renamed).toMatchObject({ id: field.id, name: 'Remarks', revision: 2 });
    expect(renamed.definitionVersionId).not.toBe(field.definitionVersionId);
    expect(h.db.state.versions.get(field.definitionVersionId)?.name).toBe('Notes');
    expect(h.events.at(-1)?.event).toMatchObject({ entityType: 'task_field', action: 'updated' });
  });

  it('manages options by stable ID under the field revision', async () => {
    const h = harness();
    const stage = await h.createField({ name: 'Stage', type: 'single_select', options: [{ name: 'Draft', color: null }] });
    const other = await h.createField({ name: 'Other', type: 'single_select', options: [{ name: 'X', color: null }] });
    const text = await h.createField({ name: 'Notes', type: 'text' });
    const draft = optionId(stage, 'Draft');

    const added = await h.app.createOption(h.owner(), stage.id, { expectedRevision: 1, name: 'Review', color: null });
    expect(added.options.map((option) => [option.name, option.position])).toEqual([
      ['Draft', 0],
      ['Review', 1],
    ]);
    expect((await errorOf(h.app.createOption(h.owner(), stage.id, { expectedRevision: 2, name: 'DRAFT', color: null }))).code).toBe(
      'DOMAIN_VALIDATION_FAILED',
    );
    expect((await errorOf(h.app.createOption(h.owner(), text.id, { expectedRevision: 1, name: 'A', color: null }))).code).toBe(
      'DOMAIN_VALIDATION_FAILED',
    );
    expect((await errorOf(h.app.createOption(h.owner(), stage.id, { expectedRevision: 1, name: 'Late', color: null }))).code).toBe(
      'REVISION_CONFLICT',
    );

    const archived = await h.app.updateOption(h.owner(), stage.id, draft, { expectedRevision: 2, archived: true, name: 'Old draft' });
    expect(archived.options.find((option) => option.id === draft)).toMatchObject({ name: 'Old draft', revision: 2 });
    expect(archived.revision).toBe(3);

    const foreignField = h.app.updateOption(h.owner(), stage.id, optionId(other, 'X'), { expectedRevision: 3, name: 'Y' });
    expect((await errorOf(foreignField)).code).toBe('DOMAIN_VALIDATION_FAILED');
    expect((await errorOf(h.app.updateOption(h.owner(), stage.id, uuid(999), { expectedRevision: 3, name: 'Y' }))).code).toBe(
      'NOT_FOUND',
    );
  });
});

describe('field values', () => {
  it('keeps an absent row, an explicit null, false and 0 distinct, without touching the task', async () => {
    const h = harness();
    const done = await h.createField({ name: 'Done', type: 'boolean' });
    const score = await h.createField({ name: 'Score', type: 'number' });
    expect(await h.app.listTaskValues(h.ctx(users.viewer), tasks.a)).toEqual([]);

    const cleared = await h.setValue(tasks.a, done.id, { type: 'boolean', value: null }, 0);
    expect(cleared).toMatchObject({ revision: 1, value: { type: 'boolean', value: null }, definitionVersionId: done.definitionVersionId });
    const no = await h.setValue(tasks.a, done.id, { type: 'boolean', value: false }, 1);
    expect(no).toMatchObject({ revision: 2, value: { type: 'boolean', value: false } });
    const zero = await h.setValue(tasks.a, score.id, { type: 'number', value: 0 }, 0);
    expect(zero).toMatchObject({ revision: 1, value: { type: 'number', value: 0 } });

    expect(h.db.state.tasks.get(tasks.a)?.revision).toBe(1);
    expect(h.events.filter((item) => item.event.entityType === 'task').length).toBe(0);
  });

  it('applies independent guards, rejects type mismatches and treats an identical value as a cached no-op', async () => {
    const h = harness();
    const notes = await h.createField({ name: 'Notes', type: 'text' });
    await h.setValue(tasks.a, notes.id, { type: 'text', value: 'draft' }, 0);
    const events = h.events.length;
    const historyRows = h.db.state.history.length;
    const keysBefore = h.db.state.idempotency.size;

    const same = await h.setValue(tasks.a, notes.id, { type: 'text', value: 'draft' }, 1);
    expect(same.revision).toBe(1);
    expect(h.events.length).toBe(events);
    expect(h.db.state.history.length).toBe(historyRows);
    expect(h.db.state.idempotency.size).toBe(keysBefore + 1);

    expect((await errorOf(h.setValue(tasks.a, notes.id, { type: 'text', value: 'x' }, 0))).code).toBe('REVISION_CONFLICT');
    const staleDefinition = await errorOf(h.setValue(tasks.a, notes.id, { type: 'text', value: 'x' }, 1, 2));
    expect(staleDefinition.details).toMatchObject({ fields: ['expectedDefinitionRevision'] });
    expect((await errorOf(h.setValue(tasks.a, notes.id, { type: 'number', value: 1 }, 1))).code).toBe('DOMAIN_VALIDATION_FAILED');
    const wrongShape = { expectedRevision: 1, expectedDefinitionRevision: 1, value: { type: 'text', value: 5 } };
    const invalid = h.app.setTaskValue(h.owner(), tasks.a, notes.id, wrongShape as unknown as SetTaskFieldValueInput);
    expect((await errorOf(invalid)).code).toBe('VALIDATION_FAILED');
    expect((await errorOf(h.setValue(tasks.archived, notes.id, { type: 'text', value: 'x' }, 0))).code).toBe(
      'DOMAIN_VALIDATION_FAILED',
    );
    expect((await errorOf(h.setValue(tasks.inQ, notes.id, { type: 'text', value: 'x' }, 0))).code).toBe('DOMAIN_VALIDATION_FAILED');

    // The same key for another task is a different request.
    const reused = h.key();
    await h.setValue(tasks.a, notes.id, { type: 'text', value: 'final' }, 1, 1, h.ctx(users.owner, reused));
    const otherTask = h.setValue(tasks.b, notes.id, { type: 'text', value: 'final' }, 1, 1, h.ctx(users.owner, reused));
    expect((await errorOf(otherTask)).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('keeps audit and outbox metadata-only and writes history only while enabled', async () => {
    const h = harness();
    const notes = await h.createField({ name: 'Notes', type: 'text' });
    await h.setValue(tasks.a, notes.id, { type: 'text', value: 'secret plan' }, 0);

    const valueEvent = h.events.at(-1)?.event;
    expect(valueEvent?.entityType).toBe('task_field_value');
    expect(Object.keys(valueEvent?.diff ?? {}).sort()).toEqual(['definitionRevision', 'fieldId', 'taskId', 'type', 'valueRevision']);
    const [first] = h.db.state.history;
    expect(first).toMatchObject({
      before: null,
      after: { type: 'text', value: 'secret plan' },
      actor: { id: users.owner, displayName: 'Olivia Owner' },
      source: 'web',
      changeSeq: String(h.events.at(-1)?.changeSeq),
      eventOrdinal: 1,
    });

    const off = await h.app.updateField(h.owner(), notes.id, { expectedRevision: 1, historyEnabled: false });
    await h.setValue(tasks.a, notes.id, { type: 'text', value: 'second secret' }, 1, off.revision);
    expect(h.db.state.history).toHaveLength(1);
    expect(h.events.at(-1)?.event.entityType).toBe('task_field_value');

    const on = await h.app.updateField(h.owner(), notes.id, { expectedRevision: off.revision, historyEnabled: true });
    expect(h.db.state.history).toHaveLength(1);
    await h.setValue(tasks.a, notes.id, { type: 'text', value: null }, 2, on.revision);
    expect(h.db.state.history.at(-1)).toMatchObject({
      before: { type: 'text', value: 'second secret' },
      after: { type: 'text', value: null },
      valueRevision: 3,
    });

    const published = JSON.stringify(h.events.map((item) => item.event), (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(published).not.toContain('secret');
  });

  it('retains archived options already on a value but never assigns them anew', async () => {
    const h = harness();
    const stage = await h.createField({
      name: 'Stage',
      type: 'multi_select',
      options: [
        { name: 'Old', color: null },
        { name: 'New', color: null },
      ],
    });
    const other = await h.createField({ name: 'Other', type: 'single_select', options: [{ name: 'X', color: null }] });
    const [oldId, newId] = [optionId(stage, 'Old'), optionId(stage, 'New')];
    h.db.state.options.set(uuid(777), {
      id: uuid(777),
      workspaceId: OTHER_WS,
      projectId: uuid(778),
      fieldId: uuid(779),
      name: 'Foreign',
      color: null,
      position: 0,
      revision: 1,
      archivedAt: null,
    });

    await h.setValue(tasks.a, stage.id, { type: 'multi_select', value: [oldId] }, 0);
    const archived = await h.app.updateOption(h.owner(), stage.id, oldId, { expectedRevision: 1, archived: true });
    const rev = archived.revision;

    const kept = await h.setValue(tasks.a, stage.id, { type: 'multi_select', value: [newId, oldId] }, 1, rev);
    expect(kept.value).toEqual({ type: 'multi_select', value: [oldId, newId].sort() });
    expect((await errorOf(h.setValue(tasks.b, stage.id, { type: 'multi_select', value: [oldId] }, 0, rev))).code).toBe(
      'DOMAIN_VALIDATION_FAILED',
    );
    const otherField = h.setValue(tasks.b, stage.id, { type: 'multi_select', value: [optionId(other, 'X')] }, 0, rev);
    expect((await errorOf(otherField)).code).toBe('DOMAIN_VALIDATION_FAILED');
    expect((await errorOf(h.setValue(tasks.b, stage.id, { type: 'multi_select', value: [uuid(777)] }, 0, rev))).code).toBe(
      'NOT_FOUND',
    );
    expect((await errorOf(h.setValue(tasks.b, stage.id, { type: 'multi_select', value: [uuid(998)] }, 0, rev))).code).toBe(
      'NOT_FOUND',
    );

    // Removing and re-adding the archived option is a new assignment.
    await h.setValue(tasks.a, stage.id, { type: 'multi_select', value: [newId] }, 2, rev);
    const readd = h.setValue(tasks.a, stage.id, { type: 'multi_select', value: [newId, oldId] }, 3, rev);
    expect((await errorOf(readd)).code).toBe('DOMAIN_VALIDATION_FAILED');
  });

  it('keeps revoked people already on a value but rejects them as new references', async () => {
    const h = harness();
    const reviewers = await h.createField({ name: 'Reviewers', type: 'person' });
    await h.setValue(tasks.a, reviewers.id, { type: 'person', value: [members.colleague] }, 0);
    h.setMembership(members.colleague, { state: 'revoked' });

    const kept = await h.setValue(tasks.a, reviewers.id, { type: 'person', value: [members.colleague, members.owner] }, 1);
    expect(kept.revision).toBe(2);
    expect((await errorOf(h.setValue(tasks.b, reviewers.id, { type: 'person', value: [members.colleague] }, 0))).code).toBe(
      'NOT_FOUND',
    );
  });
});

describe('field locks', () => {
  it('blocks every new value command, replays prior results after a current capability check, and unlocks', async () => {
    const h = harness();
    const notes = await h.createField({ name: 'Notes', type: 'text' });
    const ownerKey = h.key();
    const memberKey = h.key();
    const first = await h.setValue(tasks.a, notes.id, { type: 'text', value: 'v1' }, 0, 1, h.ctx(users.owner, ownerKey));
    await h.setValue(tasks.b, notes.id, { type: 'text', value: 'm1' }, 0, 1, h.ctx(users.member, memberKey));
    const locked = await h.app.updateField(h.owner(), notes.id, { expectedRevision: 1, locked: true });

    const replay = await h.setValue(tasks.a, notes.id, { type: 'text', value: 'v1' }, 0, 1, h.ctx(users.owner, ownerKey));
    expect(replay).toEqual(first);

    for (const source of ['web', 'mcp', 'import'] as const) {
      const identical = h.setValue(tasks.a, notes.id, { type: 'text', value: 'v1' }, 1, locked.revision, h.ctx(users.owner, h.key(), source));
      expect((await errorOf(identical)).code).toBe('FIELD_LOCKED');
    }

    h.setMembership(members.member, { role: 'viewer' });
    const demotedReplay = h.setValue(tasks.b, notes.id, { type: 'text', value: 'm1' }, 0, 1, h.ctx(users.member, memberKey));
    expect((await errorOf(demotedReplay)).code).toBe('CAPABILITY_REQUIRED');
    const memberUnlock = h.app.updateField(h.ctx(users.colleague, h.key()), notes.id, { expectedRevision: 2, locked: false });
    expect((await errorOf(memberUnlock)).code).toBe('CAPABILITY_REQUIRED');

    const unlocked = await h.app.updateField(h.owner(), notes.id, { expectedRevision: 2, locked: false });
    expect((await h.setValue(tasks.a, notes.id, { type: 'text', value: 'v2' }, 1, unlocked.revision)).revision).toBe(2);
  });
});

describe('project columns', () => {
  it('guards the full set and revision, keeps hidden columns in order and reconciles archive and restore', async () => {
    const h = harness();
    const [one, two, three] = [
      await h.createField({ name: 'One', type: 'text' }),
      await h.createField({ name: 'Two', type: 'text' }),
      await h.createField({ name: 'Three', type: 'text' }),
    ];
    const foreign = await h.createField({ name: 'Foreign', type: 'text', projectId: Q });
    const column = (fieldId: string, position: number, visible = true, width = 160) => ({ fieldId, visible, width, position });
    const update = (expectedRevision: number, columns: ReturnType<typeof column>[], context = h.owner()) =>
      h.app.updateProjectColumns(context, P, { expectedRevision, columns });

    expect((await errorOf(update(3, [column(one.id, 0), column(two.id, 1), column(three.id, 2)]))).code).toBe('REVISION_CONFLICT');
    expect((await errorOf(update(4, [column(one.id, 0), column(two.id, 1)]))).code).toBe('DOMAIN_VALIDATION_FAILED');
    const withForeign = [column(one.id, 0), column(two.id, 1), column(three.id, 2), column(foreign.id, 3)];
    expect((await errorOf(update(4, withForeign))).code).toBe('DOMAIN_VALIDATION_FAILED');
    expect((await errorOf(update(4, [column(one.id, 0), column(two.id, 1), column(uuid(999), 2)]))).code).toBe('NOT_FOUND');
    const byMember = update(4, [column(one.id, 0), column(two.id, 1), column(three.id, 2)], h.ctx(users.member, h.key()));
    expect((await errorOf(byMember)).code).toBe('CAPABILITY_REQUIRED');

    const reordered = await update(4, [column(three.id, 10, false, 240), column(one.id, 20), column(two.id, 30)]);
    expect(reordered).toEqual({
      workspaceId: WS,
      projectId: P,
      revision: 5,
      columns: [column(three.id, 0, false, 240), column(one.id, 1), column(two.id, 2)],
    });
    const events = h.events.length;
    expect((await update(5, [column(three.id, 0, false, 240), column(one.id, 1), column(two.id, 2)])).revision).toBe(5);
    expect(h.events.length).toBe(events);

    await h.app.updateField(h.owner(), one.id, { expectedRevision: 1, archived: true });
    expect((await h.app.getProjectColumns(h.ctx(users.viewer), P)).columns).toEqual([
      column(three.id, 0, false, 240),
      column(two.id, 1),
    ]);
    await h.app.updateField(h.owner(), one.id, { expectedRevision: 2, archived: false });
    const restored = await h.app.getProjectColumns(h.ctx(users.viewer), P);
    expect(restored.revision).toBe(7);
    expect(restored.columns).toEqual([column(three.id, 0, false, 240), column(two.id, 1), column(one.id, 2)]);
  });
});

describe('value history', () => {
  it('keeps the definition snapshot of each entry and pages with bound cursors', async () => {
    const h = harness();
    const stage = await h.createField({
      name: 'Stage',
      type: 'single_select',
      options: [
        { name: 'Draft', color: '#112233' },
        { name: 'Final', color: null },
      ],
    });
    const [draft, final] = [optionId(stage, 'Draft'), optionId(stage, 'Final')];
    await h.setValue(tasks.a, stage.id, { type: 'single_select', value: draft }, 0);
    const renamed = await h.app.updateOption(h.owner(), stage.id, draft, { expectedRevision: 1, name: 'Sketch', color: null });
    await h.setValue(tasks.a, stage.id, { type: 'single_select', value: final }, 1, renamed.revision);
    await h.setValue(tasks.a, stage.id, { type: 'single_select', value: draft }, 2, renamed.revision);

    const read = (limit: number, cursor?: string, userId = users.viewer, fieldId = stage.id) =>
      h.app.listValueHistory(h.ctx(userId), tasks.a, fieldId, cursor === undefined ? { limit } : { limit, cursor });
    const page = await read(2);
    expect(page.items.map((item) => item.valueRevision)).toEqual([3, 2]);
    expect(page.nextCursor).not.toBeNull();
    const cursor = page.nextCursor ?? '';
    const rest = await read(2, cursor);
    expect(rest.nextCursor).toBeNull();
    const [oldest] = rest.items;
    expect(oldest?.valueRevision).toBe(1);
    expect(oldest?.definition.options.find((option) => option.id === draft)).toMatchObject({ name: 'Draft', color: '#112233' });
    expect(page.items[0]?.definition.options.find((option) => option.id === draft)?.name).toBe('Sketch');

    const otherField = await h.createField({ name: 'Notes', type: 'text' });
    expect((await errorOf(read(2, cursor, users.owner))).code).toBe('VALIDATION_FAILED');
    expect((await errorOf(read(2, cursor, users.viewer, otherField.id))).code).toBe('VALIDATION_FAILED');
    expect((await errorOf(read(2, 'not-a-cursor'))).code).toBe('VALIDATION_FAILED');
    h.db.epoch = 'epoch-2';
    expect((await errorOf(read(2, cursor))).code).toBe('VALIDATION_FAILED');
  });
});

describe('batch reads', () => {
  it('requires every requested task to exist in the project before returning values', async () => {
    const h = harness();
    const notes = await h.createField({ name: 'Notes', type: 'text' });
    await h.setValue(tasks.a, notes.id, { type: 'text', value: 'a' }, 0);
    const read = (taskIds: string[]) => h.app.listProjectValues(h.ctx(users.viewer), P, { taskIds });

    expect((await read([tasks.a, tasks.b])).map((row) => row.taskId)).toEqual([tasks.a]);
    expect((await errorOf(read([tasks.a, tasks.inQ]))).code).toBe('DOMAIN_VALIDATION_FAILED');
    expect((await errorOf(read([tasks.a, uuid(998)]))).code).toBe('NOT_FOUND');
    expect((await errorOf(read([]))).code).toBe('VALIDATION_FAILED');
  });
});
