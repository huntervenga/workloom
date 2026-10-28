import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { createUserAvatarService, temporarilyUnavailableError, type AvatarRecord, type UserAvatarRepository } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { avatarStorageObjects as objects, users } from '../schema.js';

function repository(db: WorkloomExecutor): UserAvatarRepository {
  const retire = (id: string) => db.update(objects).set({ state: 'retired', cleanupAt: sql`clock_timestamp()` }).where(eq(objects.id, id));
  return {
    async user(id) { const [row] = await db.select({ id: users.id, avatarId: users.avatarId, avatarRevision: users.avatarRevision, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, id)); return row ?? null; },
    async find(id) {
      const [row] = await db.select().from(objects).where(eq(objects.id, id));
      return row ? { ...row, writeDeadline: row.writeDeadline.toISOString() } : null;
    },
    async canRead(viewerId, userId) {
      const rows = await db.execute(sql`select 1 from memberships v join memberships u on v.workspace_id = u.workspace_id
        where v.user_id = ${viewerId} and u.user_id = ${userId} and v.state = 'active' and u.state = 'active' limit 1`);
      return rows.length > 0;
    },
    async insert(row) {
      await db.insert(objects).values({ ...row, writeDeadline: new Date(row.writeDeadline), cleanupAt: new Date(Date.parse(row.writeDeadline) + 5 * 60_000) });
    },
    async activate(user, row) {
      const changed = await db.update(objects).set({ state: 'ready', versionId: row.versionId, cleanupAt: null })
        .where(and(eq(objects.id, row.id), eq(objects.userId, user.id), eq(objects.state, 'pending'), isNull(objects.leaseToken),
          sql`${objects.writeDeadline} > clock_timestamp()`)).returning({ id: objects.id });
      if (changed.length !== 1) throw temporarilyUnavailableError();
      await db.update(users).set({ avatarId: row.id, avatarRevision: user.avatarRevision + 1, updatedAt: sql`clock_timestamp()` }).where(eq(users.id, user.id));
      if (user.avatarId) await retire(user.avatarId);
    },
    async remove(user) {
      await db.update(users).set({ avatarId: null, avatarRevision: user.avatarRevision + 1, updatedAt: sql`clock_timestamp()` }).where(eq(users.id, user.id));
      if (user.avatarId) await retire(user.avatarId);
    },
  };
}
export interface AvatarCleanupJob { id: string; objectKey: string; versionId: string | null; leaseToken: string }
/** Profile writes serialize on the user, independently of workspace and theme settings revisions. */
export function createUserAvatarStore(source: Database | WorkloomExecutor) {
  const db = isDatabase(source) ? source.db : source;
  const application = createUserAvatarService({
    read: work => db.transaction(tx => work(repository(tx)), { isolationLevel: 'repeatable read', accessMode: 'read only' }),
    write: (userId, work) => db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5000'`);
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [clock] = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
      if (!clock) throw temporarilyUnavailableError();
      return work(repository(tx), new Date(clock.now));
    }),
  }, randomUUID);
  return {
    application,
    async recordStored(row: AvatarRecord, versionId: string | null) {
      await db.update(objects).set({ versionId }).where(and(eq(objects.id, row.id), eq(objects.storageId, row.storageId), eq(objects.objectKey, row.objectKey)));
    },
    async claimCleanup(storageId: string): Promise<AvatarCleanupJob[]> {
      const leaseToken = randomUUID();
      const rows = await db.execute<{ id: string; object_key: string; version_id: string | null }>(sql`
        with due as (select id from avatar_storage_objects where storage_id = ${storageId}
          and cleanup_at <= clock_timestamp() and (lease_until is null or lease_until < clock_timestamp())
          order by cleanup_at limit 10 for update skip locked)
        update avatar_storage_objects o set lease_until = clock_timestamp() + interval '2 minutes', lease_token = ${leaseToken}, state = 'retired'
          from due where o.id = due.id returning o.id, o.object_key, o.version_id`);
      return rows.map(row => ({ id: row.id, objectKey: row.object_key, versionId: row.version_id, leaseToken }));
    },
    async completeCleanup(job: AvatarCleanupJob, success: boolean) {
      await db.update(objects).set({ leaseToken: null, leaseUntil: null,
        cleanupAt: success ? sql`case when clock_timestamp() > ${objects.writeDeadline} + interval '24 hours' then null else clock_timestamp() + interval '1 hour' end`
          : sql`clock_timestamp() + interval '5 minutes'`,
      }).where(and(eq(objects.id, job.id), eq(objects.leaseToken, job.leaseToken), isNotNull(objects.cleanupAt)));
    },
  };
}
export type UserAvatarStore = ReturnType<typeof createUserAvatarStore>;
