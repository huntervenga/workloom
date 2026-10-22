import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { authorizeWorkspace, createProjectCopyService, type CommandContext, type ProjectCopyApplication } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { createWorkCategoryApplication } from '../categories/work-category-application.js';
import { createTaskFieldApplication } from '../fields/task-field-application.js';
import { createGenericReportApplication } from '../generic-reports/application.js';
import { createPlanningCheckApplication } from '../planning-checks/application.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { createTaskDefaultsApplication } from '../task-defaults/application.js';
import { createTaskApplication } from '../tasks/task-application.js';

/** Copies a project's structure and settings by running the ordinary commands one after another (resumable by idempotency key). */
export function createProjectCopyApplication(source: Database | WorkloomExecutor): ProjectCopyApplication {
  const db = isDatabase(source) ? source.db : source;
  const service = createProjectCopyService({
    tasks: createTaskApplication(source), fields: createTaskFieldApplication(source), checks: createPlanningCheckApplication(source),
    reports: createGenericReportApplication(source), defaults: createTaskDefaultsApplication(source), categories: createWorkCategoryApplication(source),
    digest: value => createHash('sha256').update(value).digest('hex'),
  });
  return {
    async duplicateProject(context: CommandContext, sourceProjectId, input) {
      // Settings and fields are what a copy reproduces, so it needs the same authority as managing them: fail before anything is created.
      await db.transaction(async tx => { await tx.execute(sql`set local statement_timeout='15000'`); await authorizeWorkspace(createAccessRepository(tx), context, 'fields.manage'); }, { accessMode: 'read only' });
      return service.duplicateProject(context, sourceProjectId, input);
    },
  };
}
