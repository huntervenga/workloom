// Typed black-box client and whole-database write evidence for the P1b custom field acceptance
// tests. Requests go to a real API process over HTTP as a same-origin browser would send them;
// project and task setup reuses the P1a client unchanged. Database evidence counts and digests
// every public base table found in the catalog (P0, P1a and whatever P1b adds) plus the P0
// workspaces.change_seq column, so no P1b table or column name is assumed.
import { randomUUID } from 'node:crypto';

import {
  meResponseSchema,
  projectColumnsResponseSchema,
  taskFieldDefinitionListResponseSchema,
  taskFieldDefinitionResponseSchema,
  taskFieldValueHistoryListResponseSchema,
  taskFieldValueListResponseSchema,
  taskFieldValueResponseSchema,
  type CreateTaskFieldInput,
  type CreateTaskFieldOptionInput,
  type MeDto,
  type ProjectColumnsDto,
  type SetTaskFieldValueInput,
  type TaskFieldDefinitionDto,
  type TaskFieldValueDto,
  type TaskFieldValueHistoryDto,
  type UpdateProjectColumnsInput,
  type UpdateTaskFieldInput,
  type UpdateTaskFieldOptionInput,
} from '@workloom/contracts';
import type postgres from 'postgres';
import { expect } from 'vitest';

import type { ApiProcess } from './api-process.js';
import { header, rawRequest, type RawResponse } from './http.js';
import { P1A_TABLES, P1aClient, expectEnvelope, expectError } from './p1a.js';

/** Create body as a client sends it: the schema defaults policy flags and options when omitted. */
export type CreateFieldRequest = Omit<CreateTaskFieldInput, 'historyEnabled' | 'locked' | 'options'> & {
  historyEnabled?: boolean;
  locked?: boolean;
  options?: { name: string; color?: string | null }[];
};

/** Option create body as a client sends it: `color` defaults to null when omitted. */
export type CreateOptionRequest = Omit<CreateTaskFieldOptionInput, 'color'> & { color?: string | null };

export interface HistoryParams {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface HistoryPage {
  readonly items: TaskFieldValueHistoryDto[];
  readonly nextCursor: string | null;
}

/**
 * HTTP client for one API process and one workspace path. `cookie` selects another fixture actor
 * on the same process through a dev session; without it the process default actor is used.
 */
export class P1bClient {
  readonly api: ApiProcess;
  readonly workspaceId: string;
  readonly cookie: string | null;
  /** P1a client of the process default actor, for project and task setup. */
  readonly tasks: P1aClient;

  constructor(api: ApiProcess, workspaceId: string, cookie: string | null = null) {
    this.api = api;
    this.workspaceId = workspaceId;
    this.cookie = cookie;
    this.tasks = new P1aClient(api, workspaceId);
  }

  private path(suffix: string): string {
    return `/api/v1/workspaces/${this.workspaceId}${suffix}`;
  }

  private sessionHeaders(): Record<string, string> {
    return this.cookie === null ? {} : { cookie: this.cookie };
  }

  get(suffix: string): Promise<RawResponse> {
    return rawRequest(this.api.baseUrl, this.path(suffix), { headers: this.sessionHeaders() });
  }

  /**
   * Same-origin JSON mutation. `idempotencyKey` omitted sends a fresh random key; `null` omits
   * the header entirely.
   */
  send(method: 'POST' | 'PATCH' | 'PUT', suffix: string, body: unknown, idempotencyKey?: string | null): Promise<RawResponse> {
    const headers: Record<string, string> = {
      ...this.sessionHeaders(),
      origin: this.api.baseUrl,
      'content-type': 'application/json',
    };
    const key = idempotencyKey === undefined ? randomUUID() : idempotencyKey;
    if (key !== null) headers['idempotency-key'] = key;
    return rawRequest(this.api.baseUrl, this.path(suffix), { method, headers, body: JSON.stringify(body) });
  }

  post(suffix: string, body: unknown, idempotencyKey?: string | null): Promise<RawResponse> {
    return this.send('POST', suffix, body, idempotencyKey);
  }

  patch(suffix: string, body: unknown, idempotencyKey?: string | null): Promise<RawResponse> {
    return this.send('PATCH', suffix, body, idempotencyKey);
  }

  put(suffix: string, body: unknown, idempotencyKey?: string | null): Promise<RawResponse> {
    return this.send('PUT', suffix, body, idempotencyKey);
  }

  // Field definitions and options

  async listFields(projectId: string): Promise<TaskFieldDefinitionDto[]> {
    return expectEnvelope(await this.get(`/fields?projectId=${projectId}`), 200, taskFieldDefinitionListResponseSchema).data;
  }

  async createField(input: CreateFieldRequest, idempotencyKey?: string): Promise<TaskFieldDefinitionDto> {
    return expectEnvelope(await this.post('/fields', input, idempotencyKey), 201, taskFieldDefinitionResponseSchema).data;
  }

  async updateField(fieldId: string, input: UpdateTaskFieldInput): Promise<TaskFieldDefinitionDto> {
    return expectEnvelope(await this.patch(`/fields/${fieldId}`, input), 200, taskFieldDefinitionResponseSchema).data;
  }

