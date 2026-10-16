import {
  authorizeWorkspace,createPlanningApplication as createDomainPlanningApplication,
  isDomainError,temporarilyUnavailableError,
  type PlanningApplication,type PlanningUnitOfWork,
} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {isDatabaseUnavailableError} from '../database-errors.js';
import {composeRecurrenceCensusScope,createRecurrenceRuntime} from '../recurrence/census-scope.js';
import {createPlanningRepository} from '../repositories/planning-repository.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from '../transactions/workspace-write.js';

export interface PlanningApplicationOptions extends WorkspaceWriteOptions {readonly cursorSecret?:string}
/** The same pool and workspace barrier as all task/field commands; no optional cutoff bypass.
 * Every write scope carries the mandatory same-TX recurrence census used by the guard and performFreeze. */
export function createPlanningApplication(source:Database|WorkloomExecutor,options:PlanningApplicationOptions={}):PlanningApplication {
  const {cursorSecret,...writeOptions}=options,runner=createWorkspaceWriteRunner(source,writeOptions),db=isDatabase(source)?source.db:source;
  const recurrence=createRecurrenceRuntime(cursorSecret===undefined?{}:{cursorSecret}),tools=recurrence.tools;
  const writer:PlanningUnitOfWork={
    run(ctx,cap,work) {return runner.run(ctx,cap,scope=>{const census=composeRecurrenceCensusScope(scope,recurrence);return work(census);});},
    async read(ctx,cap,work) {
      try {
        return await db.transaction(async tx=>{
          const repo=createPlanningRepository(tx);await authorizeWorkspace(repo.tasks.access,ctx,cap);return work(repo);
        },{isolationLevel:'repeatable read',accessMode:'read only'});
      }catch(error) {if(!isDomainError(error)&&isDatabaseUnavailableError(error))throw temporarilyUnavailableError(error);throw error;}
    },
  };
  return createDomainPlanningApplication({reader:createPlanningRepository(source),writer,tools});
}
