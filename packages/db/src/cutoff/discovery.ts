import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { CUTOFF_LIMITS } from '@workloom/contracts';
import type { CutoffDiscovery, CutoffDiscoveryTarget } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { planningCutoffAutomations as heads, planningCutoffGrantVersions as grants, planningCutoffDiscoveryState as checkpoints, planningPeriods as periods } from '../schema.js';
import { createCutoffDueRequester } from './worker-facade.js';
const KEY = 'project_cutoff.v1';
/** A durable seek sweep. Target requests commit before checkpoint advancement; crash repeats are deduplicated. */
export function createCutoffDiscovery(source: Database | WorkloomExecutor): CutoffDiscovery {
  const db = isDatabase(source) ? source.db : source, requestDue = createCutoffDueRequester(source);
  async function bound(tx: WorkloomExecutor) { await tx.execute(sql`select set_config('lock_timeout','5000ms',true), set_config('statement_timeout','15000ms',true)`); }
  return { async discoverBatch(limit = CUTOFF_LIMITS.discoveryBatch) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CUTOFF_LIMITS.maxDiscoveryBatch) throw new RangeError('Cutoff discovery batch must be 1..100.');
    const owner = randomUUID();
    const lease = await db.transaction(async tx => {
      await bound(tx);
      await tx.insert(checkpoints).values({ key: KEY, revision: 1, cycleAt: sql`clock_timestamp()` }).onConflictDoNothing();
      const [row] = await tx.update(checkpoints).set({ leaseOwner: owner, leaseUntil: sql`clock_timestamp()+interval '60 seconds'`, revision: sql`${checkpoints.revision}+1` }).where(and(eq(checkpoints.key, KEY), sql`(${checkpoints.leaseUntil} is null or ${checkpoints.leaseUntil}<clock_timestamp())`)).returning();
      return row ?? null;
    });
    if (!lease) return { selectedCount: 0, requestedCount: 0, blockedCount: 0, cycleComplete: false, leased: false };
    let requestedCount = 0, blockedCount = 0;
    try {
      const targets = await db.transaction(async tx => {
        await bound(tx);
        return tx.select({ workspaceId: periods.workspaceId, projectId: periods.projectId, periodId: periods.id, cutoffAt: periods.cutoffAt })
          .from(periods).innerJoin(heads, and(eq(heads.workspaceId, periods.workspaceId), eq(heads.periodId, periods.id)))
          .innerJoin(grants, and(eq(grants.workspaceId, heads.workspaceId), eq(grants.grantId, heads.grantId), eq(grants.revision, heads.currentRevision)))
          .where(and(eq(periods.state, 'planning'), eq(grants.state, 'active'), lte(periods.cutoffAt, lease.cycleAt), lease.afterCutoffAt && lease.afterPeriodId ? or(gt(periods.cutoffAt, lease.afterCutoffAt), and(eq(periods.cutoffAt, lease.afterCutoffAt), gt(periods.id, lease.afterPeriodId))) : undefined))
          .orderBy(asc(periods.cutoffAt), asc(periods.id)).limit(limit);
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
      for (const target of targets) {
        const input: CutoffDiscoveryTarget = { ...target, cutoffAt: target.cutoffAt.toISOString() };
        const outcome = await requestDue(input);
        if (outcome === 'requested') requestedCount++; else if (outcome === 'blocked') blockedCount++;
        // A lost lease may finish its already-open target UOW, but must never advance a newer owner's cursor.
        const renewed = await db.transaction(async tx => { await bound(tx); return tx.update(checkpoints).set({ leaseUntil: sql`clock_timestamp()+interval '60 seconds'` }).where(and(eq(checkpoints.key, KEY), eq(checkpoints.leaseOwner, owner), eq(checkpoints.revision, lease.revision))).returning({ key: checkpoints.key }); });
        if (renewed.length !== 1) return { selectedCount: targets.length, requestedCount, blockedCount, cycleComplete: false, leased: false };
      }
      const last = targets.at(-1), complete = targets.length < limit;
      const advanced = await db.transaction(async tx => {
        await bound(tx);
        return tx.update(checkpoints).set({ ...(complete ? { cycleAt: sql`clock_timestamp()`, afterCutoffAt: null, afterPeriodId: null, completedAt: sql`clock_timestamp()` } : { afterCutoffAt: last?.cutoffAt ?? null, afterPeriodId: last?.periodId ?? null }), leaseOwner: null, leaseUntil: null, revision: sql`${checkpoints.revision}+1` }).where(and(eq(checkpoints.key, KEY), eq(checkpoints.leaseOwner, owner), eq(checkpoints.revision, lease.revision))).returning({ key: checkpoints.key });
      });
      return { selectedCount: targets.length, requestedCount, blockedCount, cycleComplete: advanced.length === 1 && complete, leased: advanced.length === 1 };
    } catch (error) {
      // Leave the seek cursor in place. Already committed requests are safe to encounter again.
      await db.transaction(async tx => { await bound(tx); await tx.update(checkpoints).set({ leaseOwner: null, leaseUntil: null }).where(and(eq(checkpoints.key, KEY), eq(checkpoints.leaseOwner, owner), eq(checkpoints.revision, lease.revision))); }).catch(() => undefined);
      throw error;
    }
  } };
}
