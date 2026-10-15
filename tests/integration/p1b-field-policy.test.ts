// Real PostgreSQL policy/transaction regressions. Command-source coverage uses the shared
// application directly; it does not claim that MCP/import/job transports are implemented.
import { randomUUID } from 'node:crypto';

import { createTaskFieldInputSchema, createTaskInputSchema, type TaskFieldDefinitionDto } from '@workloom/contracts';
import {
  createDatabase,
  createTaskApplication,
  createTaskFieldApplication,
  FIXTURE_USER_IDS,
  FIXTURE_WORKSPACE_IDS,
  type Database,
} from '@workloom/db';
import { COMMAND_SOURCES, isDomainError, type CommandContext, type CommandSource, type TaskFieldApplication } from '@workloom/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateAndSeed } from './support/db-cli.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();

function context(source: CommandSource = 'api', key = randomUUID()): CommandContext {
  return {
    actor: { userId: FIXTURE_USER_IDS.owner, displayName: 'Synthetic Field Policy Owner', kind: 'fixture' },
    workspaceId: FIXTURE_WORKSPACE_IDS.team,
    source,
    requestId: randomUUID(),
    idempotencyKey: key,
  };
}

/** Find the actual SQLSTATE through the Drizzle wrapper, without relying on log text. */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)) return error.code;
  return 'cause' in error ? sqlState(error.cause) : undefined;
}

function hasMessage(error: unknown, expected: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(expected) || ('cause' in error && hasMessage(error.cause, expected));
}

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => null, (error: unknown) => error);
}

