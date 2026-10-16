import {
  RECURRENCE_MATERIALIZATION_REQUESTED,
  RECURRENCE_MATERIALIZATION_SCHEMA_VERSION,
  recurrenceMaterializationRequestedEventSchema,
  type RecurrenceMaterializationRequestedEvent,
} from '@workloom/contracts';
import type { RecurrenceOutboxRelay, RecurrenceRelayBatchResult, RecurrenceRelayEnqueue } from '@workloom/domain';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { outboxEvents } from '../schema.js';

/**
 * Transactional relay of exactly `recurrence.materialization_requested` schemaVersion 1 (docs16 §0 п.6, §9).
 * One relay transaction selects bounded pending v1 rows FOR UPDATE SKIP LOCKED, hands each strictly parsed
 * event to `enqueue(tx, event)` (the pg-boss adapter on the SAME tx) and marks only that row dispatched.
 * Any enqueue/mark failure rolls back every enqueue and mark of the batch, so there is no source→queue gap.
 * Unrelated outbox types are never selected, locked, marked or counted. Unsupported versions and malformed
 * rows of the subscribed type (null/array/scalar/extra-key payloads, non-RFC IDs, unrepresentable times) are
 * excluded by an exact, NULL-safe SQL mirror of the zod event schema, so every selected row parses and no
 * poison row is re-selected ahead of valid v1 rows. They stay pending and are reported as retained/blocked
 * by batch results and health. Current source IDs/revisions are validated by the worker facade, not here.
 */
export const RECURRENCE_RELAY_DEFAULT_LIMIT = 50;
export const RECURRENCE_RELAY_MAX_LIMIT = 100;

export interface RecurrenceOutboxRelayOptions {
  /** Maximum wait for a lock inside the relay transaction. Default 5 s. */
  readonly lockTimeoutMs?: number;
  /** Maximum duration of any statement in the relay transaction. Default 15 s. */
  readonly statementTimeoutMs?: number;
}

/**
 * Exact SQL mirrors of the zod regexes the event schema applies (zod 4 `z.uuid()`: RFC 9562 versions 1–8 and
 * variant, either case, plus the lower-case nil/max literals; `recurrenceHashSchema`). Case-sensitive `~`, so the
 * literal alternatives match exactly what zod accepts. Kept in sync by outbox-relay.test.ts.
 */
export const RELAY_UUID_PATTERN =
  '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
export const RELAY_HASH_PATTERN = '^[0-9a-f]{64}$';
const MAX_SAFE_INTEGER = '9007199254740991';

const payload = outboxEvents.payload;
/** A JSON string that the zod UUID regex accepts; non-strings and absent keys are false, never NULL. */
const uuidString = (key: 'seriesId' | 'bindingId') => {
  const field = sql.raw(`'${key}'`);
  return sql`(case when jsonb_typeof(${payload}->${field}) = 'string' then (${payload}->>${field}) ~ ${RELAY_UUID_PATTERN} else false end)`;
};
/**
 * Strict four-key payload object. Every cast/set-returning call sits behind CASE and gets a safe input, so a
 * null/array/scalar payload is plain false. authorizationRevision is an exact JSON integer 1..2^53-1: `1.0`
 * (JSON.parse → 1) is accepted like zod's safe-integer check; `1.5`, `0`, strings and larger values are not.
 */
const payloadShape = sql`(case when jsonb_typeof(${payload}) = 'object' then
  (select count(*) from jsonb_object_keys(case when jsonb_typeof(${payload}) = 'object' then ${payload} else '{}'::jsonb end)) = 4
  and ${uuidString('seriesId')}
  and ${uuidString('bindingId')}
  and (case when jsonb_typeof(${payload}->'sourceManifestHash') = 'string' then (${payload}->>'sourceManifestHash') ~ ${RELAY_HASH_PATTERN} else false end)
  and (case when jsonb_typeof(${payload}->'authorizationRevision') = 'number' then
    (${payload}->'authorizationRevision')::numeric = trunc((${payload}->'authorizationRevision')::numeric)
    and (${payload}->'authorizationRevision')::numeric between 1 and ${sql.raw(MAX_SAFE_INTEGER)}
  else false end)
else false end)`;
/** Row identity the parser builds the event from: RFC event/workspace IDs and an occurredAt toISOString() renders. */
const identityShape = sql`(
  (${outboxEvents.id}::text) ~ ${RELAY_UUID_PATTERN}
  and (${outboxEvents.workspaceId}::text) ~ ${RELAY_UUID_PATTERN}
  and extract(year from ${outboxEvents.occurredAt} at time zone 'UTC') between 1 and 9999
)`;
const subscribedPending = and(isNull(outboxEvents.dispatchedAt), eq(outboxEvents.type, RECURRENCE_MATERIALIZATION_REQUESTED)) as SQL;
/** Never NULL: rows are either supported (selectable) or unsupported (retained, counted), never neither. */
const supported = sql`((${outboxEvents.schemaVersion} = ${RECURRENCE_MATERIALIZATION_SCHEMA_VERSION} and ${identityShape} and ${payloadShape}) is true)`;
/** Internal, for adapter tests only (not exported from the package index). */
export const RECURRENCE_RELAY_PREDICATES = { subscribedPending, supported } as const;

