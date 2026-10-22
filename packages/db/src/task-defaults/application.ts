import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { EMPTY_TASK_DEFAULTS, taskDefaultsSchema, type TaskDefaultsDto } from '@workloom/contracts';
import {
  authorizeWorkspace, createPlanningMutationGuard, createTaskDefaultsService, notFoundError, temporarilyUnavailableError,
  type CommandContext, type TaskDefaultsApplication, type TaskDefaultsRepository, type TaskDefaultsScope,
} from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { createTaskFieldRepository } from '../repositories/task-field-repository.js';
import { projectTaskDefaults, workspaces } from '../schema.js';
import { createWorkspaceWriteRunner, type DbWorkspaceWriteScope } from '../transactions/workspace-write.js';

export function createTaskDefaultsRepository(tx: WorkloomExecutor, workspaceId: string): TaskDefaultsRepository {
  return {
    async get(projectId) {
      const [row] = await tx.select().from(projectTaskDefaults).where(and(eq(projectTaskDefaults.workspaceId, workspaceId), eq(projectTaskDefaults.projectId, projectId))).limit(1);
      return row ? taskDefaultsSchema.parse({ workspaceId, projectId, revision: row.revision, config: row.config }) : { workspaceId, projectId, revision: 0, config: { ...EMPTY_TASK_DEFAULTS, fieldValues: [] } };
    },
    async save(value: TaskDefaultsDto, at: string) {
      await tx.insert(projectTaskDefaults).values({ workspaceId, projectId: value.projectId, revision: value.revision, config: value.config, updatedAt: new Date(at) })
        .onConflictDoUpdate({ target: [projectTaskDefaults.workspaceId, projectTaskDefaults.projectId], set: { revision: value.revision, config: value.config, updatedAt: new Date(at) } });
    },
  };
}

export function createTaskDefaultsApplication(source: Database | WorkloomExecutor): TaskDefaultsApplication {
  const db = isDatabase(source) ? source.db : source, writer = createWorkspaceWriteRunner(source);
  const tools = { newId: randomUUID, digest: (value: string) => createHash('sha256').update(value).digest('hex') };
  const recurrence = createRecurrenceRuntime();
  const compose = (scope: DbWorkspaceWriteScope): TaskDefaultsScope => ({
    ...scope, repository: createTaskFieldRepository(scope.tx), defaults: createTaskDefaultsRepository(scope.tx, scope.context.workspaceId),
    planningGuard: createPlanningMutationGuard(composeRecurrenceCensusScope(scope, recurrence), tools),
  });
  return createTaskDefaultsService({
    digest: tools.digest,
    write: (context, capability, work) => writer.run(context, capability, scope => work(compose(scope))),
    read: (context: CommandContext, capability, work) => db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='15000'`); await tx.execute(sql`set local lock_timeout='5000'`);
      await authorizeWorkspace(createAccessRepository(tx), context, capability);
      const locked = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, context.workspaceId)).for('share');
      if (!locked.length) throw notFoundError();
      const access = await authorizeWorkspace(createAccessRepository(tx), context, capability);
      return work(compose({ tx, context, access, barrierAt: new Date(), recordChange: async () => { throw new Error('Reading task defaults cannot record a change.'); } }));
    }, { isolationLevel: 'read committed' }).catch((error: unknown) => { if (isDatabaseUnavailableError(error)) throw temporarilyUnavailableError(); throw error; }),
  });
}
