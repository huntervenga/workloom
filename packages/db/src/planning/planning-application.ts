import {createWorkCategoryRepository} from '../repositories/work-category-repository.js';
import {createHash,randomUUID} from 'node:crypto';
import {
  authorizeWorkspace,createWorkCategoryResolver,createPlanningApplication as createDomainPlanningApplication,
  isDomainError,temporarilyUnavailableError,
  type PlanningApplication,type PlanningTools,type PlanningUnitOfWork,
} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {isDatabaseUnavailableError} from '../database-errors.js';
import {createPlanningRepository} from '../repositories/planning-repository.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from '../transactions/workspace-write.js';
import {createPlanningCursorCodec} from './cursor.js';

export interface PlanningApplicationOptions extends WorkspaceWriteOptions {readonly cursorSecret?:string}
/** The same pool and workspace barrier as all task/field commands; no optional cutoff bypass. */
export function createPlanningApplication(source:Database|WorkloomExecutor,options:PlanningApplicationOptions={}):PlanningApplication {
  const {cursorSecret,...writeOptions}=options,runner=createWorkspaceWriteRunner(source,writeOptions),db=isDatabase(source)?source.db:source;
  const codec=createPlanningCursorCodec(cursorSecret===undefined?{}:{secret:cursorSecret});
  const tools:PlanningTools={newId:()=>randomUUID(),digest:v=>createHash('sha256').update(v,'utf8').digest('hex'),encodeCursor:v=>codec.encode(v),decodeCursor:v=>codec.decode(v)};
  const writer:PlanningUnitOfWork={
    run(ctx,cap,work) {return runner.run(ctx,cap,scope=>work({...scope,repository:createPlanningRepository(scope.tx),categoryResolver:createWorkCategoryResolver(createWorkCategoryRepository(scope.tx),ctx.workspaceId)}));},
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
