// Typed black-box client and write evidence for the P1a task acceptance tests. Requests go to a
// real API process over HTTP as a same-origin browser would send them; database evidence counts
// and digests whole rows of the confirmed P1a tables plus the P0 audit/outbox tables and reads
// the P0 workspaces.change_seq column, so no P1a column name is assumed.
import { randomUUID } from 'node:crypto';

import {
  errorResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  sectionListResponseSchema,
  sectionResponseSchema,
  tagResponseSchema,
  taskListResponseSchema,
  taskResponseSchema,
  taskStatusListResponseSchema,
  type CreateSectionInput,
  type CreateTagInput,
  type CreateTaskInput,
  type ErrorResponseDto,
  type ProjectDto,
  type SectionDto,
  type TagDto,
  type TaskDto,
  type TaskListQuery,
  type TaskStatusDto,
  type TaskStatusGroup,
  type UpdateProjectInput,
  type UpdateSectionInput,
  type UpdateTagInput,
  type UpdateTaskInput,
} from '@workloom/contracts';
import type postgres from 'postgres';
import { expect } from 'vitest';

import type { ApiProcess } from './api-process.js';
import { header, rawRequest, type RawResponse } from './http.js';

interface Parser<T> {
  parse(value: unknown): T;
}

/** List query as sent by a client: `limit` falls back to the server default when omitted. */
export type TaskListParams = Omit<TaskListQuery, 'limit' | 'cursor'> & { limit?: number; cursor?: string };

export interface TaskPage {
  readonly items: TaskDto[];
  readonly nextCursor: string | null;
}

/** Short unique suffix so names never collide with seed data or earlier scenarios. */
export function uniqueName(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

function jsonOf(response: RawResponse): unknown {
  expect(header(response, 'content-type'), response.text()).toMatch(/^application\/json\b/i);
  return response.json();
}

export function expectEnvelope<T>(response: RawResponse, status: number, schema: Parser<T>): T {
  expect(response.status, response.text()).toBe(status);
  return schema.parse(jsonOf(response));
}

/** Asserts an error status and code, and that none of `hidden` appears anywhere in the body. */
export function expectError(
  response: RawResponse,
  status: number,
  code: string,
  hidden: readonly string[] = [],
): ErrorResponseDto {
  expect(response.status, response.text()).toBe(status);
  const body = errorResponseSchema.parse(jsonOf(response));
  expect(body.error.code, response.text()).toBe(code);
  const text = response.text();
  for (const value of hidden) expect(text).not.toContain(value);
  return body;
}

/** HTTP client for one API process and one workspace path. */
export class P1aClient {
  readonly api: ApiProcess;
  readonly workspaceId: string;

  constructor(api: ApiProcess, workspaceId: string) {
    this.api = api;
    this.workspaceId = workspaceId;
  }

  private path(suffix: string): string {
    return `/api/v1/workspaces/${this.workspaceId}${suffix}`;
  }

  get(suffix: string): Promise<RawResponse> {
    return rawRequest(this.api.baseUrl, this.path(suffix));
  }

  /**
   * Same-origin JSON mutation. `idempotencyKey` omitted sends a fresh random key; `null` omits
   * the header entirely.
   */
  send(method: 'POST' | 'PATCH', suffix: string, body: unknown, idempotencyKey?: string | null): Promise<RawResponse> {
    const headers: Record<string, string> = { origin: this.api.baseUrl, 'content-type': 'application/json' };
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

  // Projects, sections, statuses, tags

  async listProjects(): Promise<ProjectDto[]> {
    return expectEnvelope(await this.get('/projects'), 200, projectListResponseSchema).data;
  }

  async createProject(name: string): Promise<ProjectDto> {
    return expectEnvelope(await this.post('/projects', { name }), 201, projectResponseSchema).data;
  }

  async getProject(projectId: string): Promise<ProjectDto> {
    return expectEnvelope(await this.get(`/projects/${projectId}`), 200, projectResponseSchema).data;
  }

  async updateProject(projectId: string, input: UpdateProjectInput): Promise<ProjectDto> {
    return expectEnvelope(await this.patch(`/projects/${projectId}`, input), 200, projectResponseSchema).data;
  }

  async listSections(projectId: string): Promise<SectionDto[]> {
    return expectEnvelope(await this.get(`/projects/${projectId}/sections`), 200, sectionListResponseSchema).data;
  }

  async createSection(projectId: string, input: CreateSectionInput): Promise<SectionDto> {
    return expectEnvelope(await this.post(`/projects/${projectId}/sections`, input), 201, sectionResponseSchema).data;
  }

  async updateSection(sectionId: string, input: UpdateSectionInput): Promise<SectionDto> {
    return expectEnvelope(await this.patch(`/sections/${sectionId}`, input), 200, sectionResponseSchema).data;
  }

  async listStatuses(projectId: string): Promise<TaskStatusDto[]> {
    return expectEnvelope(await this.get(`/projects/${projectId}/statuses`), 200, taskStatusListResponseSchema).data;
  }

  async createTag(input: CreateTagInput): Promise<TagDto> {
    return expectEnvelope(await this.post('/tags', input), 201, tagResponseSchema).data;
  }

  async updateTag(tagId: string, input: UpdateTagInput): Promise<TagDto> {
    return expectEnvelope(await this.patch(`/tags/${tagId}`, input), 200, tagResponseSchema).data;
  }

  // Tasks

  async createTask(input: CreateTaskInput, idempotencyKey?: string): Promise<TaskDto> {
    return expectEnvelope(await this.post('/tasks', input, idempotencyKey), 201, taskResponseSchema).data;
  }

  async getTask(taskId: string): Promise<TaskDto> {
    return expectEnvelope(await this.get(`/tasks/${taskId}`), 200, taskResponseSchema).data;
  }

  async updateTask(taskId: string, input: UpdateTaskInput): Promise<TaskDto> {
    return expectEnvelope(await this.patch(`/tasks/${taskId}`, input), 200, taskResponseSchema).data;
  }

  async archiveTask(taskId: string, expectedRevision: number): Promise<TaskDto> {
    return expectEnvelope(await this.post(`/tasks/${taskId}/archive`, { expectedRevision }), 200, taskResponseSchema).data;
  }

  async restoreTask(taskId: string, expectedRevision: number): Promise<TaskDto> {
    return expectEnvelope(await this.post(`/tasks/${taskId}/restore`, { expectedRevision }), 200, taskResponseSchema).data;
  }

  async listTasksPage(params: TaskListParams): Promise<TaskPage> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) query.set(name, String(value));
    }
    const body = expectEnvelope(await this.get(`/tasks?${query.toString()}`), 200, taskListResponseSchema);
    // Paged lists always answer with an explicit cursor; null marks the last page.
    expect(body.meta.nextCursor).not.toBeUndefined();
    return { items: body.data, nextCursor: body.meta.nextCursor ?? null };
  }

  /** Follows opaque cursors to exhaustion; fails on a repeated cursor or more than `maxPages` pages. */
  async pageThroughTasks(params: Omit<TaskListParams, 'cursor'>, maxPages = 20): Promise<TaskDto[][]> {
    const pages: TaskDto[][] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let index = 0; index < maxPages; index += 1) {
      const page = await this.listTasksPage({ ...params, cursor });
      pages.push(page.items);
      if (page.nextCursor === null) return pages;
      if (seen.has(page.nextCursor)) throw new Error(`Task list repeated a cursor after ${pages.length} pages.`);
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`Task list did not reach nextCursor null within ${maxPages} pages.`);
  }

  async listAllTasks(params: Omit<TaskListParams, 'cursor'>): Promise<TaskDto[]> {
    return (await this.pageThroughTasks(params)).flat();
  }
}