export function relayLimit(limit: number | undefined): number {
  const value = limit ?? RECURRENCE_RELAY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > RECURRENCE_RELAY_MAX_LIMIT) {
    throw new RangeError(`The relay limit must be an integer between 1 and ${RECURRENCE_RELAY_MAX_LIMIT}.`);
  }
  return value;
}

/** Strict v1 parse of one selected outbox row; null means fail closed (retained, counted). */
export function parseRelayRow(row: {
  id: string;
  workspaceId: string;
  type: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
}): RecurrenceMaterializationRequestedEvent | null {
  if (Number.isNaN(row.occurredAt.getTime())) return null;
  const parsed = recurrenceMaterializationRequestedEventSchema.safeParse({
    eventId: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    schemaVersion: row.schemaVersion,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

export function createRecurrenceOutboxRelay(
  source: Database | WorkloomExecutor,
  options: RecurrenceOutboxRelayOptions = {},
): RecurrenceOutboxRelay<WorkloomExecutor> {
  const db: WorkloomExecutor = isDatabase(source) ? source.db : source;
  const lockTimeoutMs = Math.max(1, Math.trunc(options.lockTimeoutMs ?? 5_000));
  const statementTimeoutMs = Math.max(1, Math.trunc(options.statementTimeoutMs ?? 15_000));

  /** Finite SET LOCAL bounds before the first SELECT; allowed in read-only transactions too. */
  async function boundTransaction(tx: WorkloomExecutor): Promise<void> {
    await tx.execute(sql`
      select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
             set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)
    `);
  }

  async function countRetained(tx: WorkloomExecutor): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(and(subscribedPending, sql`not ${supported}`));
    return row?.count ?? 0;
  }

  return {
    async relayBatch(enqueue: RecurrenceRelayEnqueue<WorkloomExecutor>, limit?: number): Promise<RecurrenceRelayBatchResult> {
      const bounded = relayLimit(limit);
      return db.transaction(async (tx) => {
        await boundTransaction(tx);
        const rows = await tx
          .select({
            id: outboxEvents.id,
            workspaceId: outboxEvents.workspaceId,
            type: outboxEvents.type,
            schemaVersion: outboxEvents.schemaVersion,
            payload: outboxEvents.payload,
            occurredAt: outboxEvents.occurredAt,
          })
          .from(outboxEvents)
          .where(and(subscribedPending, supported))
          .orderBy(asc(outboxEvents.occurredAt), asc(outboxEvents.id))
          .limit(bounded)
          .for('update', { skipLocked: true });

        let enqueuedCount = 0;
        let rejectedByParse = 0;
        for (const row of rows) {
          const event = parseRelayRow(row);
          if (event === null) {
            // Unreachable by construction (the SQL predicate mirrors the zod schema exactly). If the mirror ever
            // drifts, fail closed for this row only: never enqueued, never marked dispatched, still pending in
            // health (its age keeps growing, so the drift is visible) and reported as retained here.
            rejectedByParse += 1;
            continue;
          }
          const result = await enqueue(tx, event);
          if (result?.accepted !== true) {
            throw new Error('Recurrence relay enqueue did not accept the event; rolling back the relay batch.');
          }
          const marked = await tx
            .update(outboxEvents)
            .set({ dispatchedAt: sql`clock_timestamp()` })
            .where(
              and(
                eq(outboxEvents.id, row.id),
                isNull(outboxEvents.dispatchedAt),
                eq(outboxEvents.type, RECURRENCE_MATERIALIZATION_REQUESTED),
                eq(outboxEvents.schemaVersion, RECURRENCE_MATERIALIZATION_SCHEMA_VERSION),
              ),
            )
            .returning({ id: outboxEvents.id });
          if (marked.length !== 1) {
            throw new Error('Recurrence relay lost its selected outbox row; rolling back the relay batch.');
          }
          enqueuedCount += 1;
        }
        const unsupportedRetainedCount = (await countRetained(tx)) + rejectedByParse;
        return { selectedCount: rows.length, enqueuedCount, unsupportedRetainedCount };
      });
    },

    async getHealth() {
      return db.transaction(
        async (tx) => {
          await boundTransaction(tx);
          const [row] = await tx
            .select({
              pending: sql<number>`(count(*) filter (where ${supported}))::int`,
              unsupported: sql<number>`(count(*) filter (where not ${supported}))::int`,
              oldest: sql<string | null>`to_char(min(${outboxEvents.occurredAt}) filter (where ${supported}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
              ageMs: sql<number | null>`(floor(extract(epoch from (clock_timestamp() - min(${outboxEvents.occurredAt}) filter (where ${supported}))) * 1000))::float8`,
            })
            .from(outboxEvents)
            .where(subscribedPending);
          const ageMs = row?.ageMs === null || row?.ageMs === undefined ? null : Math.max(0, Number(row.ageMs));
          return {
            pendingSubscribedCount: row?.pending ?? 0,
            oldestSubscribedAt: row?.oldest ?? null,
            oldestSubscribedAgeMs: ageMs,
            unsupportedSubscribedCount: row?.unsupported ?? 0,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  };
}