  async createOption(fieldId: string, input: CreateOptionRequest): Promise<TaskFieldDefinitionDto> {
    return expectEnvelope(await this.post(`/fields/${fieldId}/options`, input), 201, taskFieldDefinitionResponseSchema).data;
  }

  async updateOption(fieldId: string, optionId: string, input: UpdateTaskFieldOptionInput): Promise<TaskFieldDefinitionDto> {
    return expectEnvelope(
      await this.patch(`/fields/${fieldId}/options/${optionId}`, input),
      200,
      taskFieldDefinitionResponseSchema,
    ).data;
  }

  // Shared project column settings

  async getColumns(projectId: string): Promise<ProjectColumnsDto> {
    return expectEnvelope(await this.get(`/projects/${projectId}/columns`), 200, projectColumnsResponseSchema).data;
  }

  async updateColumns(projectId: string, input: UpdateProjectColumnsInput): Promise<ProjectColumnsDto> {
    return expectEnvelope(await this.patch(`/projects/${projectId}/columns`, input), 200, projectColumnsResponseSchema).data;
  }

  // Typed values and history

  async listTaskValues(taskId: string): Promise<TaskFieldValueDto[]> {
    return expectEnvelope(await this.get(`/tasks/${taskId}/field-values`), 200, taskFieldValueListResponseSchema).data;
  }

  async listProjectValues(projectId: string, taskIds: readonly string[]): Promise<TaskFieldValueDto[]> {
    return expectEnvelope(
      await this.get(`/projects/${projectId}/field-values?taskIds=${taskIds.join(',')}`),
      200,
      taskFieldValueListResponseSchema,
    ).data;
  }

  valuePath(taskId: string, fieldId: string): string {
    return `/tasks/${taskId}/field-values/${fieldId}`;
  }

  async setValue(
    taskId: string,
    fieldId: string,
    input: SetTaskFieldValueInput,
    idempotencyKey?: string,
  ): Promise<TaskFieldValueDto> {
    return expectEnvelope(
      await this.put(this.valuePath(taskId, fieldId), input, idempotencyKey),
      200,
      taskFieldValueResponseSchema,
    ).data;
  }

  historyRequest(taskId: string, fieldId: string, params: HistoryParams = {}): Promise<RawResponse> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    const search = query.toString();
    return this.get(`${this.valuePath(taskId, fieldId)}/history${search === '' ? '' : `?${search}`}`);
  }

  async historyPage(taskId: string, fieldId: string, params: HistoryParams = {}): Promise<HistoryPage> {
    const body = expectEnvelope(await this.historyRequest(taskId, fieldId, params), 200, taskFieldValueHistoryListResponseSchema);
    // History pages always answer with an explicit cursor; null marks the last page.
    expect(body.meta.nextCursor).not.toBeUndefined();
    return { items: body.data, nextCursor: body.meta.nextCursor ?? null };
  }

  /** Follows cursors to exhaustion; fails on a repeated cursor or more than `maxPages` pages. */
  async historyPages(taskId: string, fieldId: string, limit: number, maxPages = 20): Promise<TaskFieldValueHistoryDto[][]> {
    const pages: TaskFieldValueHistoryDto[][] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let index = 0; index < maxPages; index += 1) {
      const page = await this.historyPage(taskId, fieldId, { limit, cursor });
      pages.push(page.items);
      if (page.nextCursor === null) return pages;
      if (seen.has(page.nextCursor)) throw new Error(`Value history repeated a cursor after ${pages.length} pages.`);
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`Value history did not reach nextCursor null within ${maxPages} pages.`);
  }

  /** Whole history of one task field, newest first. */
  async allHistory(taskId: string, fieldId: string): Promise<TaskFieldValueHistoryDto[]> {
    return (await this.historyPages(taskId, fieldId, 100)).flat();
  }
}

/**
 * Opens a dev session for `actorId` on `api` exactly like the local actor switcher and returns
 * the `name=value` cookie pair. The session lives in that process only.
 */
export async function devSessionCookie(api: ApiProcess, actorId: string): Promise<{ cookie: string; me: MeDto }> {
  const response = await rawRequest(api.baseUrl, '/api/v1/dev/session', {
    method: 'POST',
    headers: { origin: api.baseUrl, 'x-workloom-dev-tool': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ actorId }),
  });
  const me = expectEnvelope(response, 200, meResponseSchema).data;
  const cookie = header(response, 'set-cookie').split(';', 1)[0]?.trim() ?? '';
  expect(cookie, 'dev session answered without a cookie').toMatch(/^[^=\s]+=[^=\s]+/);
  return { cookie, me };
}

export interface Rejection {
  readonly label: string;
  readonly status: number;
  readonly code: string;
  readonly run: () => Promise<RawResponse>;
}

/** Runs every case in order and asserts its status and code, and that no `hidden` text leaks. */
export async function expectRejections(cases: readonly Rejection[], hidden: readonly string[] = []): Promise<void> {
  for (const { label, status, code, run } of cases) {
    const response = await run();
    expect(response.status, `${label}: ${response.text()}`).toBe(status);
    expectError(response, status, code, hidden);
  }
}

