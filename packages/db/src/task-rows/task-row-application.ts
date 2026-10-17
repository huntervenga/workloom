import {createTaskRowApplication as createDomainTaskRowApplication,type TaskRowApplication,type TaskRowUnitOfWork} from '@workloom/domain';
import type {Database,WorkloomExecutor} from '../client.js';
import {composeRecurrenceCensusScope,createRecurrenceRuntime} from '../recurrence/census-scope.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from '../transactions/workspace-write.js';

/** Atomic table row on the shared pool and workspace barrier: one runner transaction carries the task, field,
 * planning, category and recurrence census repositories, so every proposed write and the receipt commit or roll back together. */
export function createTaskRowApplication(source:Database|WorkloomExecutor,options:WorkspaceWriteOptions={}):TaskRowApplication {
  const runner=createWorkspaceWriteRunner(source,options),runtime=createRecurrenceRuntime();
  const writer:TaskRowUnitOfWork={run(ctx,cap,work){return runner.run(ctx,cap,scope=>work(composeRecurrenceCensusScope(scope,runtime)));}};
  return createDomainTaskRowApplication({writer,tools:{newId:runtime.tools.newId,digest:runtime.tools.digest}});
}
