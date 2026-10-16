import {createHash,randomUUID} from 'node:crypto';
import {authorizeWorkspace,createDependencyApplication as createDomainDependencyApplication,isDomainError,temporarilyUnavailableError,type DependencyApplication,type DependencyUnitOfWork} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {isDatabaseUnavailableError} from '../database-errors.js';
import {createDependencyRepository} from '../repositories/dependency-repository.js';
import {composeRecurrenceCensusScope,createRecurrenceRuntime} from '../recurrence/census-scope.js';
import {createPlanningCursorCodec} from '../planning/cursor.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from '../transactions/workspace-write.js';
export interface DependencyApplicationOptions extends WorkspaceWriteOptions {readonly cursorSecret?:string}
/** One existing pool, same workspace barrier, current authorization and repeatable read projections. */
export function createDependencyApplication(source:Database|WorkloomExecutor,options:DependencyApplicationOptions={}):DependencyApplication {
 const {cursorSecret,...writeOptions}=options,db=isDatabase(source)?source.db:source,runner=createWorkspaceWriteRunner(source,writeOptions),codec=createPlanningCursorCodec(cursorSecret===undefined?{}:{secret:cursorSecret}),runtime=createRecurrenceRuntime(cursorSecret===undefined?{}:{cursorSecret});
 const writer:DependencyUnitOfWork={
  run(ctx,cap,work){return runner.run(ctx,cap,scope=>{const census=composeRecurrenceCensusScope(scope,runtime);return work({...census,dependencies:createDependencyRepository(scope.tx)});});},
  async read(ctx,cap,work){try{return await db.transaction(async tx=>{const repo=createDependencyRepository(tx),access=await authorizeWorkspace(repo.tasks.access,ctx,cap);return work(repo,access);},{isolationLevel:'repeatable read',accessMode:'read only'});}catch(error){if(!isDomainError(error)&&isDatabaseUnavailableError(error))throw temporarilyUnavailableError(error);throw error;}},
 };
 return createDomainDependencyApplication({writer,tools:{newId:()=>randomUUID(),digest:v=>createHash('sha256').update(v,'utf8').digest('hex'),encodeCursor:p=>codec.encode(p),decodeCursor:t=>codec.decode(t)}});
}