/** Tables that must exist from P0 and P1a; a missing one fails the snapshot instead of shrinking it. */
const REQUIRED_TABLES = [...P1A_TABLES, 'workspaces', 'memberships', 'audit_events', 'outbox_events'] as const;

export interface DatabaseSnapshot {
  /** Workspace id → change_seq, advanced once per committed workspace write (P0). */
  readonly changeSeq: Record<string, string>;
  /** Public base table → row count. */
  readonly rows: Record<string, number>;
  /** Public base table → md5 of every row's content in a stable order. */
  readonly rowDigests: Record<string, string>;
}

/** Every base table of the public schema, from the catalog; nothing is excluded. */
export async function publicBaseTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by c.relname`;
  return rows.map((row) => row.name);
}

/**
 * Whole-database write evidence. Equal snapshots mean no row anywhere in the public schema was
 * inserted, deleted or changed in place, including audit, outbox and idempotency results.
 */
export async function databaseSnapshot(sql: postgres.Sql): Promise<DatabaseSnapshot> {
  const tables = await publicBaseTables(sql);
  const missing = REQUIRED_TABLES.filter((table) => !tables.includes(table));
  if (missing.length > 0) throw new Error(`Expected tables are missing from the public schema: ${missing.join(', ')}.`);

  const workspaces = await sql<{ id: string; change_seq: string }[]>`
    select id::text as id, change_seq::text as change_seq from workspaces order by id`;
  const rows: Record<string, number> = {};
  const rowDigests: Record<string, string> = {};
  for (const table of tables) {
    // jsonb output has normalized key order, so ordering by the row text gives a stable digest.
    const [row] = await sql<{ count: string; digest: string }[]>`
      select
        count(*)::text as count,
        md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text) as digest
      from ${sql(table)} as t`;
    rows[table] = Number(row?.count);
    rowDigests[table] = String(row?.digest);
  }
  return { changeSeq: Object.fromEntries(workspaces.map((row) => [row.id, row.change_seq])), rows, rowDigests };
}

function snapshotTables(before: DatabaseSnapshot, after: DatabaseSnapshot): string[] {
  return [...new Set([...Object.keys(before.rows), ...Object.keys(after.rows)])].sort();
}

/** Tables whose row count or whole-row digest differs. */
export function changedTables(before: DatabaseSnapshot, after: DatabaseSnapshot): string[] {
  return snapshotTables(before, after).filter(
    (table) => before.rows[table] !== after.rows[table] || before.rowDigests[table] !== after.rowDigests[table],
  );
}

/** Row-count difference `after - before` per table. */
export function rowDelta(before: DatabaseSnapshot, after: DatabaseSnapshot): Record<string, number> {
  return Object.fromEntries(
    snapshotTables(before, after).map((table) => [table, (after.rows[table] ?? 0) - (before.rows[table] ?? 0)]),
  );
}

/**
 * Every P0 audit and outbox row as whole-row JSON text. Callers search it for value sentinels
 * without knowing which column might carry a payload.
 */
export async function genericEventRows(sql: postgres.Sql): Promise<string[]> {
  const audit = await sql<{ row: string }[]>`select to_jsonb(t)::text as row from audit_events as t order by 1`;
  const outbox = await sql<{ row: string }[]>`select to_jsonb(t)::text as row from outbox_events as t order by 1`;
  return [...audit.map((r) => `audit_events ${r.row}`), ...outbox.map((r) => `outbox_events ${r.row}`)];
}

/** P0 memberships columns (migration 0000); timestamps as text so a restore writes them back exactly. */
export interface MembershipRow {
  readonly state: 'active' | 'revoked';
  readonly revision: number;
  readonly revoked_at: string | null;
  readonly updated_at: string;
}

export async function membershipRow(sql: postgres.Sql, workspaceId: string, membershipId: string): Promise<MembershipRow> {
  const [row, ...extra] = await sql<MembershipRow[]>`
    select state, revision, revoked_at::text as revoked_at, updated_at::text as updated_at
    from memberships
    where workspace_id = ${workspaceId} and id = ${membershipId}`;
  if (!row || extra.length > 0) throw new Error(`Expected one memberships row for ${membershipId}.`);
  return row;
}

export async function revokeMembership(sql: postgres.Sql, workspaceId: string, membershipId: string): Promise<void> {
  await sql`
    update memberships set state = 'revoked', revoked_at = now(), revision = revision + 1, updated_at = now()
    where workspace_id = ${workspaceId} and id = ${membershipId}`;
}

/** Writes the captured row back exactly. */
export async function restoreMembership(
  sql: postgres.Sql,
  workspaceId: string,
  membershipId: string,
  original: MembershipRow,
): Promise<void> {
  // Bind timestamps as text: an inferred timestamptz parameter goes through Date and drops microseconds.
  await sql`
    update memberships
    set state = ${original.state}::membership_state, revoked_at = ${original.revoked_at}::text::timestamptz,
      revision = ${original.revision}, updated_at = ${original.updated_at}::text::timestamptz
    where workspace_id = ${workspaceId} and id = ${membershipId}`;
}