/** First status of `group` by position; project creation bootstraps the statuses. */
export function statusInGroup(statuses: readonly TaskStatusDto[], group: TaskStatusGroup): TaskStatusDto {
  const status = [...statuses].sort((a, b) => a.position - b.position).find((candidate) => candidate.group === group);
  if (!status) {
    throw new Error(`Bootstrapped statuses have no "${group}" group (got: ${statuses.map((s) => s.group).join(', ')}).`);
  }
  return status;
}

/** Confirmed P1a tables (migration 0001). Counted and digested whole: each test file owns its database. */
export const P1A_TABLES = [
  'projects',
  'sections',
  'task_statuses',
  'workspace_tags',
  'work_packages',
  'tasks',
  'task_participants',
  'task_tags',
  'command_idempotency',
] as const;

const COUNTED_TABLES = [...P1A_TABLES, 'audit_events', 'outbox_events'] as const;

export interface WriteSnapshot {
  /** Workspace id → change_seq, advanced once per committed workspace write (P0). */
  readonly changeSeq: Record<string, string>;
  /** Table → row count. */
  readonly rows: Record<string, number>;
  /** Table → md5 of every row's content in a stable order; catches in-place updates counts miss. */
  readonly rowDigests: Record<string, string>;
}

/**
 * Write evidence across every workspace. Equal snapshots mean no committed state, audit, outbox
 * or idempotency result: no row was inserted, deleted or changed in place. A missing P1a table
 * fails the query instead of being skipped.
 */
export async function writeSnapshot(sql: postgres.Sql): Promise<WriteSnapshot> {
  const workspaces = await sql<{ id: string; change_seq: string }[]>`
    select id::text as id, change_seq::text as change_seq from workspaces order by id`;
  const rows: Record<string, number> = {};
  const rowDigests: Record<string, string> = {};
  for (const table of COUNTED_TABLES) {
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

/** Row-count difference `after - before` per counted table. */
export function rowDelta(before: WriteSnapshot, after: WriteSnapshot): Record<string, number> {
  return Object.fromEntries(COUNTED_TABLES.map((table) => [table, (after.rows[table] ?? 0) - (before.rows[table] ?? 0)]));
}
