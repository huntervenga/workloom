// Frozen fifteen-route P3b catalog from docs/16 §5 over real HTTP, parsed by the shared contract
// schemas. Previews are keyless reads (`post(..., null)`); every mutation sends an Idempotency-Key.
// No recurrence table name is assumed: database evidence stays the whole-schema snapshot plus the
// P0 outbox_events rows of the one subscribed type.
import {
  RECURRENCE_MATERIALIZATION_REQUESTED,
  meetingListResponseSchema, planningPackageListResponseSchema,
  recurrenceCreatePreviewResponseSchema, recurrenceEditPreviewResponseSchema, recurrenceExceptionPreviewResponseSchema,
  recurrenceInstanceListResponseSchema, recurrenceInstanceResponseSchema, recurrenceMaterializationRequestedPayloadSchema,
  recurrenceMaterializationResultResponseSchema, recurrencePeriodPreviewResponseSchema, recurrencePeriodsResultResponseSchema,
  recurrenceReadinessResponseSchema, recurrenceSeriesListResponseSchema, recurrenceSeriesResponseSchema,
  type AddRecurrencePeriodsInput, type AuthorizeRecurrenceGenerationInput, type CreateRecurrenceSeriesInput,
  type EditRecurrenceSeriesInput, type MaterializePeriodInput, type MeetingListItemDto, type PlanningPackageDto,
  type RecurrenceCreatePreviewInput, type RecurrenceEditPreviewInput, type RecurrenceExceptionPreviewInput,
  type RecurrenceInstanceDto, type RecurrenceMaterializationRequestedPayload, type RecurrencePeriodPreviewInput,
  type RecurrenceSeriesDto, type SetRecurrenceExceptionInput, type SetRecurrenceSeriesStateInput,
} from '@workloom/contracts';
import type postgres from 'postgres';
import { expect } from 'vitest';

import { expectEnvelope } from './p1a.js';
import { changedTables, databaseSnapshot, type DatabaseSnapshot } from './p1b.js';
import type { P2aClient } from './p2a.js';
import type { PlanningHarness } from './p2a-fixture.js';
import { P3aClient } from './p3a.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Exception body without the revisions the helper reads fresh from the server. */
export type RecurrenceExceptionBody = DistributiveOmit<RecurrenceExceptionPreviewInput, 'expectedSeriesRevision' | 'expectedInstanceRevision'>;
/** Materialize body as a client sends it: the server defaults `limit` to 100. */
export type MaterializeRequest = Partial<MaterializePeriodInput>;
export type LocatedInstance = RecurrenceInstanceDto & { meetingId: string; taskId: string; workPackageId: string };

export const P3B_PATHS = {
  seriesList: (projectId: string) => `/projects/${projectId}/recurrence-series`,
  createPreview: (projectId: string) => `/projects/${projectId}/recurrence-preview`,
  create: (projectId: string) => `/projects/${projectId}/recurrence-series`,
  series: (seriesId: string) => `/recurrence-series/${seriesId}`,
  editPreview: (seriesId: string) => `/recurrence-series/${seriesId}/edit-preview`,
  edit: (seriesId: string) => `/recurrence-series/${seriesId}/edit`,
  state: (seriesId: string) => `/recurrence-series/${seriesId}/state`,
  periodPreview: (seriesId: string) => `/recurrence-series/${seriesId}/period-preview`,
  periods: (seriesId: string) => `/recurrence-series/${seriesId}/periods`,
  authorize: (seriesId: string) => `/recurrence-series/${seriesId}/generation-authorization`,
  instances: (seriesId: string) => `/recurrence-series/${seriesId}/instances`,
  exceptionPreview: (seriesId: string, occurrenceKey: string) => `/recurrence-series/${seriesId}/instances/${occurrenceKey}/exception-preview`,
  exception: (seriesId: string, occurrenceKey: string) => `/recurrence-series/${seriesId}/instances/${occurrenceKey}/exception`,
  materialize: (periodId: string) => `/periods/${periodId}/materialize-meetings`,
  readiness: (periodId: string) => `/periods/${periodId}/recurrence-readiness`,
} as const;
const P = P3B_PATHS;

