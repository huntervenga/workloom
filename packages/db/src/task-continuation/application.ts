import { createHash } from 'node:crypto';
import { continueTaskInputSchema, continueTaskResultSchema, idSchema } from '@workloom/contracts';
import { DomainError, notFoundError, createTaskContinuationService, type TaskContinuationApplication } from '@workloom/domain';
import type { Database, WorkloomExecutor } from '../client.js';
import { createDependencyApplication } from '../dependencies/dependency-application.js';
import { createTaskFieldApplication } from '../fields/task-field-application.js';
import { createTaskDefaultsApplication } from '../task-defaults/application.js';
import { createTaskApplication } from '../tasks/task-application.js';
import { createTaskRepository } from '../repositories/task-repository.js';
import { resumableWorkflow } from '../workflows/resumable.js';

export function createTaskContinuationApplication(source: Database | WorkloomExecutor): TaskContinuationApplication {
  const service=createTaskContinuationService({
    tasks: createTaskApplication(source), fields: createTaskFieldApplication(source), dependencies: createDependencyApplication(source), defaults: createTaskDefaultsApplication(source),
    digest: value => createHash('sha256').update(value).digest('hex'),
  });
  return {async continueTask(context,taskId,input){
    const id=idSchema.safeParse(taskId),parsed=continueTaskInputSchema.safeParse(input);
    if(!id.success||!parsed.success)throw new DomainError('VALIDATION_FAILED','Invalid continuation request.');
    return resumableWorkflow(source,context,{command:'task.continue',capability:'task.edit',input:{taskId:id.data,input:parsed.data},schema:continueTaskResultSchema,
      authorize:async scope=>{if(!await createTaskRepository(scope.tx).findTask(context.workspaceId,id.data))throw notFoundError();},
      work:()=>service.continueTask(context,id.data,parsed.data)});
  }};
}
