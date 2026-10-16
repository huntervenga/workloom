import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { CUTOFF_REQUESTED_EVENT, cutoffRequestedEventSchema } from '@workloom/contracts';
import type { CutoffOutboxRelay, CutoffRelayEnqueue } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { outboxEvents } from '../schema.js';
import { RELAY_UUID_PATTERN } from '../recurrence/outbox-relay.js';
const pending = and(isNull(outboxEvents.dispatchedAt), eq(outboxEvents.type, CUTOFF_REQUESTED_EVENT));
/** Only exact immutable persisted request payloads are selectable. No untrusted JSON casts are used.
 * Poison/null/array/unknown-version rows stay visible without starving later serviceable v1 events.
 */
const supported = sql`((
  ${outboxEvents.schemaVersion}=1 and (${outboxEvents.id}::text) ~ ${RELAY_UUID_PATTERN}
  and (${outboxEvents.workspaceId}::text) ~ ${RELAY_UUID_PATTERN}
  and isfinite(${outboxEvents.occurredAt}) and extract(year from ${outboxEvents.occurredAt} at time zone 'UTC') between 1 and 9999
  and exists(select 1 from planning_cutoff_requests cutoff_source
    where cutoff_source.workspace_id=${outboxEvents.workspaceId}
      and ${outboxEvents.payload}=jsonb_build_object(
        'requestId',cutoff_source.id,'projectId',cutoff_source.project_id,'periodId',cutoff_source.period_id,
        'grantId',cutoff_source.grant_id,'grantRevision',cutoff_source.grant_revision,'periodRevision',cutoff_source.period_revision,
        'cutoffAt',to_char(cutoff_source.cutoff_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'sourceManifestHash',cutoff_source.source_manifest_hash))
) is true)`;
export const CUTOFF_RELAY_PREDICATES = { pending, supported } as const;
export function createCutoffOutboxRelay(source: Database | WorkloomExecutor): CutoffOutboxRelay<WorkloomExecutor> {
  const db = isDatabase(source) ? source.db : source;
  async function bound(tx: WorkloomExecutor) { await tx.execute(sql`select set_config('lock_timeout','5000ms',true),set_config('statement_timeout','15000ms',true)`); }
  return {
    async relayBatch(enqueue: CutoffRelayEnqueue<WorkloomExecutor>, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Cutoff relay batch must be 1..100.');
      return db.transaction(async tx => {
        await bound(tx);
        const rows = await tx.select().from(outboxEvents).where(and(pending, supported)).orderBy(asc(outboxEvents.occurredAt), asc(outboxEvents.id)).limit(limit).for('update', { skipLocked: true });
        let enqueuedCount = 0;
        for (const row of rows) {
          const event = cutoffRequestedEventSchema.parse({ eventId: row.id, workspaceId: row.workspaceId, type: row.type, schemaVersion: row.schemaVersion, payload: row.payload, occurredAt: row.occurredAt.toISOString() });
          if ((await enqueue(tx, event)).accepted !== true) throw new Error('Cutoff relay enqueue was not accepted.');
          const marked = await tx.update(outboxEvents).set({ dispatchedAt: sql`clock_timestamp()` }).where(and(eq(outboxEvents.id, row.id), isNull(outboxEvents.dispatchedAt), eq(outboxEvents.type, CUTOFF_REQUESTED_EVENT), eq(outboxEvents.schemaVersion, 1))).returning({ id: outboxEvents.id });
          if (marked.length !== 1) throw new Error('Cutoff relay lost its outbox row.');
          enqueuedCount++;
        }
        const [retained] = await tx.select({ count: sql<number>`count(*)::int` }).from(outboxEvents).where(and(pending, sql`not ${supported}`));
        return { selectedCount: rows.length, enqueuedCount, unsupportedRetainedCount: retained?.count ?? 0 };
      });
    },
    async getHealth() {
      return db.transaction(async tx => {
        await bound(tx);
        const [row] = await tx.select({ pending: sql<number>`(count(*) filter(where ${supported}))::int`, unsupported: sql<number>`(count(*) filter(where not ${supported}))::int`, oldest: sql<string | null>`to_char(min(${outboxEvents.occurredAt}) filter(where ${supported}) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, ageMs: sql<number | null>`floor(extract(epoch from (clock_timestamp()-min(${outboxEvents.occurredAt}) filter(where ${supported})))*1000)::float8` }).from(outboxEvents).where(pending);
        return { pendingSubscribedCount: row?.pending ?? 0, unsupportedSubscribedCount: row?.unsupported ?? 0, oldestSubscribedAt: row?.oldest ?? null, oldestSubscribedAgeMs: row?.ageMs === null || row?.ageMs === undefined ? null : Math.max(0, Number(row.ageMs)) };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },
  };
}
