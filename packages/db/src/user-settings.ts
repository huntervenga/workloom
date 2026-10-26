import { userPreferencesSchema, type UserSettingsDto } from '@workloom/contracts';
import { createUserSettingsService, type UserSettingsApplication, type UserSettingsRepository } from '@workloom/domain';
import { eq } from 'drizzle-orm';
import { isDatabase, type Database, type WorkloomExecutor } from './client.js';
import { users, userSettings } from './schema.js';

function repository(db: WorkloomExecutor, lock: boolean): UserSettingsRepository {
  return {
    async userExists(userId) {
      const query = db.select({ id: users.id }).from(users).where(eq(users.id, userId));
      return (await (lock ? query.for('update') : query)).length === 1;
    },
    async get(userId): Promise<UserSettingsDto | null> {
      const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
      return row ? { userId: row.userId, revision: row.revision, settings: userPreferencesSchema.parse(row.settings), updatedAt: row.updatedAt.toISOString() } : null;
    },
    async put(value) {
      const row = { userId: value.userId, revision: value.revision, settings: value.settings, updatedAt: new Date(value.updatedAt ?? '') };
      await db.insert(userSettings).values(row).onConflictDoUpdate({ target: userSettings.userId, set: { revision: row.revision, settings: row.settings, updatedAt: row.updatedAt } });
    },
  };
}
export function createUserSettingsApplication(source: Database | WorkloomExecutor): UserSettingsApplication {
  const db = isDatabase(source) ? source.db : source;
  return createUserSettingsService({
    read: work => db.transaction(tx => work(repository(tx, false)), { isolationLevel: 'repeatable read', accessMode: 'read only' }),
    write: work => db.transaction(tx => work(repository(tx, true))),
  });
}