export class P3bClient extends P3aClient {
  listSeries(projectId: string, state: 'active' | 'paused' | 'all' = 'all', limit = 1): Promise<RecurrenceSeriesDto[]> {
    return this.all(P.seriesList(projectId), recurrenceSeriesListResponseSchema, { state }, limit);
  }
  async previewCreate(projectId: string, input: RecurrenceCreatePreviewInput) {
    return expectEnvelope(await this.post(P.createPreview(projectId), input, null), 200, recurrenceCreatePreviewResponseSchema).data;
  }
  async createSeries(projectId: string, input: CreateRecurrenceSeriesInput, key?: string) {
    return expectEnvelope(await this.post(P.create(projectId), input, key), 201, recurrenceSeriesResponseSchema).data;
  }
  async series(seriesId: string) {
    return expectEnvelope(await this.get(P.series(seriesId)), 200, recurrenceSeriesResponseSchema).data;
  }
  async previewEdit(seriesId: string, input: RecurrenceEditPreviewInput) {
    return expectEnvelope(await this.post(P.editPreview(seriesId), input, null), 200, recurrenceEditPreviewResponseSchema).data;
  }
  async editSeries(seriesId: string, input: EditRecurrenceSeriesInput, key?: string) {
    return expectEnvelope(await this.post(P.edit(seriesId), input, key), 200, recurrenceSeriesResponseSchema).data;
  }
  async setSeriesState(seriesId: string, input: SetRecurrenceSeriesStateInput, key?: string) {
    return expectEnvelope(await this.patch(P.state(seriesId), input, key), 200, recurrenceSeriesResponseSchema).data;
  }
  async previewPeriods(seriesId: string, input: RecurrencePeriodPreviewInput) {
    return expectEnvelope(await this.post(P.periodPreview(seriesId), input, null), 200, recurrencePeriodPreviewResponseSchema).data;
  }
  async addPeriods(seriesId: string, input: AddRecurrencePeriodsInput, key?: string) {
    return expectEnvelope(await this.post(P.periods(seriesId), input, key), 200, recurrencePeriodsResultResponseSchema).data;
  }
  async authorizeGeneration(seriesId: string, input: AuthorizeRecurrenceGenerationInput, key?: string) {
    return expectEnvelope(await this.post(P.authorize(seriesId), input, key), 200, recurrenceSeriesResponseSchema).data;
  }
  /** Every page of one explicit period, sorted by the original nominal key. */
  async instances(seriesId: string, periodId: string, includeCancelled = true, limit = 1): Promise<RecurrenceInstanceDto[]> {
    return sortByKey(await this.all(P.instances(seriesId), recurrenceInstanceListResponseSchema, { periodId, includeCancelled: String(includeCancelled) }, limit));
  }
  async previewException(seriesId: string, occurrenceKey: string, input: RecurrenceExceptionPreviewInput) {
    return expectEnvelope(await this.post(P.exceptionPreview(seriesId, occurrenceKey), input, null), 200, recurrenceExceptionPreviewResponseSchema).data;
  }
  async setException(seriesId: string, occurrenceKey: string, input: SetRecurrenceExceptionInput, key?: string) {
    return expectEnvelope(await this.post(P.exception(seriesId, occurrenceKey), input, key), 200, recurrenceInstanceResponseSchema).data;
  }
  async materialize(periodId: string, input: MaterializeRequest = {}, key?: string) {
    return expectEnvelope(await this.post(P.materialize(periodId), input, key), 200, recurrenceMaterializationResultResponseSchema).data;
  }
  async readiness(periodId: string) {
    return expectEnvelope(await this.get(P.readiness(periodId)), 200, recurrenceReadinessResponseSchema).data;
  }

  /** Fresh preview, then create with exactly that hash. */
  async create(projectId: string, input: RecurrenceCreatePreviewInput, key?: string) {
    const preview = await this.previewCreate(projectId, input);
    const series = await this.createSeries(projectId, { ...input, previewHash: preview.previewHash }, key);
    return { preview, series };
  }
  /** Fresh series revision and preview, then apply with exactly that hash. */
  async exception(instance: RecurrenceInstanceDto, body: RecurrenceExceptionBody, key?: string) {
    const series = await this.series(instance.seriesId);
    const input = { ...body, expectedSeriesRevision: series.revision, expectedInstanceRevision: instance.revision } as RecurrenceExceptionPreviewInput;
    const preview = await this.previewException(instance.seriesId, instance.occurrenceKey, input);
    const applied = await this.setException(instance.seriesId, instance.occurrenceKey, { ...input, previewHash: preview.previewHash } as SetRecurrenceExceptionInput, key);
    return { input, preview, applied };
  }
  periodMeetings(projectId: string, plannedPeriodId: string, state: 'scheduled' | 'cancelled' | 'all' = 'all'): Promise<MeetingListItemDto[]> {
    return this.all(`/projects/${projectId}/meetings`, meetingListResponseSchema, { plannedPeriodId, state }, 100);
  }
  allPackages(projectId: string): Promise<PlanningPackageDto[]> {
    return this.all('/planning-packages', planningPackageListResponseSchema, { projectId }, 100);
  }
}

