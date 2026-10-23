import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { EMPTY_PROJECT_RULES, projectRulesSchema, type ProjectRulesDto } from '@workloom/contracts';
import {
  authorizeWorkspace, createPlanningMutationGuard, createProjectRulesService, notFoundError, temporarilyUnavailableError,
  type CommandContext, type ProjectRulesApplication, type ProjectRulesRepository, type ProjectRulesScope,
} from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { createTaskFieldRepository } from '../repositories/task-field-repository.js';
import { projectRules, workspaces } from '../schema.js';
import { createWorkspaceWriteRunner, type DbWorkspaceWriteScope } from '../transactions/workspace-write.js';

export function createProjectRulesRepository(tx: WorkloomExecutor, workspaceId: string): ProjectRulesRepository {
  return {
    async get(projectId) {
      const [row] = await tx.select().from(projectRules).where(and(eq(projectRules.workspaceId, workspaceId), eq(projectRules.projectId, projectId))).limit(1);
      return row ? projectRulesSchema.parse({ workspaceId, projectId, revision: row.revision, config: row.config }) : { workspaceId, projectId, revision: 0, config: { ...EMPTY_PROJECT_RULES } };
    },
    async save(value: ProjectRulesDto, at: string) {
      await tx.insert(projectRules).values({ workspaceId, projectId: value.projectId, revision: value.revision, config: value.config, updatedAt: new Date(at) })
        .onConflictDoUpdate({ target: [projectRules.workspaceId, projectRules.projectId], set: { revision: value.revision, config: value.config, updatedAt: new Date(at) } });
    },
  };
}

export function createProjectRulesApplication(source: Database | WorkloomExecutor): ProjectRulesApplication {
  const db = isDatabase(source) ? source.db : source, writer = createWorkspaceWriteRunner(source);
  const tools = { newId: randomUUID, digest: (value: string) => createHash('sha256').update(value).digest('hex') };
  const recurrence = createRecurrenceRuntime();
  const compose = (scope: DbWorkspaceWriteScope): ProjectRulesScope => ({
    ...scope, repository: createTaskFieldRepository(scope.tx), rules: createProjectRulesRepository(scope.tx, scope.context.workspaceId),
    planningGuard: createPlanningMutationGuard(composeRecurrenceCensusScope(scope, recurrence), tools),
  });
  return createProjectRulesService({
    digest: tools.digest,
    write: (context, capability, work) => writer.run(context, capability, scope => work(compose(scope))),
    read: (context: CommandContext, capability, work) => db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='15000'`); await tx.execute(sql`set local lock_timeout='5000'`);
      await authorizeWorkspace(createAccessRepository(tx), context, capability);
      const locked = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, context.workspaceId)).for('share');
      if (!locked.length) throw notFoundError();
      const access = await authorizeWorkspace(createAccessRepository(tx), context, capability);
      return work(compose({ tx, context, access, barrierAt: new Date(), recordChange: async () => { throw new Error('Reading project rules cannot record a change.'); } }));
    }, { isolationLevel: 'read committed' }).catch((error: unknown) => { if (isDatabaseUnavailableError(error)) throw temporarilyUnavailableError(); throw error; }),
  });
}
