import { and, asc, eq, inArray } from 'drizzle-orm';
import { sharedActivitySchema, sharedActivityContributionSchema, sharedActivityHistorySchema, type SharedActivityDto } from '@workloom/contracts';
import { DomainError, type SharedActivityRepository } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { sharedActivities, sharedActivityVersions, sharedActivityContributions, sharedActivityContributionVersions } from '../schema.js';
export function createSharedActivityRepository(tx: WorkloomExecutor, workspaceId: string): SharedActivityRepository {
  return {
    async findByTask(taskId) { const [row] = await tx.select().from(sharedActivities).where(and(eq(sharedActivities.workspaceId, workspaceId), eq(sharedActivities.taskId, taskId))).limit(1); return row ? sharedActivitySchema.parse(row.document) : null; },
    async listForTasks(taskIds) {
      const result: SharedActivityDto[] = [];
      for (let start = 0; start < taskIds.length; start += 1000) {
        const rows = await tx.select().from(sharedActivities).where(and(eq(sharedActivities.workspaceId, workspaceId), inArray(sharedActivities.taskId, taskIds.slice(start, start + 1000)))).orderBy(asc(sharedActivities.taskId));
        result.push(...rows.map(row => sharedActivitySchema.parse(row.document)));
      }
      return result;
    },
    async contributions(activityId) { const rows = await tx.select().from(sharedActivityContributions).where(and(eq(sharedActivityContributions.workspaceId, workspaceId), eq(sharedActivityContributions.activityId, activityId))).orderBy(asc(sharedActivityContributions.id)).limit(1001); if (rows.length > 1000) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'A shared activity exceeds 1000 historical participants.'); return rows.map(row => sharedActivityContributionSchema.parse(row.document)); },
    async saveActivity(activity) {
      const value = { id: activity.id, workspaceId, projectId: activity.projectId, taskId: activity.taskId, revision: activity.revision, document: activity };
      if (activity.revision === 1) await tx.insert(sharedActivities).values(value);
      else { const changed = await tx.update(sharedActivities).set({ revision: activity.revision, document: activity }).where(and(eq(sharedActivities.workspaceId, workspaceId), eq(sharedActivities.id, activity.id), eq(sharedActivities.revision, activity.revision - 1))).returning({ id: sharedActivities.id }); if (changed.length !== 1) throw new DomainError('REVISION_CONFLICT', 'The shared activity changed.'); }
    },
    async saveContribution(contribution) {
      const value = { id: contribution.id, workspaceId, activityId: contribution.activityId, taskId: contribution.taskId, membershipId: contribution.membershipId, revision: contribution.revision, document: contribution };
      if (contribution.revision === 1) await tx.insert(sharedActivityContributions).values(value);
      else { const changed = await tx.update(sharedActivityContributions).set({ revision: contribution.revision, document: contribution }).where(and(eq(sharedActivityContributions.workspaceId, workspaceId), eq(sharedActivityContributions.id, contribution.id), eq(sharedActivityContributions.revision, contribution.revision - 1))).returning({ id: sharedActivityContributions.id }); if (changed.length !== 1) throw new DomainError('REVISION_CONFLICT', 'The personal contribution changed.'); }
    },
    async insertActivityVersion(activity, actorUserId, changeSeq) { await tx.insert(sharedActivityVersions).values({ workspaceId, activityId: activity.id, revision: activity.revision, document: activity, actorUserId, changeSeq: BigInt(changeSeq), recordedAt: new Date(activity.updatedAt) }); },
    async insertContributionVersion(version) { await tx.insert(sharedActivityContributionVersions).values({ id: version.id, workspaceId, activityId: version.contribution.activityId, contributionId: version.contribution.id, revision: version.contribution.revision, document: version, actorUserId: version.actorUserId, changeSeq: BigInt(version.changeSeq), recordedAt: new Date(version.recordedAt) }); },
    async history(activityId, contributionId) { const rows = await tx.select().from(sharedActivityContributionVersions).where(and(eq(sharedActivityContributionVersions.workspaceId, workspaceId), eq(sharedActivityContributionVersions.activityId, activityId), eq(sharedActivityContributionVersions.contributionId, contributionId))).orderBy(asc(sharedActivityContributionVersions.revision)).limit(5001); if (rows.length > 5000) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'This attendance history exceeds 5000 revisions.'); return rows.map(row => sharedActivityHistorySchema.parse(row.document)); },
  };
}
export async function loadSharedActivitySources(tx: WorkloomExecutor, workspaceId: string, taskIds: readonly string[]) {
  const repository = createSharedActivityRepository(tx, workspaceId), activities = await repository.listForTasks(taskIds), result = [];
  let total = 0;
  for (const activity of activities) { const contributions = await repository.contributions(activity.id); total += contributions.length; if (total > 50000) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The full shared activity source exceeds 50000 contributions.'); result.push({ activity, contributions }); }
  return result;
}

/** Duplication is intentionally independent; attendance sources are never silently cloned. */
export async function sharedActivityTaskIds(tx:WorkloomExecutor,workspaceId:string,taskIds:readonly string[]):Promise<string[]>{const rows=await createSharedActivityRepository(tx,workspaceId).listForTasks(taskIds);return rows.map(row=>row.taskId);}