export function p3bClients(h: PlanningHarness) {
  const wrap = (client: P2aClient) => new P3bClient(client.api, client.workspaceId);
  return { owner: wrap(h.owner), replica: wrap(h.replica), member: wrap(h.member), viewer: wrap(h.viewer), outsider: wrap(h.outsider) };
}

export function sortByKey<T extends { readonly occurrenceKey: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey));
}
export function byKey<T extends { readonly occurrenceKey: string }>(items: readonly T[], occurrenceKey: string): T {
  const found = items.find(item => item.occurrenceKey === occurrenceKey);
  if (!found) throw new Error(`Occurrence ${occurrenceKey} required.`);
  return found;
}
export function one<T>(items: readonly T[]): T {
  const [item, ...extra] = items;
  if (item === undefined || extra.length > 0) throw new Error(`Expected exactly one item, got ${items.length}.`);
  return item;
}
/** The all-or-none real composition of a materialized header. */
export function located(instance: RecurrenceInstanceDto): LocatedInstance {
  const { meetingId, taskId, workPackageId } = instance;
  if (meetingId === null || taskId === null || workPackageId === null) throw new Error(`Occurrence ${instance.occurrenceKey} is not materialized.`);
  return { ...instance, meetingId, taskId, workPackageId };
}

export interface MaterializationRequestRow {
  readonly changeSeq: string;
  readonly schemaVersion: number;
  readonly payload: RecurrenceMaterializationRequestedPayload;
}
/** P0 outbox rows of the only subscribed type committed after `afterChangeSeq`; payloads parse strictly. */
export async function materializationRequests(sql: postgres.Sql, workspaceId: string, afterChangeSeq: string): Promise<MaterializationRequestRow[]> {
  const rows = await sql<{ change_seq: string; schema_version: number; payload: unknown }[]>`
    select change_seq::text as change_seq, schema_version, payload from outbox_events
    where workspace_id = ${workspaceId} and type = ${RECURRENCE_MATERIALIZATION_REQUESTED} and change_seq > ${afterChangeSeq}::text::bigint
    order by change_seq, event_ordinal`;
  return rows.map(row => ({ changeSeq: row.change_seq, schemaVersion: row.schema_version, payload: recurrenceMaterializationRequestedPayloadSchema.parse(row.payload) }));
}

/** A controlled rejection may keep only its tagged idempotent outcome: no state, event or change_seq. */
export async function expectOnlyIdempotency(sql: postgres.Sql, before: DatabaseSnapshot): Promise<void> {
  const after = await databaseSnapshot(sql);
  expect(changedTables(before, after).filter(table => table !== 'command_idempotency')).toEqual([]);
  expect(after.changeSeq).toEqual(before.changeSeq);
}

/** Actual PostgreSQL server clock plus `ms`, as an exact UTC instant. */
export async function pgClockPlus(sql: postgres.Sql, ms: number): Promise<string> {
  const [row] = await sql<{ epoch_ms: string }[]>`select extract(epoch from clock_timestamp()) * 1000 as epoch_ms`;
  return new Date(Number(row?.epoch_ms) + ms).toISOString();
}
export async function pgClockBefore(sql: postgres.Sql, instant: string): Promise<boolean> {
  const [row] = await sql<{ before: boolean }[]>`select clock_timestamp() < ${instant}::text::timestamptz as before`;
  return row?.before === true;
}
/** Bounded server-side wait until the PostgreSQL clock is past `instant`. */
export async function waitPastPgClock(sql: postgres.Sql, instant: string): Promise<void> {
  await sql`select pg_sleep(greatest(0, extract(epoch from (${instant}::text::timestamptz - clock_timestamp()))) + 0.025)`;
}
