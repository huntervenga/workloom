import { and, eq, inArray } from 'drizzle-orm';
import { personalTablePreferenceSchema } from '@workloom/contracts';
import type { PersonalTablePreferenceRepository } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { personalTablePreferences, projects, taskFieldDefinitions } from '../schema.js';
import { createTaskRepository } from '../repositories/task-repository.js';
export function createPersonalTablePreferenceRepository(db: WorkloomExecutor): PersonalTablePreferenceRepository {
  const tasks = createTaskRepository(db);
  return {
    access: tasks.access, findIdempotency: tasks.findIdempotency, insertIdempotency: tasks.insertIdempotency,
    async projectExists(workspaceId, projectId) { return (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId))).limit(1)).length === 1; },
    async ownFieldIds(workspaceId, projectId, fieldIds) {
      if (fieldIds.length > 200) throw new TypeError('Personal table custom column checks are bounded to 200 IDs.');
      if (!fieldIds.length) return [];
      // Archived own fields remain valid; their display/editability is a separate UI decision.
      return (await db.select({ id: taskFieldDefinitions.id }).from(taskFieldDefinitions).where(and(eq(taskFieldDefinitions.workspaceId, workspaceId), eq(taskFieldDefinitions.projectId, projectId), inArray(taskFieldDefinitions.id, [...fieldIds])))).map(row => row.id);
    },
    async findPreference(workspaceId, projectId, membershipId) {
      const [row] = await db.select({ workspaceId: personalTablePreferences.workspaceId, projectId: personalTablePreferences.projectId, membershipId: personalTablePreferences.membershipId, revision: personalTablePreferences.revision, columns: personalTablePreferences.columns }).from(personalTablePreferences).where(and(eq(personalTablePreferences.workspaceId, workspaceId), eq(personalTablePreferences.projectId, projectId), eq(personalTablePreferences.membershipId, membershipId))).limit(1);
      return row ? personalTablePreferenceSchema.parse(row) : null;
    },
    async savePreference(preference, updatedAt, exists) {
      const row = { ...preference, updatedAt: new Date(updatedAt) };
      if (!exists) { await db.insert(personalTablePreferences).values(row); return; }
      const updated = await db.update(personalTablePreferences).set({ revision: row.revision, columns: row.columns, updatedAt: row.updatedAt }).where(and(eq(personalTablePreferences.workspaceId, row.workspaceId), eq(personalTablePreferences.projectId, row.projectId), eq(personalTablePreferences.membershipId, row.membershipId), eq(personalTablePreferences.revision, row.revision - 1))).returning({ revision: personalTablePreferences.revision });
      if (updated.length !== 1) throw new Error('Personal table preference changed inside its workspace write barrier.');
    },
  };
}
