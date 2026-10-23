import { createHash } from 'node:crypto';
import { duplicateProjectInputSchema, duplicateProjectResultSchema, idSchema } from '@workloom/contracts';
import { DomainError, notFoundError, createProjectCopyService, type CommandContext, type ProjectCopyApplication } from '@workloom/domain';
import { type Database, type WorkloomExecutor } from '../client.js';
import { createWorkCategoryApplication } from '../categories/work-category-application.js';
import { createTaskFieldApplication } from '../fields/task-field-application.js';
import { createGenericReportApplication } from '../generic-reports/application.js';
import { createPlanningCheckApplication } from '../planning-checks/application.js';
import { createTaskRepository } from '../repositories/task-repository.js';
import { resumableWorkflow } from '../workflows/resumable.js';
import { createProjectRulesApplication } from '../project-rules/application.js';
import { createTaskDefaultsApplication } from '../task-defaults/application.js';
import { createTaskApplication } from '../tasks/task-application.js';

/** Copies a project's structure and settings by running the ordinary commands one after another (resumable by idempotency key). */
export function createProjectCopyApplication(source: Database | WorkloomExecutor): ProjectCopyApplication {
  const service = createProjectCopyService({
    tasks: createTaskApplication(source), fields: createTaskFieldApplication(source), checks: createPlanningCheckApplication(source),
    reports: createGenericReportApplication(source), defaults: createTaskDefaultsApplication(source), rules: createProjectRulesApplication(source), categories: createWorkCategoryApplication(source),
    digest: value => createHash('sha256').update(value).digest('hex'),
  });
  return {
    async duplicateProject(context: CommandContext, sourceProjectId, input) {
      const id=idSchema.safeParse(sourceProjectId),parsed=duplicateProjectInputSchema.safeParse(input);
      if(!id.success||!parsed.success)throw new DomainError('VALIDATION_FAILED','Invalid project copy request.');
      return resumableWorkflow(source,context,{command:'project.duplicate',capability:'fields.manage',input:{projectId:id.data,input:parsed.data},schema:duplicateProjectResultSchema,
        authorize:async scope=>{if(!await createTaskRepository(scope.tx).findProject(context.workspaceId,id.data))throw notFoundError();},
        work:()=>service.duplicateProject(context,id.data,parsed.data)});
    },
  };
}
