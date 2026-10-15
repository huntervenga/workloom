// Black-box acceptance for P1b custom task fields, shared project columns, typed values and value
// history: the real API source entrypoint on a real PostgreSQL throwaway database, migrated and
// seeded by the actual @workloom/db CLIs. Actors come only from DEV_ACTOR_ID per API process (owner,
// a second owner process, member A, viewer, outsider) and, for the cursor actor binding, from a dev
// session cookie on the owner process so both actors share one signing secret. Every scenario
// creates its own project. Database evidence is counts and whole-row digests of every public base
// table plus workspaces.change_seq, so no P1b table or column name is assumed; only P0 memberships
// columns are named, to revoke and exactly restore fixture memberships.
import { randomUUID } from 'node:crypto';

import {
  errorResponseSchema,
  taskFieldTypeSchema,
  taskFieldValueResponseSchema,
  type CreateTaskInput,
  type ProjectDto,
  type SetTaskFieldValueInput,
  type TaskDto,
  type TaskFieldData,
  type TaskFieldDefinitionDto,
  type TaskFieldOptionDto,
  type TaskFieldType,
  type TaskFieldValueDto,
  type TaskFieldValueHistoryDto,
  type TaskStatusDto,
} from '@workloom/contracts';
import { DEMO_WORKSPACES, FIXTURE_MEMBERSHIP_IDS, FIXTURE_USER_IDS, FIXTURE_WORKSPACE_IDS } from '@workloom/db/fixtures';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApi, type ApiProcess } from './support/api-process.js';
import { migrateAndSeed } from './support/db-cli.js';
import type { RawResponse } from './support/http.js';
import { P1A_TABLES, expectEnvelope, expectError, statusInGroup, uniqueName } from './support/p1a.js';
import {
  P1bClient,
  changedTables,
  databaseSnapshot,
  devSessionCookie,
  expectRejections,
  genericEventRows,
  membershipRow,
  restoreMembership,
  revokeMembership,
  rowDelta,
  type CreateFieldRequest,
  type DatabaseSnapshot,
} from './support/p1b.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

// Fails the file at collection time when TEST_DATABASE_URL is missing or unsafe.
requireTestDatabaseUrl();

const TEAM_ID = FIXTURE_WORKSPACE_IDS.team;
const OUTSIDE_ID = FIXTURE_WORKSPACE_IDS.outside;
const M = FIXTURE_MEMBERSHIP_IDS;
const U = FIXTURE_USER_IDS;

const FIELD_TYPES: readonly TaskFieldType[] = taskFieldTypeSchema.options;
const SELECT_TYPES: readonly TaskFieldType[] = ['single_select', 'multi_select'];

function workspaceName(id: string): string {
  const workspace = DEMO_WORKSPACES.find((candidate) => candidate.id === id);
  if (!workspace) throw new Error('Demo workspace fixture missing from @workloom/db/fixtures.');
  return workspace.name;
}

function byPosition<T extends { position: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position);
}

function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

function sortedIds(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id).sort();
}

function byTaskField(rows: readonly TaskFieldValueDto[]): TaskFieldValueDto[] {
  return [...rows].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.fieldId.localeCompare(b.fieldId));
}

function optionNamed(field: TaskFieldDefinitionDto, name: string): TaskFieldOptionDto {
  const option = field.options.find((candidate) => candidate.name === name);
  if (!option) throw new Error(`Field ${field.id} has no option named "${name}".`);
  return option;
}

function optionById(field: TaskFieldDefinitionDto, id: string): TaskFieldOptionDto {
  const option = field.options.find((candidate) => candidate.id === id);
  if (!option) throw new Error(`Field ${field.id} has no option ${id}.`);
  return option;
}

function text(value: string | null): TaskFieldData {
  return { type: 'text', value };
}

function valueInput(field: TaskFieldDefinitionDto, value: TaskFieldData, expectedRevision: number): SetTaskFieldValueInput {
  return { expectedRevision, expectedDefinitionRevision: field.revision, value };
}

/** The stored form: multi-select and person IDs are a sorted set. */
function canonical(data: TaskFieldData): TaskFieldData {
  if (data.type === 'multi_select' && data.value !== null) return { type: 'multi_select', value: [...data.value].sort() };
  if (data.type === 'person' && data.value !== null) return { type: 'person', value: [...data.value].sort() };
  return data;
}

function nullValue(type: TaskFieldType): TaskFieldData {
  switch (type) {
    case 'text':
      return { type, value: null };
    case 'number':
      return { type, value: null };
    case 'duration':
      return { type, value: null };
    case 'date':
      return { type, value: null };
    case 'single_select':
      return { type, value: null };
    case 'multi_select':
      return { type, value: null };
    case 'person':
      return { type, value: null };
    case 'boolean':
      return { type, value: null };
    case 'url':
      return { type, value: null };
  }
}

/** `''`, `0`, `false` and `[]` where the type has one; date, single select and URL have none. */
function zeroLikeValue(type: TaskFieldType): TaskFieldData | null {
  switch (type) {
    case 'text':
      return { type, value: '' };
    case 'number':
      return { type, value: 0 };
    case 'duration':
      return { type, value: 0 };
    case 'multi_select':
      return { type, value: [] };
    case 'person':
      return { type, value: [] };
    case 'boolean':
      return { type, value: false };
    default:
      return null;
  }
}

/** A non-empty value per type; arrays deliberately unsorted, text with surrounding whitespace. */
function sampleValue(field: TaskFieldDefinitionDto): TaskFieldData {
  const [first, second] = byPosition(field.options);
  switch (field.type) {
    case 'text':
      return { type: 'text', value: '  Synthetic text, kept verbatim\n' };
    case 'number':
      return { type: 'number', value: -1234.5 };
    case 'duration':
      return { type: 'duration', value: 135 };
    case 'date':
      return { type: 'date', value: '2026-02-28' };
    case 'single_select':
      if (!second) throw new Error('Select fixture needs two options.');
      return { type: 'single_select', value: second.id };
    case 'multi_select':
      if (!first || !second) throw new Error('Select fixture needs two options.');
      return { type: 'multi_select', value: [second.id, first.id].sort().reverse() };
    case 'person':
      // memberB is never a task participant here: person values are independent of participants.
      return { type: 'person', value: [M.teamOwner, M.teamMemberB].sort().reverse() };
    case 'boolean':
      return { type: 'boolean', value: true };
    case 'url':
      return { type: 'url', value: 'https://example.test/synthetic/path?q=1#part' };
  }
}

function changes(history: readonly TaskFieldValueHistoryDto[]): unknown[] {
  return history.map((entry) => ({ valueRevision: entry.valueRevision, before: entry.before, after: entry.after }));
}

function tamper(cursor: string): string {
  const index = Math.floor(cursor.length / 2);
  return `${cursor.slice(0, index)}${cursor[index] === 'A' ? 'B' : 'A'}${cursor.slice(index + 1)}`;
}

interface ProjectFixture {
  readonly project: ProjectDto;
  readonly todo: TaskStatusDto;
}

interface ForeignFixture {
  readonly project: ProjectDto;
  readonly field: TaskFieldDefinitionDto;
  readonly option: TaskFieldOptionDto;
  readonly task: TaskDto;
  /** Labels only the outsider chose; none may appear in a team-side response. */
  readonly hidden: string[];
}

