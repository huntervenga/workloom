import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { cutoffGrantSchema, cutoffJobSchema, cutoffWorkerOutcomeSchema } from '@workloom/contracts';
import type { CutoffRepository, CutoffRequestRecord } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { planningCutoffAutomations as heads, planningCutoffGrantVersions as versions, planningCutoffRequests as requests, planBaselines } from '../schema.js';
import { createPlanningRepository } from '../repositories/planning-repository.js';
import { createRecurrenceRepository } from '../repositories/recurrence-repository.js';
const iso = (at: Date | null) => at?.toISOString() ?? null;
function requestRow(row: typeof requests.$inferSelect): CutoffRequestRecord {
  return { job: cutoffJobSchema.parse({ schemaVersion: 1, requestId: row.id, workspaceId: row.workspaceId, projectId: row.projectId, periodId: row.periodId, grantId: row.grantId, grantRevision: row.grantRevision, periodRevision: row.periodRevision, cutoffAt: row.cutoffAt.toISOString(), sourceManifestHash: row.sourceManifestHash }), payloadHash: row.payloadHash, reason: row.reason, createdAt: row.createdAt.toISOString(), requestedByUserId: row.requestedByUserId, source: row.source, changeSeq: row.changeSeq.toString(), supersededAt: iso(row.supersededAt), processedAt: iso(row.processedAt), result: row.result === null ? null : cutoffWorkerOutcomeSchema.parse(row.result) };
}
export function createCutoffRepository(db: WorkloomExecutor, readOnly = false): CutoffRepository {
  const planning = createPlanningRepository(db), recurrence = createRecurrenceRepository(db, { planning, readOnly });
  const writable = () => { if (readOnly) throw new Error('Cutoff read repositories cannot mutate.'); };
  return {
    access: planning.tasks.access, planning, recurrence,
    findIdempotency: planning.tasks.findIdempotency, insertIdempotency: async record => { writable(); await planning.tasks.insertIdempotency(record); },
    async currentGrant(ws, periodId) {
      const [found] = await db.select({ grant: versions }).from(heads).innerJoin(versions, and(eq(versions.workspaceId, heads.workspaceId), eq(versions.grantId, heads.grantId), eq(versions.revision, heads.currentRevision))).where(and(eq(heads.workspaceId, ws), eq(heads.periodId, periodId))).limit(1);
      if (!found) return null;
      const row = found.grant;
      return { ...cutoffGrantSchema.parse({ ...row, id: row.grantId, activatedAt: iso(row.activatedAt), recordedAt: row.recordedAt.toISOString() }), actorUserId: row.actorUserId, actorMembershipId: row.actorMembershipId, source: row.source, changeSeq: row.changeSeq.toString() };
    },
    async saveGrant(grant, previousRevision) {
      writable();
      await db.insert(versions).values({ workspaceId: grant.workspaceId, projectId: grant.projectId, periodId: grant.periodId, grantId: grant.id, revision: grant.revision, scope: grant.scope, state: grant.state, authorizerUserId: grant.authorizerUserId, authorizerMembershipId: grant.authorizerMembershipId, activatedAt: grant.activatedAt ? new Date(grant.activatedAt) : null, recordedAt: new Date(grant.recordedAt), actorUserId: grant.actorUserId, actorMembershipId: grant.actorMembershipId, source: grant.source, changeSeq: BigInt(grant.changeSeq) });
      if (previousRevision === 0) await db.insert(heads).values({ workspaceId: grant.workspaceId, projectId: grant.projectId, periodId: grant.periodId, grantId: grant.id, currentRevision: grant.revision, createdAt: new Date(grant.recordedAt), updatedAt: new Date(grant.recordedAt) });
      else {
        const rows = await db.update(heads).set({ currentRevision: grant.revision, updatedAt: new Date(grant.recordedAt) }).where(and(eq(heads.workspaceId, grant.workspaceId), eq(heads.periodId, grant.periodId), eq(heads.grantId, grant.id), eq(heads.currentRevision, previousRevision))).returning({ revision: heads.currentRevision });
        if (rows.length !== 1) throw new Error('Cutoff head changed inside the workspace barrier.');
      }
    },
    async request(ws, id) { const [row] = await db.select().from(requests).where(and(eq(requests.workspaceId, ws), eq(requests.id, id))).limit(1); return row ? requestRow(row) : null; },
    async latestRequest(ws, periodId, grant) {
      const [row] = await db.select().from(requests).where(and(eq(requests.workspaceId, ws), eq(requests.periodId, periodId), grant ? and(eq(requests.grantId, grant.id), eq(requests.grantRevision, grant.revision)) : undefined)).orderBy(desc(requests.changeSeq), desc(requests.id)).limit(1);
      return row ? requestRow(row) : null;
    },
    async latestCompletedRequest(ws, periodId, grant) { const [row] = await db.select().from(requests).where(and(eq(requests.workspaceId, ws), eq(requests.periodId, periodId), eq(requests.grantId, grant.id), eq(requests.grantRevision, grant.revision), isNotNull(requests.processedAt))).orderBy(desc(requests.changeSeq), desc(requests.id)).limit(1); return row ? requestRow(row) : null; },
    async liveRequest(ws, periodId) { const [row] = await db.select().from(requests).where(and(eq(requests.workspaceId, ws), eq(requests.periodId, periodId), isNull(requests.processedAt), isNull(requests.supersededAt))).limit(1); return row ? requestRow(row) : null; },
    async supersedeLive(ws, periodId, at) { writable(); await db.update(requests).set({ supersededAt: new Date(at) }).where(and(eq(requests.workspaceId, ws), eq(requests.periodId, periodId), isNull(requests.processedAt), isNull(requests.supersededAt))); },
    async insertRequest(record) {
      writable(); const job = record.job;
      await db.insert(requests).values({ workspaceId: job.workspaceId, id: job.requestId, projectId: job.projectId, periodId: job.periodId, grantId: job.grantId, grantRevision: job.grantRevision, periodRevision: job.periodRevision, cutoffAt: new Date(job.cutoffAt), sourceManifestHash: job.sourceManifestHash, payloadHash: record.payloadHash, reason: record.reason, createdAt: new Date(record.createdAt), requestedByUserId: record.requestedByUserId, source: record.source, changeSeq: BigInt(record.changeSeq) });
    },
    async completeRequest(ws, id, payloadHash, outcome, userId, membershipId) {
      writable();
      const rows = await db.update(requests).set({ processedAt: new Date(outcome.processedAt), processedActorUserId: userId, processedMembershipId: membershipId, result: outcome }).where(and(eq(requests.workspaceId, ws), eq(requests.id, id), eq(requests.payloadHash, payloadHash), isNull(requests.processedAt), isNull(requests.result))).returning({ id: requests.id });
      if (rows.length !== 1) throw new Error('Cutoff receipt changed inside the workspace barrier.');
    },
    async baselineHeader(ws, id) { const [row] = await db.select({ id: planBaselines.id, frozenAt: planBaselines.frozenAt, requestedCutoffAt: planBaselines.requestedCutoffAt }).from(planBaselines).where(and(eq(planBaselines.workspaceId, ws), eq(planBaselines.id, id))).limit(1); return row ? { id: row.id, frozenAt: row.frozenAt.toISOString(), requestedCutoffAt: row.requestedCutoffAt.toISOString() } : null; },
  };
}