describe('P1b shared field policy, SQL constraints and transaction rollback on PostgreSQL', () => {
  let isolated: ThrowawayDatabase;
  let database: Database;
  let fields: TaskFieldApplication;

  beforeAll(async () => {
    isolated = await createThrowawayDatabase('p1b_policy');
    await migrateAndSeed(isolated.url);
    database = createDatabase(isolated.url, { requireLoopback: true, maxConnections: 2 });
    fields = createTaskFieldApplication(database);
  });

  afterAll(async () => {
    await database?.close();
    await isolated?.drop();
  });

  /** Every public table, including current values, immutable history, audit, outbox and keys. */
  async function snapshot() {
    const tables = await isolated.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
    expect(tables.some((row) => row.table_name === 'task_field_value_history')).toBe(true);
    const evidence: Record<string, { count: string; digest: string }> = {};
    for (const { table_name: table } of tables) {
      const [row] = await isolated.sql<{ count: string; digest: string }[]>`
        select count(*)::text as count,
          md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text) as digest
        from ${isolated.sql(table)} t`;
      if (!row) throw new Error('Snapshot aggregation returned no row.');
      evidence[table] = row;
    }
    return evidence;
  }

  async function fixture(label: string) {
    const tasks = createTaskApplication(database);
    const project = await tasks.createProject(context(), { name: `${label} ${randomUUID().slice(0, 8)}` });
    const statuses = await tasks.listStatuses(context(), project.id);
    const status = statuses.find((item) => item.group === 'todo');
    if (!status) throw new Error('Project has no todo status.');
    const task = await tasks.createTask(context(), createTaskInputSchema.parse({
      projectId: project.id, statusId: status.id, title: 'Synthetic field policy task', estimateMinutes: 120,
    }));
    const field = await fields.createField(context(), createTaskFieldInputSchema.parse({
      projectId: project.id, name: 'Synthetic policy text', type: 'text',
    }));
    const value = await fields.setTaskValue(context(), task.id, field.id, {
      expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'text', value: 'before' },
    });
    return { task, field, value };
  }

  async function changeDefinition(field: TaskFieldDefinitionDto, locked: boolean) {
    return fields.updateField(context(), field.id, { expectedRevision: field.revision, locked });
  }

  it('enforces a custom-field lock for all shared command sources, then records the source after explicit unlock', async () => {
    const { task, field, value } = await fixture('Source lock');
    const locked = await changeDefinition(field, true);
    for (const source of COMMAND_SOURCES) {
      for (const text of ['changed', 'before']) {
        const before = await snapshot();
        const error = await failureOf(fields.setTaskValue(context(source), task.id, field.id, {
          expectedRevision: value.revision, expectedDefinitionRevision: locked.revision,
          value: { type: 'text', value: text },
        }));
        expect(isDomainError(error)).toBe(true);
        expect(isDomainError(error) && error.code).toBe('FIELD_LOCKED');
        expect(await snapshot()).toEqual(before);
      }
    }
    const unlocked = await changeDefinition(locked, false);
    const changed = await fields.setTaskValue(context('mcp'), task.id, field.id, {
      expectedRevision: value.revision, expectedDefinitionRevision: unlocked.revision,
      value: { type: 'text', value: 'after unlock' },
    });
    expect(changed.revision).toBe(value.revision + 1);
    const history = await fields.listValueHistory(context(), task.id, field.id, { limit: 100 });
    expect(history.items.find((item) => item.valueRevision === changed.revision)?.source).toBe('mcp');
    const persisted = await createTaskApplication(database).getTask(context(), task.id);
    expect(persisted.estimateMinutes).toBe(120);
    expect(persisted.workPackageRevision).toBe(task.workPackageRevision);
  });

  it('rolls back a value/history/audit/key write on a real outbox SQL fault, then permits the same key exactly once', async () => {
    const { task, field, value } = await fixture('Field rollback');
    const key = randomUUID();
    const input = {
      expectedRevision: value.revision, expectedDefinitionRevision: field.revision,
      value: { type: 'text' as const, value: 'after real SQL fault' },
    };
    await isolated.sql.unsafe(`create function synthetic_p1b_outbox_failure() returns trigger language plpgsql as $$
      begin raise exception 'synthetic_p1b_outbox_failure'; end $$`);
    await isolated.sql.unsafe(`create trigger synthetic_p1b_outbox_failure before insert on outbox_events
      for each row execute function synthetic_p1b_outbox_failure()`);
    const before = await snapshot();
    try {
      const error = await failureOf(fields.setTaskValue(context('api', key), task.id, field.id, input));
      expect(error).not.toBeNull();
      expect(hasMessage(error, 'synthetic_p1b_outbox_failure')).toBe(true);
      expect(sqlState(error)).toBe('P0001');
      expect(await snapshot()).toEqual(before);
    } finally {
      await isolated.sql.unsafe('drop trigger if exists synthetic_p1b_outbox_failure on outbox_events');
      await isolated.sql.unsafe('drop function if exists synthetic_p1b_outbox_failure()');
    }
    // The idempotency result is persisted after the current value, dedicated history, audit
    // and outbox. A second real SQL fault here proves those preceding writes roll back too.
    await isolated.sql.unsafe(`create function synthetic_p1b_key_failure() returns trigger language plpgsql as $$
      begin raise exception 'synthetic_p1b_key_failure'; end $$`);
    await isolated.sql.unsafe(`create trigger synthetic_p1b_key_failure before insert on command_idempotency
      for each row execute function synthetic_p1b_key_failure()`);
    try {
      const error = await failureOf(fields.setTaskValue(context('api', key), task.id, field.id, input));
      expect(hasMessage(error, 'synthetic_p1b_key_failure')).toBe(true);
      expect(sqlState(error)).toBe('P0001');
      expect(await snapshot()).toEqual(before);
    } finally {
      await isolated.sql.unsafe('drop trigger if exists synthetic_p1b_key_failure on command_idempotency');
      await isolated.sql.unsafe('drop function if exists synthetic_p1b_key_failure()');
    }
    const committed = await fields.setTaskValue(context('api', key), task.id, field.id, input);
    expect(committed.revision).toBe(value.revision + 1);
    expect(committed.value).toEqual(input.value);
    const committedState = await snapshot();
    const replay = await fields.setTaskValue(context('api', key), task.id, field.id, input);
    expect(replay).toEqual(committed);
    expect(await snapshot()).toEqual(committedState);
    const history = await fields.listValueHistory(context(), task.id, field.id, { limit: 100 });
    expect(history.items.filter((item) => item.valueRevision === committed.revision)).toHaveLength(1);
  });

  it('rejects malformed current values, history and definition snapshots with SQLSTATE23514 and no committed data change', async () => {
    const { task, field } = await fixture('SQL JSON guards');
    const sql = isolated.sql;
    const [history] = await sql<{ row: Record<string, unknown> }[]>`
      select to_jsonb(h) as row from task_field_value_history h
      where task_id = ${task.id} and field_id = ${field.id} order by value_revision desc limit 1`;
    const [version] = await sql<{ row: Record<string, unknown> }[]>`
      select to_jsonb(v) as row from task_field_definition_versions v where id = ${field.definitionVersionId}`;
    if (!history || !version) throw new Error('Legitimate field history and definition version must exist.');

    async function rejectsCheck(operation: () => Promise<unknown>, label: string) {
      const before = await snapshot();
      const error = await failureOf(operation());
      expect(sqlState(error), `${label}: must fail its SQL check, rather than a fixture FK/unique constraint`).toBe('23514');
      expect(await snapshot(), label).toEqual(before);
    }

    const malformed = [{ value: 'bad' }, { type: 'text' }, { type: 'unknown', value: 'bad' }, { type: 'number', value: 1 }];
    for (const payload of malformed) {
      await rejectsCheck(() => sql`
        update task_field_values set value = ${JSON.stringify(payload)}::text::jsonb
        where task_id = ${task.id} and field_id = ${field.id}`, `current value ${JSON.stringify(payload)}`);
    }

    // Append-only tables are tested through INSERT, so an immutability UPDATE trigger cannot
    // disguise a missing JSON CHECK. All references come from real committed fixture rows.
    for (const column of ['before', 'after'] as const) {
      for (const payload of malformed) {
        const row = {
          ...history.row,
          id: randomUUID(),
          change_seq: '999999999',
          event_ordinal: 1,
          before: { type: 'text', value: 'previous' },
          after: { type: 'text', value: 'next' },
          [column]: payload,
        };
        await rejectsCheck(() => sql`
          insert into task_field_value_history select (jsonb_populate_record(null::task_field_value_history,
            ${JSON.stringify(row)}::text::jsonb)).*`, `history ${column} ${JSON.stringify(payload)}`);
      }
    }

    const originalSnapshot = version.row.snapshot as Record<string, unknown>;
    for (const key of ['id', 'workspaceId', 'projectId', 'revision', 'definitionVersionId']) {
      const id = randomUUID();
      const revision = Number(version.row.revision) + 1;
      const snapshotValue = Object.fromEntries(
        Object.entries({ ...originalSnapshot, revision, definitionVersionId: id }).filter(([name]) => name !== key),
      );
      const row = { ...version.row, id, revision, snapshot: snapshotValue };
      await rejectsCheck(() => sql`
        insert into task_field_definition_versions select (jsonb_populate_record(null::task_field_definition_versions,
          ${JSON.stringify(row)}::text::jsonb)).*`, `definition snapshot missing ${key}`);
    }
    const id = randomUUID();
    const revision = Number(version.row.revision) + 1;
    const row = {
      ...version.row, id, revision,
      snapshot: { ...originalSnapshot, revision, definitionVersionId: randomUUID() },
    };
    await rejectsCheck(() => sql`
      insert into task_field_definition_versions select (jsonb_populate_record(null::task_field_definition_versions,
        ${JSON.stringify(row)}::text::jsonb)).*`, 'definition snapshot version identity mismatch');
  });
});