describe('P1b custom fields over HTTP on PostgreSQL', () => {
  let db: ThrowawayDatabase | undefined;
  const apis: ApiProcess[] = [];
  let owner: P1bClient;
  let replica: P1bClient;
  let member: P1bClient;
  let viewer: P1bClient;
  let outsider: P1bClient;

  function sql(): postgres.Sql {
    if (!db) throw new Error('Throwaway database was not created.');
    return db.sql;
  }

  function snapshot(): Promise<DatabaseSnapshot> {
    return databaseSnapshot(sql());
  }

  async function start(actorId: string): Promise<ApiProcess> {
    if (!db) throw new Error('Throwaway database was not created.');
    const api = await startApi({ entry: 'source', databaseUrl: db.url, env: { DEV_ACTOR_ID: actorId } });
    apis.push(api);
    return api;
  }

  async function freshProject(client: P1bClient, label: string): Promise<ProjectFixture> {
    const project = await client.tasks.createProject(uniqueName(label));
    return { project, todo: statusInGroup(await client.tasks.listStatuses(project.id), 'todo') };
  }

  function newTask(client: P1bClient, fixture: ProjectFixture, overrides: Partial<CreateTaskInput> = {}): Promise<TaskDto> {
    return client.tasks.createTask({ projectId: fixture.project.id, statusId: fixture.todo.id, title: uniqueName('Task'), ...overrides });
  }

  function newField(
    client: P1bClient,
    projectId: string,
    type: TaskFieldType,
    extra: Partial<Omit<CreateFieldRequest, 'projectId' | 'type'>> = {},
  ): Promise<TaskFieldDefinitionDto> {
    return client.createField({ projectId, name: uniqueName(`Field ${type}`), type, ...extra });
  }

  /** One field per type, in contract order; select fields get two options. */
  async function allTypeFields(projectId: string): Promise<TaskFieldDefinitionDto[]> {
    const fields: TaskFieldDefinitionDto[] = [];
    for (const type of FIELD_TYPES) {
      const options = SELECT_TYPES.includes(type) ? [{ name: 'Option one', color: '#AABBCC' }, { name: 'Option two' }] : [];
      fields.push(await newField(owner, projectId, type, { options }));
    }
    return fields;
  }

  async function foreignSelect(): Promise<ForeignFixture> {
    const fixture = await freshProject(outsider, 'Outside secret project');
    const field = await newField(outsider, fixture.project.id, 'single_select', {
      name: uniqueName('Outside secret field'),
      options: [{ name: uniqueName('Outside secret option') }],
    });
    const [option] = field.options;
    if (!option) throw new Error('Outside select field was created without its option.');
    const task = await newTask(outsider, fixture, { title: uniqueName('Outside secret task') });
    await outsider.setValue(task.id, field.id, valueInput(field, { type: 'single_select', value: option.id }, 0));
    return {
      project: fixture.project,
      field,
      option,
      task,
      hidden: [workspaceName(OUTSIDE_ID), fixture.project.name, field.name, option.name, task.title],
    };
  }

  beforeAll(async () => {
    db = await createThrowawayDatabase('p1b');
    await migrateAndSeed(db.url);
    // Started together; allSettled so every process that did start is registered for afterAll.
    const started = await Promise.allSettled([U.owner, U.owner, U.memberA, U.viewer, U.outsider].map((id) => start(id)));
    for (const result of started) if (result.status === 'rejected') throw result.reason;
    const [ownerApi, replicaApi, memberApi, viewerApi, outsiderApi] = started.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (!ownerApi || !replicaApi || !memberApi || !viewerApi || !outsiderApi) throw new Error('API processes did not start.');
    owner = new P1bClient(ownerApi, TEAM_ID);
    // Same actor, separate process and connection pool: reads prove PostgreSQL state, writes race for real.
    replica = new P1bClient(replicaApi, TEAM_ID);
    member = new P1bClient(memberApi, TEAM_ID);
    viewer = new P1bClient(viewerApi, TEAM_ID);
    outsider = new P1bClient(outsiderApi, OUTSIDE_ID);
  });

  afterAll(async () => {
    // Stop every API before dropping its database.
    await Promise.all(apis.map((api) => api.stop()));
    await db?.drop();
  });

  describe('typed values', () => {
    it('round-trips all nine types on fresh fields, persisted and independent of the task', async () => {
      expect(FIELD_TYPES).toHaveLength(9);
      const fixture = await freshProject(owner, 'Typed values project');
      const projectId = fixture.project.id;
      // Shared column settings exist at revision 1 before any field.
      let columns = await owner.getColumns(projectId);
      expect(columns).toEqual({ workspaceId: TEAM_ID, projectId, revision: 1, columns: [] });

      const fields: TaskFieldDefinitionDto[] = [];
      for (const type of FIELD_TYPES) {
        const select = SELECT_TYPES.includes(type);
        const options = select ? [{ name: 'Option one', color: '#AABBCC' }, { name: 'Option two' }] : [];
        const field = await newField(owner, projectId, type, { options });
        expect(field).toMatchObject({ workspaceId: TEAM_ID, projectId, type, historyEnabled: true, locked: false, archivedAt: null });
        if (select) {
          expect(byPosition(field.options).map((option) => [option.name, option.color, option.archivedAt])).toEqual([
            ['Option one', '#aabbcc', null],
            ['Option two', null, null],
          ]);
        } else {
          expect(field.options).toEqual([]);
        }
        // Creating a field appends its column and bumps the shared settings revision.
        const next = await owner.getColumns(projectId);
        expect(next.revision).toBeGreaterThan(columns.revision);
        expect(byPosition(next.columns).map((column) => column.fieldId)).toEqual([
          ...byPosition(columns.columns).map((column) => column.fieldId),
          field.id,
        ]);
        columns = next;
        fields.push(field);
      }
      expect(byId(await replica.listFields(projectId))).toEqual(byId(fields));

      const task = await newTask(owner, fixture, { estimateMinutes: 90, participantMembershipIds: [M.teamOwner, M.teamMemberA] });
      const untouched = await newTask(owner, fixture);

      const written: TaskFieldValueDto[] = [];
      for (const field of fields) {
        const data = sampleValue(field);
        const row = await owner.setValue(task.id, field.id, valueInput(field, data, 0));
        expect(row).toMatchObject({
          workspaceId: TEAM_ID,
          projectId,
          taskId: task.id,
          fieldId: field.id,
          definitionVersionId: field.definitionVersionId,
          revision: 1,
        });
        expect(row.value, field.type).toEqual(canonical(data));
        written.push(row);
      }

      // A second process reads the rows from PostgreSQL; the untouched task has none.
      expect(byTaskField(await replica.listTaskValues(task.id))).toEqual(byTaskField(written));
      expect(byTaskField(await replica.listProjectValues(projectId, [untouched.id, task.id]))).toEqual(byTaskField(written));
      expect(await replica.listTaskValues(untouched.id)).toEqual([]);
      // Task revision, work package and participants are untouched by values.
      expect(await replica.tasks.getTask(task.id)).toEqual(task);

      // Clearing stores a typed null under the next revision; the row remains.
      const cleared: TaskFieldValueDto[] = [];
      for (const field of fields) {
        const row = await owner.setValue(task.id, field.id, valueInput(field, nullValue(field.type), 1));
        expect(row).toMatchObject({ fieldId: field.id, revision: 2, value: { type: field.type, value: null } });
        cleared.push(row);
      }
      expect(byTaskField(await replica.listTaskValues(task.id))).toEqual(byTaskField(cleared));

      for (const field of fields) {
        const history = await replica.allHistory(task.id, field.id);
        expect(changes(history), field.type).toEqual([
          { valueRevision: 2, before: canonical(sampleValue(field)), after: nullValue(field.type) },
          { valueRevision: 1, before: null, after: canonical(sampleValue(field)) },
        ]);
        for (const entry of history) {
          expect(entry).toMatchObject({ workspaceId: TEAM_ID, projectId, taskId: task.id, fieldId: field.id, actor: { id: U.owner } });
          expect(entry.definition).toMatchObject({ id: field.id, type: field.type });
        }
      }
      expect(await replica.tasks.getTask(task.id)).toEqual(task);
    });

    it('keeps an explicit null, zero-like values and an absent row distinct', async () => {
      const fixture = await freshProject(owner, 'Null project');
      const projectId = fixture.project.id;
      const fields = await allTypeFields(projectId);
      const nullTask = await newTask(owner, fixture, { title: uniqueName('Null task') });
      const zeroTask = await newTask(owner, fixture, { title: uniqueName('Zero task') });
      const absentTask = await newTask(owner, fixture, { title: uniqueName('Absent task') });

      // expectedRevision 0 creates a row at revision 1 even for a typed null.
      const nulls: TaskFieldValueDto[] = [];
      const zeros: TaskFieldValueDto[] = [];
      for (const field of fields) {
        const cleared = await owner.setValue(nullTask.id, field.id, valueInput(field, nullValue(field.type), 0));
        expect(cleared).toMatchObject({ revision: 1, value: nullValue(field.type) });
        nulls.push(cleared);
        const zero = zeroLikeValue(field.type);
        if (zero === null) continue;
        const row = await owner.setValue(zeroTask.id, field.id, valueInput(field, zero, 0));
        expect(row.revision).toBe(1);
        expect(row.value, field.type).toStrictEqual(zero);
        zeros.push(row);
      }
      expect(zeros).toHaveLength(6);

      const batch = await replica.listProjectValues(projectId, [nullTask.id, zeroTask.id, absentTask.id]);
      expect(byTaskField(batch)).toEqual(byTaskField([...nulls, ...zeros]));
      expect(batch.filter((row) => row.taskId === absentTask.id)).toEqual([]);

      for (const field of fields) {
        // The initial null is a recorded change from an absent row; an absent row has no history.
        expect(changes(await owner.allHistory(nullTask.id, field.id)), field.type).toEqual([
          { valueRevision: 1, before: null, after: nullValue(field.type) },
        ]);
        expect(await owner.allHistory(absentTask.id, field.id)).toEqual([]);
      }

      // Re-sending the stored null changes nothing: same row, no new history.
      for (const [index, field] of fields.entries()) {
        expect(await owner.setValue(nullTask.id, field.id, valueInput(field, nullValue(field.type), 1))).toEqual(nulls[index]);
        expect(await owner.allHistory(nullTask.id, field.id)).toHaveLength(1);
      }

      // Zero to null is a real change.
      const numberField = fields.find((field) => field.type === 'number');
      if (!numberField) throw new Error('Number field fixture missing.');
      const zeroToNull = await owner.setValue(zeroTask.id, numberField.id, valueInput(numberField, nullValue('number'), 1));
      expect(zeroToNull).toMatchObject({ revision: 2, value: { type: 'number', value: null } });
      expect(changes(await owner.allHistory(zeroTask.id, numberField.id))).toEqual([
        { valueRevision: 2, before: { type: 'number', value: 0 }, after: { type: 'number', value: null } },
        { valueRevision: 1, before: null, after: { type: 'number', value: 0 } },
      ]);
    });

    it('rejects malformed input with 400, type and project mismatches with 422 and missing references with 404', async () => {
      const fixture = await freshProject(owner, 'Validation project');
      const projectId = fixture.project.id;
      const numberField = await newField(owner, projectId, 'number');
      const urlField = await newField(owner, projectId, 'url');
      const select = await newField(owner, projectId, 'single_select', { options: [{ name: 'Own option' }] });
      const otherSelect = await newField(owner, projectId, 'single_select', { options: [{ name: 'Other option' }] });
      const otherOption = optionNamed(otherSelect, 'Other option');
      const task = await newTask(owner, fixture);
      const fields = await owner.listFields(projectId);

      const put = (field: TaskFieldDefinitionDto, value: unknown, extra: Record<string, unknown> = {}) =>
        owner.put(owner.valuePath(task.id, field.id), {
          expectedRevision: 0,
          expectedDefinitionRevision: field.revision,
          value,
          ...extra,
        });
      const validNumber = { type: 'number', value: 12 };

      const before = await snapshot();
      await expectRejections([
        { label: 'number sent as a string', status: 400, code: 'VALIDATION_FAILED', run: () => put(numberField, { type: 'number', value: '12' }) },
        { label: 'number above 1e12', status: 400, code: 'VALIDATION_FAILED', run: () => put(numberField, { type: 'number', value: 1e12 + 1 }) },
        {
          label: 'URL with credentials',
          status: 400,
          code: 'VALIDATION_FAILED',
          run: () => put(urlField, { type: 'url', value: 'https://user:pass@example.test/' }),
        },
        { label: 'unknown body key', status: 400, code: 'VALIDATION_FAILED', run: () => put(numberField, validNumber, { note: 'extra' }) },
        {
          label: 'definition revision 0',
          status: 400,
          code: 'VALIDATION_FAILED',
          run: () => put(numberField, validNumber, { expectedDefinitionRevision: 0 }),
        },
        {
          label: 'missing Idempotency-Key',
          status: 400,
          code: 'VALIDATION_FAILED',
          run: () => owner.put(owner.valuePath(task.id, numberField.id), valueInput(numberField, { type: 'number', value: 12 }, 0), null),
        },
        {
          label: 'non-UUID field path',
          status: 400,
          code: 'VALIDATION_FAILED',
          run: () => owner.put(`/tasks/${task.id}/field-values/not-a-uuid`, valueInput(numberField, { type: 'number', value: 12 }, 0)),
        },
        {
          label: 'text value on a number field',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => put(numberField, { type: 'text', value: '12' }),
        },
        {
          label: 'option of another field in the project',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => put(select, { type: 'single_select', value: otherOption.id }),
        },
        {
          label: 'type change on an empty field',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.patch(`/fields/${numberField.id}`, { expectedRevision: numberField.revision, type: 'text' }),
        },
        {
          label: 'option on a non-select field',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.post(`/fields/${numberField.id}/options`, { expectedRevision: numberField.revision, name: 'Not allowed' }),
        },
        {
          label: 'new text field with options',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.post('/fields', { projectId, name: uniqueName('Field text'), type: 'text', options: [{ name: 'Not allowed' }] }),
        },
        {
          label: 'unknown option',
          status: 404,
          code: 'NOT_FOUND',
          run: () => put(select, { type: 'single_select', value: randomUUID() }),
        },
        {
          label: 'unknown field',
          status: 404,
          code: 'NOT_FOUND',
          run: () => owner.put(`/tasks/${task.id}/field-values/${randomUUID()}`, valueInput(numberField, { type: 'number', value: 12 }, 0)),
        },
        {
          label: 'unknown task',
          status: 404,
          code: 'NOT_FOUND',
          run: () => owner.put(`/tasks/${randomUUID()}/field-values/${numberField.id}`, valueInput(numberField, { type: 'number', value: 12 }, 0)),
        },
      ]);
      expect(await snapshot()).toEqual(before);
      expect(await owner.listFields(projectId)).toEqual(fields);
      expect(await owner.listTaskValues(task.id)).toEqual([]);
    });
  });

  describe('shared columns and archival', () => {
    it('replaces shared columns by stable field IDs and reconciles them on field archive and restore', async () => {
      const fixture = await freshProject(owner, 'Columns project');
      const projectId = fixture.project.id;
      const other = await freshProject(owner, 'Columns other project');
      const a = await newField(owner, projectId, 'text');
      const b = await newField(owner, projectId, 'number');
      const c = await newField(owner, projectId, 'boolean');
      const otherField = await newField(owner, other.project.id, 'text');
      const foreign = await foreignSelect();
      const task = await newTask(owner, fixture);
      const value = await owner.setValue(task.id, b.id, valueInput(b, { type: 'number', value: 42 }, 0));
      const history = await owner.allHistory(task.id, b.id);
      expect(history).toHaveLength(1);

      const initial = await owner.getColumns(projectId);
      expect(byPosition(initial.columns).map((column) => column.fieldId)).toEqual([a.id, b.id, c.id]);
      const layout = [
        { fieldId: c.id, visible: true, width: 200, position: 0 },
        { fieldId: a.id, visible: false, width: 120, position: 1 },
        { fieldId: b.id, visible: true, width: 360, position: 2 },
      ];
      const updated = await owner.updateColumns(projectId, { expectedRevision: initial.revision, columns: layout });
      expect(updated.revision).toBeGreaterThan(initial.revision);
      expect(byPosition(updated.columns)).toEqual(layout);
      expect(await replica.getColumns(projectId)).toEqual(updated);

      const extra = (fieldId: string) => [...layout, { fieldId, visible: true, width: 200, position: 3 }];
      const before = await snapshot();
      await expectRejections([
        {
          label: 'stale settings revision',
          status: 409,
          code: 'REVISION_CONFLICT',
          run: () => owner.patch(`/projects/${projectId}/columns`, { expectedRevision: initial.revision, columns: layout }),
        },
        {
          label: 'member without fields.manage',
          status: 403,
          code: 'CAPABILITY_REQUIRED',
          run: () => member.patch(`/projects/${projectId}/columns`, { expectedRevision: updated.revision, columns: layout }),
        },
        {
          label: 'active field missing',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.patch(`/projects/${projectId}/columns`, { expectedRevision: updated.revision, columns: layout.slice(0, 2) }),
        },
        {
          label: 'field of another project',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.patch(`/projects/${projectId}/columns`, { expectedRevision: updated.revision, columns: extra(otherField.id) }),
        },
        {
          label: 'duplicate positions',
          status: 400,
          code: 'VALIDATION_FAILED',
          run: () =>
            owner.patch(`/projects/${projectId}/columns`, {
              expectedRevision: updated.revision,
              columns: layout.map((column) => ({ ...column, position: 0 })),
            }),
        },
      ]);
      await expectRejections(
        [
          {
            label: 'field of another workspace',
            status: 404,
            code: 'NOT_FOUND',
            run: () => owner.patch(`/projects/${projectId}/columns`, { expectedRevision: updated.revision, columns: extra(foreign.field.id) }),
          },
        ],
        foreign.hidden,
      );
      expect(await snapshot()).toEqual(before);
      expect(await owner.getColumns(projectId)).toEqual(updated);

      const settings = (columns: readonly { fieldId: string; visible: boolean; width: number; position: number }[]) =>
        byPosition(columns).map(({ fieldId, visible, width }) => ({ fieldId, visible, width }));

      const archivedB = await owner.updateField(b.id, { expectedRevision: b.revision, archived: true });
      expect(archivedB).toMatchObject({ id: b.id, name: b.name, type: 'number' });
      expect(archivedB.archivedAt).not.toBeNull();
      const afterArchive = await owner.getColumns(projectId);
      expect(afterArchive.revision).toBeGreaterThan(updated.revision);
      // Archived fields have no column; the others keep visibility, width and order.
      expect(settings(afterArchive.columns)).toEqual([
        { fieldId: c.id, visible: true, width: 200 },
        { fieldId: a.id, visible: false, width: 120 },
      ]);

      const restoredB = await owner.updateField(b.id, { expectedRevision: archivedB.revision, archived: false });
      expect(restoredB).toMatchObject({ id: b.id, name: b.name, type: 'number', archivedAt: null });
      const afterRestore = await owner.getColumns(projectId);
      expect(afterRestore.revision).toBeGreaterThan(afterArchive.revision);
      expect(afterRestore.columns.map((column) => column.fieldId).sort()).toEqual([a.id, b.id, c.id].sort());
      expect(settings(afterRestore.columns).filter((column) => column.fieldId !== b.id)).toEqual([
        { fieldId: c.id, visible: true, width: 200 },
        { fieldId: a.id, visible: false, width: 120 },
      ]);

      // Values and history survived archive and restore unchanged.
      expect(await replica.listTaskValues(task.id)).toEqual([value]);
      expect(await replica.allHistory(task.id, b.id)).toEqual(history);
    });

    it('refuses new value writes, identical no-ops included, while the field, task or project is archived', async () => {
      const fixture = await freshProject(owner, 'Archived target project');
      const projectId = fixture.project.id;
      let field = await newField(owner, projectId, 'text');
      const task = await newTask(owner, fixture);
      const stored = await owner.setValue(task.id, field.id, valueInput(field, text('Stored value'), 0));

      // The contract names no code for archived targets: any client error is accepted, with no write at all.
      async function expectIdenticalWriteRefused(label: string, definitionRevision: number): Promise<void> {
        const before = await snapshot();
        const response = await owner.put(owner.valuePath(task.id, field.id), {
          expectedRevision: stored.revision,
          expectedDefinitionRevision: definitionRevision,
          value: text('Stored value'),
        });
        expect(response.status, `${label}: ${response.text()}`).toBeGreaterThanOrEqual(400);
        expect(response.status, `${label}: ${response.text()}`).toBeLessThan(500);
        errorResponseSchema.parse(response.json());
        expect(await snapshot(), label).toEqual(before);
      }

      const archivedField = await owner.updateField(field.id, { expectedRevision: field.revision, archived: true });
      await expectIdenticalWriteRefused('archived field', archivedField.revision);
      field = await owner.updateField(field.id, { expectedRevision: archivedField.revision, archived: false });

      const archivedTask = await owner.tasks.archiveTask(task.id, task.revision);
      await expectIdenticalWriteRefused('archived task', field.revision);
      await owner.tasks.restoreTask(task.id, archivedTask.revision);

      const archivedProject = await owner.tasks.updateProject(projectId, { expectedRevision: fixture.project.revision, archived: true });
      await expectIdenticalWriteRefused('archived project', field.revision);
      await owner.tasks.updateProject(projectId, { expectedRevision: archivedProject.revision, archived: false });

      // Everything restored: the identical write is a no-op again and a change goes through.
      expect(await owner.setValue(task.id, field.id, valueInput(field, text('Stored value'), 1))).toEqual(stored);
      const changed = await owner.setValue(task.id, field.id, valueInput(field, text('Changed after restore'), 1));
      expect(changed.revision).toBe(2);
      expect(changes(await owner.allHistory(task.id, field.id))).toEqual([
        { valueRevision: 2, before: text('Stored value'), after: text('Changed after restore') },
        { valueRevision: 1, before: null, after: text('Stored value') },
      ]);
    });
  });

  describe('select options and person references', () => {
    it('keeps option IDs stable across rename, reorder and archive, guarded by the whole-field revision', async () => {
      const fixture = await freshProject(owner, 'Options project');
      const projectId = fixture.project.id;
      const single = await newField(owner, projectId, 'single_select', {
        options: [
          { name: 'Red', color: '#CC0000' },
          { name: 'Blue', color: '#0000cc' },
        ],
      });
      const multi = await newField(owner, projectId, 'multi_select', { options: [{ name: 'Alpha' }, { name: 'Beta' }] });
      const red = optionNamed(single, 'Red');
      const blue = optionNamed(single, 'Blue');
      const alpha = optionNamed(multi, 'Alpha');
      const beta = optionNamed(multi, 'Beta');
      const task = await newTask(owner, fixture);
      const other = await newTask(owner, fixture);
      const foreign = await foreignSelect();

      const redValue = await owner.setValue(task.id, single.id, valueInput(single, { type: 'single_select', value: red.id }, 0));
      const [redEntry, ...older] = await owner.allHistory(task.id, single.id);
      if (!redEntry) throw new Error('No history entry for the first select write.');
      expect(older).toEqual([]);
      expect(optionById(redEntry.definition, red.id)).toMatchObject({ name: 'Red', color: '#cc0000' });

      const renamed = await owner.updateOption(single.id, red.id, { expectedRevision: single.revision, name: 'Crimson', color: '#990000' });
      const last = Math.max(...renamed.options.map((option) => option.position));
      const reordered = await owner.updateOption(single.id, red.id, { expectedRevision: renamed.revision, position: last + 1 });
      expect(renamed.revision).toBeGreaterThan(single.revision);
      expect(reordered.revision).toBeGreaterThan(renamed.revision);
      expect(sortedIds(reordered.options)).toEqual(sortedIds(single.options));
      expect(byPosition(reordered.options).map((option) => option.name)).toEqual(['Blue', 'Crimson']);
      expect(optionById(reordered, red.id)).toMatchObject({ name: 'Crimson', color: '#990000', archivedAt: null });
      expect(optionById(reordered, red.id).revision).toBeGreaterThan(red.revision);
      expect(optionById(reordered, blue.id)).toEqual(blue);

      // The value keeps the option ID; the recorded entry keeps the label it was written with.
      expect(await owner.listTaskValues(task.id)).toEqual([redValue]);
      expect(await owner.allHistory(task.id, single.id)).toEqual([redEntry]);

      // Option commands are guarded by the field revision; Blue's own (unchanged) revision is not it.
      expect(blue.revision).not.toBe(reordered.revision);
      let before = await snapshot();
      await expectRejections([
        {
          label: 'option update with the option revision',
          status: 409,
          code: 'REVISION_CONFLICT',
          run: () => owner.patch(`/fields/${single.id}/options/${blue.id}`, { expectedRevision: blue.revision, name: 'Navy' }),
        },
        {
          label: 'option create with a stale field revision',
          status: 409,
          code: 'REVISION_CONFLICT',
          run: () => owner.post(`/fields/${single.id}/options`, { expectedRevision: renamed.revision, name: 'Green' }),
        },
      ]);
      expect(await snapshot()).toEqual(before);

      const withGreen = await owner.createOption(single.id, { expectedRevision: reordered.revision, name: 'Green' });
      expect(withGreen.revision).toBeGreaterThan(reordered.revision);
      expect(withGreen.options).toHaveLength(3);
      expect(sortedIds(withGreen.options.filter((option) => option.name !== 'Green'))).toEqual(sortedIds(single.options));

      // Archived options stay on the values that already hold them.
      const pair = await owner.setValue(task.id, multi.id, valueInput(multi, { type: 'multi_select', value: [beta.id, alpha.id] }, 0));
      const singleArchived = await owner.updateOption(single.id, red.id, { expectedRevision: withGreen.revision, archived: true });
      const multiArchived = await owner.updateOption(multi.id, alpha.id, { expectedRevision: multi.revision, archived: true });
      expect(optionById(singleArchived, red.id)).toMatchObject({ id: red.id, name: 'Crimson' });
      expect(optionById(singleArchived, red.id).archivedAt).not.toBeNull();
      expect(optionById(multiArchived, alpha.id).archivedAt).not.toBeNull();
      expect(byTaskField(await replica.listTaskValues(task.id))).toEqual(byTaskField([redValue, pair]));

      // Dropping Beta while keeping the archived Alpha is allowed; dropping Alpha too is allowed.
      const keptAlpha = await owner.setValue(task.id, multi.id, valueInput(multiArchived, { type: 'multi_select', value: [alpha.id] }, 1));
      expect(keptAlpha).toMatchObject({ revision: 2, value: { type: 'multi_select', value: [alpha.id] } });
      const droppedAlpha = await owner.setValue(task.id, multi.id, valueInput(multiArchived, { type: 'multi_select', value: [] }, 2));
      expect(droppedAlpha.revision).toBe(3);

      before = await snapshot();
      await expectRejections([
        {
          label: 're-add archived Alpha after removing it',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.put(owner.valuePath(task.id, multi.id), valueInput(multiArchived, { type: 'multi_select', value: [alpha.id] }, 3)),
        },
        {
          label: 'archived Crimson on another task',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.put(owner.valuePath(other.id, single.id), valueInput(singleArchived, { type: 'single_select', value: red.id }, 0)),
        },
        {
          label: 'archived Alpha with active Beta on another task',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () =>
            owner.put(owner.valuePath(other.id, multi.id), valueInput(multiArchived, { type: 'multi_select', value: [alpha.id, beta.id] }, 0)),
        },
      ]);
      await expectRejections(
        [
          {
            label: 'option of another workspace',
            status: 404,
            code: 'NOT_FOUND',
            run: () =>
              owner.put(owner.valuePath(other.id, single.id), valueInput(singleArchived, { type: 'single_select', value: foreign.option.id }, 0)),
          },
        ],
        foreign.hidden,
      );
      expect(await snapshot()).toEqual(before);
      expect(byTaskField(await owner.listTaskValues(task.id))).toEqual(byTaskField([redValue, droppedAlpha]));
      expect(await owner.listTaskValues(other.id)).toEqual([]);
    });

    it('keeps a revoked person reference until removed, refuses re-adding or newly assigning it, and never touches participants', async () => {
      const fixture = await freshProject(owner, 'Person project');
      const person = await newField(owner, fixture.project.id, 'person');
      const task = await newTask(owner, fixture, { participantMembershipIds: [M.teamOwner] });
      const other = await newTask(owner, fixture);

      const both = await owner.setValue(task.id, person.id, valueInput(person, { type: 'person', value: [M.teamMemberB, M.teamMemberA] }, 0));
      expect(both.value).toEqual({ type: 'person', value: [M.teamMemberA, M.teamMemberB].sort() });

      const original = await membershipRow(sql(), TEAM_ID, M.teamMemberB);
      expect(original).toMatchObject({ state: 'active', revoked_at: null });
      await revokeMembership(sql(), TEAM_ID, M.teamMemberB);
      try {
        expect((await membershipRow(sql(), TEAM_ID, M.teamMemberB)).state).toBe('revoked');
        expect(await owner.listTaskValues(task.id)).toEqual([both]);

        // Holding the revoked reference is not a new assignment: adding C keeps B.
        const widened = await owner.setValue(
          task.id,
          person.id,
          valueInput(person, { type: 'person', value: [M.teamMemberA, M.teamMemberB, M.teamMemberC] }, 1),
        );
        expect(widened).toMatchObject({ revision: 2, value: { type: 'person', value: [M.teamMemberA, M.teamMemberB, M.teamMemberC].sort() } });
        // Removing never needs an active membership.
        const narrowed = await owner.setValue(task.id, person.id, valueInput(person, { type: 'person', value: [M.teamMemberA, M.teamMemberC] }, 2));
        expect(narrowed).toMatchObject({ revision: 3, value: { type: 'person', value: [M.teamMemberA, M.teamMemberC].sort() } });

        const before = await snapshot();
        await expectRejections([
          {
            label: 're-add the revoked membership',
            status: 404,
            code: 'NOT_FOUND',
            run: () =>
              owner.put(
                owner.valuePath(task.id, person.id),
                valueInput(person, { type: 'person', value: [M.teamMemberA, M.teamMemberB, M.teamMemberC] }, 3),
              ),
          },
          {
            label: 'assign the revoked membership on another task',
            status: 404,
            code: 'NOT_FOUND',
            run: () => owner.put(owner.valuePath(other.id, person.id), valueInput(person, { type: 'person', value: [M.teamMemberB] }, 0)),
          },
        ]);
        expect(await snapshot()).toEqual(before);
        expect(await owner.listTaskValues(task.id)).toEqual([narrowed]);
        expect(await owner.listTaskValues(other.id)).toEqual([]);
      } finally {
        await restoreMembership(sql(), TEAM_ID, M.teamMemberB, original);
      }
      expect(await membershipRow(sql(), TEAM_ID, M.teamMemberB)).toEqual(original);
      // Person values never touched the task, its revision or its participants.
      expect(await owner.tasks.getTask(task.id)).toEqual(task);
    });
  });

  describe('history policy and generic events', () => {
    it('records history only while enabled, never backfills or deletes it, and keeps values out of audit and outbox', async () => {
      const fixture = await freshProject(owner, 'History policy project');
      const field = await newField(owner, fixture.project.id, 'text', { historyEnabled: false });
      expect(field.historyEnabled).toBe(false);
      const task = await newTask(owner, fixture);
      const [oldValue, newValue, thirdValue, fourthValue] = ['old', 'new', 'third', 'fourth'].map(
        (label) => `sentinel-${label}-${randomUUID()}`,
      );
      if (!oldValue || !newValue || !thirdValue || !fourthValue) throw new Error('Sentinels were not generated.');

      const newAuditRows = async (seen: ReadonlySet<string>): Promise<string[]> =>
        (await genericEventRows(sql())).filter((row) => !seen.has(row) && row.startsWith('audit_events '));

      // History off: values change, nothing is recorded.
      let seen = new Set(await genericEventRows(sql()));
      await owner.setValue(task.id, field.id, valueInput(field, text(oldValue), 0));
      await owner.setValue(task.id, field.id, valueInput(field, text(newValue), 1));
      expect(await owner.listTaskValues(task.id)).toMatchObject([{ revision: 2, value: text(newValue) }]);
      expect(await owner.allHistory(task.id, field.id)).toEqual([]);
      // Every value write leaves metadata audit naming the task and field.
      let audit = await newAuditRows(seen);
      expect(audit.length).toBeGreaterThanOrEqual(2);
      for (const row of audit) expect(row).toContain(field.id);
      for (const row of audit) expect(row).toContain(task.id);

      // Turning history on is an audited policy change and does not backfill.
      seen = new Set(await genericEventRows(sql()));
      const enabled = await owner.updateField(field.id, { expectedRevision: field.revision, historyEnabled: true });
      expect(enabled).toMatchObject({ id: field.id, historyEnabled: true });
      audit = await newAuditRows(seen);
      expect(audit.length).toBeGreaterThanOrEqual(1);
      for (const row of audit) expect(row).toContain(field.id);
      expect(await owner.allHistory(task.id, field.id)).toEqual([]);

      seen = new Set(await genericEventRows(sql()));
      const third = await owner.setValue(task.id, field.id, valueInput(enabled, text(thirdValue), 2));
      expect(third).toMatchObject({ revision: 3, definitionVersionId: enabled.definitionVersionId });
      expect((await newAuditRows(seen)).length).toBeGreaterThanOrEqual(1);
      const history = await owner.allHistory(task.id, field.id);
      expect(changes(history)).toEqual([{ valueRevision: 3, before: text(newValue), after: text(thirdValue) }]);
      expect(history[0]?.definition).toMatchObject({
        id: field.id,
        name: field.name,
        type: 'text',
        historyEnabled: true,
        revision: enabled.revision,
        definitionVersionId: enabled.definitionVersionId,
      });

      // Turning it off again keeps the recorded entry and records nothing new.
      const disabled = await owner.updateField(field.id, { expectedRevision: enabled.revision, historyEnabled: false });
      const fourth = await owner.setValue(task.id, field.id, valueInput(disabled, text(fourthValue), 3));
      expect(fourth.revision).toBe(4);
      expect(await owner.allHistory(task.id, field.id)).toEqual(history);
      expect(await replica.listTaskValues(task.id)).toEqual([fourth]);

      // Generic audit and outbox carry metadata only, whether history was on or off.
      const events = (await genericEventRows(sql())).join('\n');
      for (const sentinel of [oldValue, newValue, thirdValue, fourthValue]) expect(events).not.toContain(sentinel);
    });
  });

  describe('idempotency and locks', () => {
    it('stores only the key result for an identical value under a new key and replays exact retries without effect', async () => {
      const fixture = await freshProject(owner, 'Idempotency project');
      const projectId = fixture.project.id;
      const multi = await newField(owner, projectId, 'multi_select', { options: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
      const twin = await newField(owner, projectId, 'multi_select', { options: [{ name: 'A' }] });
      const [a, b, c] = byPosition(multi.options);
      if (!a || !b || !c) throw new Error('Multi-select fixture needs three options.');
      const task = await newTask(owner, fixture);
      const otherTask = await newTask(owner, fixture);

      const key = randomUUID();
      const body = valueInput(multi, { type: 'multi_select', value: [c.id, a.id] }, 0);
      const s0 = await snapshot();
      const first = await owner.setValue(task.id, multi.id, body, key);
      expect(first).toMatchObject({ revision: 1, value: { type: 'multi_select', value: [a.id, c.id].sort() } });
      const s1 = await snapshot();
      const firstChanged = changedTables(s0, s1);
      expect(firstChanged).toEqual(expect.arrayContaining(['audit_events', 'command_idempotency', 'outbox_events', 'workspaces']));
      // No P1a row besides the key result moved: values are independent of the task.
      expect(firstChanged.filter((table) => (P1A_TABLES as readonly string[]).includes(table))).toEqual(['command_idempotency']);
      // At least one P1b table (value, history) took the write.
      const known: readonly string[] = [...P1A_TABLES, 'audit_events', 'outbox_events', 'workspaces'];
      expect(firstChanged.filter((table) => !known.includes(table)).length).toBeGreaterThanOrEqual(1);
      expect(rowDelta(s0, s1).command_idempotency).toBe(1);
      expect(s1.changeSeq[TEAM_ID]).not.toBe(s0.changeSeq[TEAM_ID]);

      // Exact replay: the stored result, nothing else.
      expect(await owner.setValue(task.id, multi.id, body, key)).toEqual(first);
      expect(await snapshot()).toEqual(s1);

      // New key, same set in another order: a no-op that only stores the key result.
      const noOpKey = randomUUID();
      const noOpBody = valueInput(multi, { type: 'multi_select', value: [a.id, c.id] }, 1);
      const noOp = await owner.setValue(task.id, multi.id, noOpBody, noOpKey);
      expect(noOp).toEqual(first);
      const s2 = await snapshot();
      expect(changedTables(s1, s2)).toEqual(['command_idempotency']);
      expect(rowDelta(s1, s2).command_idempotency).toBe(1);
      expect(s2.changeSeq).toEqual(s1.changeSeq);
      expect(await owner.setValue(task.id, multi.id, noOpBody, noOpKey)).toEqual(noOp);
      expect(await snapshot()).toEqual(s2);

      await expectRejections([
        {
          label: 'same key, changed value',
          status: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
          run: () => owner.put(owner.valuePath(task.id, multi.id), { ...body, value: { type: 'multi_select', value: [b.id] } }, key),
        },
        {
          label: 'same key and body, another task',
          status: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
          run: () => owner.put(owner.valuePath(otherTask.id, multi.id), body, key),
        },
        {
          label: 'same key and body, another field',
          status: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
          run: () => owner.put(owner.valuePath(task.id, twin.id), body, key),
        },
      ]);
      expect(await snapshot()).toEqual(s2);
      expect(await owner.listTaskValues(task.id)).toEqual([first]);
      expect(await owner.listTaskValues(otherTask.id)).toEqual([]);
      expect(await owner.allHistory(task.id, multi.id)).toHaveLength(1);
    });

    it('refuses new writes to a locked field with 409 FIELD_LOCKED but replays earlier results after the access check', async () => {
      const fixture = await freshProject(owner, 'Lock project');
      const field = await newField(owner, fixture.project.id, 'text');
      const task = await newTask(owner, fixture, { estimateMinutes: 60 });

      const key = randomUUID();
      const body = valueInput(field, text('Member value'), 0);
      const memberWrite = await member.setValue(task.id, field.id, body, key);
      expect(memberWrite.revision).toBe(1);

      const locked = await owner.updateField(field.id, { expectedRevision: field.revision, locked: true });
      expect(locked).toMatchObject({ id: field.id, locked: true });
      expect(locked.revision).toBeGreaterThan(field.revision);

      const path = owner.valuePath(task.id, field.id);
      let before = await snapshot();
      await expectRejections([
        { label: 'owner change', status: 409, code: 'FIELD_LOCKED', run: () => owner.put(path, valueInput(locked, text('Owner value'), 1)) },
        { label: 'owner identical', status: 409, code: 'FIELD_LOCKED', run: () => owner.put(path, valueInput(locked, text('Member value'), 1)) },
        { label: 'member change', status: 409, code: 'FIELD_LOCKED', run: () => member.put(path, valueInput(locked, text('Other value'), 1)) },
        { label: 'member identical', status: 409, code: 'FIELD_LOCKED', run: () => member.put(path, valueInput(locked, text('Member value'), 1)) },
        { label: 'owner clear', status: 409, code: 'FIELD_LOCKED', run: () => owner.put(path, valueInput(locked, text(null), 1)) },
      ]);
      expect(await snapshot()).toEqual(before);

      // The earlier successful write replays its stored result although the field is locked now.
      expect(await member.setValue(task.id, field.id, body, key)).toEqual(memberWrite);
      // The capability check runs first: a viewer gets no cached result.
      expectError(await viewer.put(path, body, key), 403, 'CAPABILITY_REQUIRED', ['Member value']);
      expect(await snapshot()).toEqual(before);

      const original = await membershipRow(sql(), TEAM_ID, M.teamMemberA);
      await revokeMembership(sql(), TEAM_ID, M.teamMemberA);
      try {
        before = await snapshot();
        expectError(await member.put(path, body, key), 404, 'NOT_FOUND', ['Member value']);
        expect(await snapshot()).toEqual(before);
      } finally {
        await restoreMembership(sql(), TEAM_ID, M.teamMemberA, original);
      }
      expect(await membershipRow(sql(), TEAM_ID, M.teamMemberA)).toEqual(original);
      expect(await member.setValue(task.id, field.id, body, key)).toEqual(memberWrite);

      // The lock covers this custom field only: the title and built-in package estimate still change.
      const current = await owner.tasks.getTask(task.id);
      const edited = await owner.tasks.updateTask(task.id, {
        expectedRevision: current.revision,
        expectedWorkPackageRevision: current.workPackageRevision,
        title: uniqueName('Locked field task'),
        estimateMinutes: 120,
      });
      expect(edited.estimateMinutes).toBe(120);
      expect(edited.title).not.toBe(current.title);
      expect(await owner.listTaskValues(task.id)).toEqual([memberWrite]);

      // Unlocking is a separate fields.manage command.
      expectError(await member.patch(`/fields/${field.id}`, { expectedRevision: locked.revision, locked: false }), 403, 'CAPABILITY_REQUIRED');
      const unlocked = await owner.updateField(field.id, { expectedRevision: locked.revision, locked: false });
      expect(unlocked.locked).toBe(false);
      const after = await member.setValue(task.id, field.id, valueInput(unlocked, text('Member value after unlock'), 1));
      expect(after).toMatchObject({ revision: 2, value: text('Member value after unlock') });
    });
  });

  describe('revision guards', () => {
    it('refuses stale value and definition revisions with 409 and writes nothing', async () => {
      const fixture = await freshProject(owner, 'Stale project');
      const field = await newField(owner, fixture.project.id, 'text');
      const task = await newTask(owner, fixture);
      const stored = await owner.setValue(task.id, field.id, valueInput(field, text('First value'), 0));
      const renamed = await owner.updateField(field.id, { expectedRevision: field.revision, name: uniqueName('Field renamed') });
      expect(renamed.revision).toBeGreaterThan(field.revision);

      const path = owner.valuePath(task.id, field.id);
      const before = await snapshot();
      await expectRejections([
        {
          label: 'create guard on an existing row',
          status: 409,
          code: 'REVISION_CONFLICT',
          run: () => owner.put(path, valueInput(renamed, text('Lost update'), 0)),
        },
        {
          label: 'value revision ahead of the row',
          status: 409,
          code: 'REVISION_CONFLICT',
          run: () => owner.put(path, valueInput(renamed, text('Lost update'), 2)),
        },
        {
          label: 'stale definition revision',
          status: 409,
          code: 'REVISION_CONFLICT',
          run: () => owner.put(path, valueInput(field, text('Lost update'), 1)),
        },
        {
          label: 'stale field revision on rename',
          status: 409,
          code: 'REVISION_CONFLICT',
          run: () => owner.patch(`/fields/${field.id}`, { expectedRevision: field.revision, name: uniqueName('Field lost') }),
        },
      ]);
      expect(await snapshot()).toEqual(before);
      expect(await owner.listTaskValues(task.id)).toEqual([stored]);
      expect(await owner.listFields(fixture.project.id)).toEqual([renamed]);
    });

    it('lets exactly one of two concurrent writes from separate API processes win each value revision', async () => {
      const fixture = await freshProject(owner, 'Concurrency project');
      const field = await newField(owner, fixture.project.id, 'text');
      const task = await newTask(owner, fixture);
      let current = await owner.setValue(task.id, field.id, valueInput(field, text('Base value'), 0));
      const path = owner.valuePath(task.id, field.id);

      for (let round = 1; round <= 3; round += 1) {
        const candidates = [text(`Owner process value ${round}`), text(`Replica process value ${round}`)];
        const responses = await Promise.all([
          owner.put(path, valueInput(field, candidates[0] ?? text(null), current.revision)),
          replica.put(path, valueInput(field, candidates[1] ?? text(null), current.revision)),
        ]);
        expect(responses.map((response) => response.status).sort(), responses.map((r) => r.text()).join('\n')).toEqual([200, 409]);
        const winnerIndex = responses.findIndex((response) => response.status === 200);
        const winnerResponse = responses[winnerIndex];
        const loserResponse = responses[1 - winnerIndex];
        if (!winnerResponse || !loserResponse) throw new Error('Concurrent responses missing.');
        const winner = expectEnvelope(winnerResponse, 200, taskFieldValueResponseSchema).data;
        expectError(loserResponse, 409, 'REVISION_CONFLICT');
        expect(winner).toMatchObject({ revision: current.revision + 1, value: candidates[winnerIndex] });

        // No lost update: both processes read the winner, and exactly one history entry was added.
        expect(await owner.listTaskValues(task.id)).toEqual([winner]);
        expect(await replica.listTaskValues(task.id)).toEqual([winner]);
        const history = await replica.allHistory(task.id, field.id);
        expect(history).toHaveLength(round + 1);
        expect(changes(history.slice(0, 1))).toEqual([{ valueRevision: winner.revision, before: current.value, after: winner.value }]);
        current = winner;
      }
    });
  });

  describe('tenant safety and roles', () => {
    it('answers 404 without foreign labels for other-workspace references and 422 for another project', async () => {
      const foreign = await foreignSelect();
      const a = await freshProject(owner, 'Tenant project A');
      const b = await freshProject(owner, 'Tenant project B');
      const selectA = await newField(owner, a.project.id, 'single_select', { options: [{ name: 'Team option' }] });
      const personA = await newField(owner, a.project.id, 'person');
      const fieldB = await newField(owner, b.project.id, 'text');
      const taskA = await newTask(owner, a);
      const taskB = await newTask(owner, b);
      const foreignValues = await outsider.listTaskValues(foreign.task.id);
      expect(foreignValues).toHaveLength(1);

      const ff = foreign.field;
      const notFound = (label: string, run: () => Promise<RawResponse>) => ({
        label,
        status: 404,
        code: 'NOT_FOUND',
        run,
      });
      const before = await snapshot();
      await expectRejections(
        [
          notFound('list fields of a foreign project', () => owner.get(`/fields?projectId=${foreign.project.id}`)),
          notFound('create a field in a foreign project', () =>
            owner.post('/fields', { projectId: foreign.project.id, name: uniqueName('Field text'), type: 'text' }),
          ),
          notFound('rename a foreign field', () => owner.patch(`/fields/${ff.id}`, { expectedRevision: ff.revision, name: 'Renamed' })),
          notFound('add an option to a foreign field', () =>
            owner.post(`/fields/${ff.id}/options`, { expectedRevision: ff.revision, name: 'Added' }),
          ),
          notFound('rename a foreign option', () =>
            owner.patch(`/fields/${ff.id}/options/${foreign.option.id}`, { expectedRevision: ff.revision, name: 'Renamed' }),
          ),
          notFound('read foreign columns', () => owner.get(`/projects/${foreign.project.id}/columns`)),
          notFound('replace foreign columns', () =>
            owner.patch(`/projects/${foreign.project.id}/columns`, { expectedRevision: 1, columns: [] }),
          ),
          notFound('read foreign task values', () => owner.get(`/tasks/${foreign.task.id}/field-values`)),
          notFound('batch-read a foreign project', () =>
            owner.get(`/projects/${foreign.project.id}/field-values?taskIds=${foreign.task.id}`),
          ),
          notFound('batch-read a foreign task in a team project', () =>
            owner.get(`/projects/${a.project.id}/field-values?taskIds=${taskA.id},${foreign.task.id}`),
          ),
          notFound('write a foreign task value', () =>
            owner.put(owner.valuePath(foreign.task.id, ff.id), valueInput(ff, { type: 'single_select', value: null }, 1)),
          ),
          notFound('write a foreign field on a team task', () =>
            owner.put(owner.valuePath(taskA.id, ff.id), valueInput(ff, { type: 'single_select', value: null }, 0)),
          ),
          notFound('select a foreign option', () =>
            owner.put(owner.valuePath(taskA.id, selectA.id), valueInput(selectA, { type: 'single_select', value: foreign.option.id }, 0)),
          ),
          notFound('assign a foreign membership', () =>
            owner.put(owner.valuePath(taskA.id, personA.id), valueInput(personA, { type: 'person', value: [M.outsideOwner] }, 0)),
          ),
          notFound('read foreign history', () => owner.historyRequest(foreign.task.id, ff.id)),
          notFound('read a foreign field history on a team task', () => owner.historyRequest(taskA.id, ff.id)),
        ],
        foreign.hidden,
      );
      await expectRejections([
        {
          label: 'field of project B on a task of project A',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.put(owner.valuePath(taskA.id, fieldB.id), valueInput(fieldB, text('Wrong project'), 0)),
        },
        {
          label: 'field of project A on a task of project B',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.put(owner.valuePath(taskB.id, selectA.id), valueInput(selectA, { type: 'single_select', value: null }, 0)),
        },
        {
          label: 'batch-read a project B task through project A',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.get(`/projects/${a.project.id}/field-values?taskIds=${taskB.id}`),
        },
        {
          label: 'history of a project B field on a project A task',
          status: 422,
          code: 'DOMAIN_VALIDATION_FAILED',
          run: () => owner.historyRequest(taskA.id, fieldB.id),
        },
      ]);
      expect(await snapshot()).toEqual(before);
      expect(await outsider.listTaskValues(foreign.task.id)).toEqual(foreignValues);
    });

    it('lets a viewer read every field resource but refuses its writes, and keeps fields.manage from members', async () => {
      const fixture = await freshProject(owner, 'Roles project');
      const projectId = fixture.project.id;
      const select = await newField(owner, projectId, 'single_select', { options: [{ name: 'Ready' }] });
      const note = await newField(owner, projectId, 'text');
      const ready = optionNamed(select, 'Ready');
      const task = await newTask(owner, fixture);
      const ownerValue = await owner.setValue(task.id, select.id, valueInput(select, { type: 'single_select', value: ready.id }, 0));
      // task.edit is enough for values: a member writes one.
      const memberValue = await member.setValue(task.id, note.id, valueInput(note, text('Member note'), 0));
      expect(memberValue.revision).toBe(1);

      const columns = await owner.getColumns(projectId);
      const values = byTaskField([ownerValue, memberValue]);
      expect(await viewer.listFields(projectId)).toEqual(await owner.listFields(projectId));
      expect(await viewer.getColumns(projectId)).toEqual(columns);
      expect(byTaskField(await viewer.listTaskValues(task.id))).toEqual(values);
      expect(byTaskField(await viewer.listProjectValues(projectId, [task.id]))).toEqual(values);
      expect(await viewer.allHistory(task.id, note.id)).toEqual(await owner.allHistory(task.id, note.id));

      const denied = (label: string, client: P1bClient, run: (client: P1bClient) => Promise<RawResponse>) => ({
        label,
        status: 403,
        code: 'CAPABILITY_REQUIRED',
        run: () => run(client),
      });
      const manage = [
        ['create a field', (c: P1bClient) => c.post('/fields', { projectId, name: uniqueName('Field text'), type: 'text' })],
        ['rename a field', (c: P1bClient) => c.patch(`/fields/${select.id}`, { expectedRevision: select.revision, name: 'Renamed' })],
        ['lock a field', (c: P1bClient) => c.patch(`/fields/${select.id}`, { expectedRevision: select.revision, locked: true })],
        ['add an option', (c: P1bClient) => c.post(`/fields/${select.id}/options`, { expectedRevision: select.revision, name: 'Added' })],
        [
          'archive an option',
          (c: P1bClient) => c.patch(`/fields/${select.id}/options/${ready.id}`, { expectedRevision: select.revision, archived: true }),
        ],
        [
          'replace columns',
          (c: P1bClient) => c.patch(`/projects/${projectId}/columns`, { expectedRevision: columns.revision, columns: columns.columns }),
        ],
      ] as const;

      const before = await snapshot();
      await expectRejections([
        ...manage.flatMap(([label, run]) => [denied(`member: ${label}`, member, run), denied(`viewer: ${label}`, viewer, run)]),
        denied('viewer: write a value', viewer, (c) => c.put(c.valuePath(task.id, note.id), valueInput(note, text('Viewer note'), 1))),
      ]);
      expect(await snapshot()).toEqual(before);
      expect(await owner.listFields(projectId)).toEqual(await viewer.listFields(projectId));
    });
  });

  describe('history pagination', () => {
    it('pages history with keyset cursors bound to the task, field and actor', async () => {
      const fixture = await freshProject(owner, 'History paging project');
      const field = await newField(owner, fixture.project.id, 'text');
      const sibling = await newField(owner, fixture.project.id, 'text');
      const task = await newTask(owner, fixture);
      const otherTask = await newTask(owner, fixture);
      for (let revision = 1; revision <= 5; revision += 1) {
        await owner.setValue(task.id, field.id, valueInput(field, text(`Paged value ${revision}`), revision - 1));
      }

      const all = await owner.historyPage(task.id, field.id, { limit: 100 });
      expect(all.nextCursor).toBeNull();
      expect(all.items.map((entry) => entry.valueRevision)).toEqual([5, 4, 3, 2, 1]);

      const pages = await owner.historyPages(task.id, field.id, 2);
      expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
      const pagedIds = pages.flat().map((entry) => entry.id);
      expect(new Set(pagedIds).size).toBe(5);
      expect(pages.flat()).toEqual(all.items);

      const first = await owner.historyPage(task.id, field.id, { limit: 2 });
      if (first.nextCursor === null) throw new Error('First history page has no cursor.');
      const cursor = first.nextCursor;

      // Same process, viewer session: the signing secret is shared, so only the actor binding differs.
      const { cookie, me } = await devSessionCookie(owner.api, U.viewer);
      expect(me.actor.id).toBe(U.viewer);
      const viewerOnOwner = new P1bClient(owner.api, TEAM_ID, cookie);
      expect((await viewerOnOwner.historyPage(task.id, field.id, { limit: 2 })).items).toEqual(first.items);

      const before = await snapshot();
      const invalid = (label: string, run: () => Promise<RawResponse>) => ({
        label,
        status: 400,
        code: 'VALIDATION_FAILED',
        run,
      });
      await expectRejections([
        invalid('cursor on another task', () => owner.historyRequest(otherTask.id, field.id, { limit: 2, cursor })),
        invalid('cursor on another field', () => owner.historyRequest(task.id, sibling.id, { limit: 2, cursor })),
        invalid('cursor of another actor', () => viewerOnOwner.historyRequest(task.id, field.id, { limit: 2, cursor })),
        invalid('tampered cursor', () => owner.historyRequest(task.id, field.id, { limit: 2, cursor: tamper(cursor) })),
        invalid('malformed cursor', () => owner.historyRequest(task.id, field.id, { limit: 2, cursor: 'not-a-cursor' })),
        invalid('limit 0', () => owner.historyRequest(task.id, field.id, { limit: 0 })),
      ]);
      // The session really is the viewer: its write is refused.
      expectError(
        await viewerOnOwner.put(viewerOnOwner.valuePath(task.id, field.id), valueInput(field, text('Viewer value'), 5)),
        403,
        'CAPABILITY_REQUIRED',
      );
      expect(await snapshot()).toEqual(before);
      // The owner's cursor still continues its own listing.
      expect((await owner.historyPage(task.id, field.id, { limit: 2, cursor })).items).toEqual(pages[1]);
    });
  });
});
