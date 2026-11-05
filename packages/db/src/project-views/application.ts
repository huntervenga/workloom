import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { projectViewsSchema } from '@workloom/contracts';
import {
  authorizeWorkspace, createPlanningMutationGuard, createProjectViewsService,
  type ProjectViewsApplication, type ProjectViewsScope,
} from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createTaskFieldRepository } from '../repositories/task-field-repository.js';
import { projectViews } from '../schema.js';
import { createWorkspaceWriteRunner, type DbWorkspaceWriteScope } from '../transactions/workspace-write.js';

export function createProjectViewsApplication(source: Database | WorkloomExecutor): ProjectViewsApplication {
  const db = isDatabase(source) ? source.db : source, writer = createWorkspaceWriteRunner(source);
  const tools = { newId: randomUUID, digest: (value: string) => createHash('sha256').update(value).digest('hex') };
  const recurrence = createRecurrenceRuntime();
  const compose = (scope: DbWorkspaceWriteScope): ProjectViewsScope => {
    const { tx, context: { workspaceId } } = scope;
    return { ...scope, repository: createTaskFieldRepository(tx),
      planningGuard: createPlanningMutationGuard(composeRecurrenceCensusScope(scope, recurrence), tools),
      views: {
        async get(projectId) {
          const [row] = await tx.select().from(projectViews)
            .where(and(eq(projectViews.workspaceId, workspaceId), eq(projectViews.projectId, projectId))).limit(1);
          return row ? projectViewsSchema.parse({ workspaceId, projectId, revision: row.revision, views: row.views })
            : { workspaceId, projectId, revision: 0, views: [] };
        },
        async save(value, at) {
          const updatedAt = new Date(at);
          await tx.insert(projectViews).values({ ...value, updatedAt })
            .onConflictDoUpdate({ target: [projectViews.workspaceId, projectViews.projectId],
              set: { revision: value.revision, views: value.views, updatedAt } });
        },
      },
    };
  };
  return createProjectViewsService({
    digest: tools.digest,
    write: (context, capability, work) => writer.run(context, capability, scope => work(compose(scope))),
    read: (context, capability, work) => db.transaction(async tx => {
      const access = await authorizeWorkspace(createTaskFieldRepository(tx).tasks.access, context, capability);
      return work(compose({ tx, context, access, barrierAt: new Date(), recordChange: async () => { throw new Error('A view read cannot write.'); } }));
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' }),
  });
}
