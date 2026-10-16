import {authorizeWorkspace,createWorkCategoryApplication as createDomainWorkCategoryApplication,isDomainError,temporarilyUnavailableError,type WorkCategoryApplication,type WorkCategoryUnitOfWork} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {isDatabaseUnavailableError} from '../database-errors.js';
import {composeRecurrenceCensusScope,createRecurrenceRuntime} from '../recurrence/census-scope.js';
import {createWorkCategoryRepository} from '../repositories/work-category-repository.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from '../transactions/workspace-write.js';

export interface WorkCategoryApplicationOptions extends WorkspaceWriteOptions{readonly cursorSecret?:string}
/** Same database pool/barrier and mandatory same-TX recurrence census; category policy belongs to domain, not this adapter. */
export function createWorkCategoryApplication(source:Database|WorkloomExecutor,options:WorkCategoryApplicationOptions={}):WorkCategoryApplication{
 const {cursorSecret,...writeOptions}=options,runner=createWorkspaceWriteRunner(source,writeOptions),db=isDatabase(source)?source.db:source;
 const recurrence=createRecurrenceRuntime(cursorSecret===undefined?{}:{cursorSecret}),tools=recurrence.tools;
 const writer:WorkCategoryUnitOfWork={
  run(ctx,cap,work){return runner.run(ctx,cap,scope=>{const census=composeRecurrenceCensusScope(scope,recurrence),categoryScope={...census,categories:createWorkCategoryRepository(scope.tx)};return work(categoryScope);});},
  async read(ctx,cap,work){try{return await db.transaction(async tx=>{const repo=createWorkCategoryRepository(tx);await authorizeWorkspace(repo.planning.tasks.access,ctx,cap);return work(repo);},{isolationLevel:'repeatable read',accessMode:'read only'});}catch(error){if(!isDomainError(error)&&isDatabaseUnavailableError(error))throw temporarilyUnavailableError(error);throw error;}},
 };
 return createDomainWorkCategoryApplication({writer,tools});
}
