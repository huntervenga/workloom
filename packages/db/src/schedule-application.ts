import {sql} from 'drizzle-orm';
import {createHash,randomUUID} from 'node:crypto';
import {authorizeWorkspace,createTaskScheduleApplication as createDomainTaskScheduleApplication,isDomainError,temporarilyUnavailableError,type TaskScheduleApplication,type TaskScheduleUnitOfWork} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from './client.js';
import {isDatabaseUnavailableError} from './database-errors.js';
import {createDependencyRepository} from './repositories/dependency-repository.js';
import {composeRecurrenceCensusScope,createRecurrenceRuntime} from './recurrence/census-scope.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from './transactions/workspace-write.js';
/** Same pool, mandatory barrier/census and repeatable read-only previews. No public command recursion. */
export function createTaskScheduleApplication(source:Database|WorkloomExecutor,options:WorkspaceWriteOptions={}):TaskScheduleApplication {
 const db=isDatabase(source)?source.db:source,runner=createWorkspaceWriteRunner(source,options),runtime=createRecurrenceRuntime();
 const writer:TaskScheduleUnitOfWork={
  run(ctx,cap,work){return runner.run(ctx,cap,scope=>work({...composeRecurrenceCensusScope(scope,runtime),dependencies:createDependencyRepository(scope.tx)}));},
  async read(ctx,cap,work){try{return await db.transaction(async tx=>{
   const dependencies=createDependencyRepository(tx),access=await authorizeWorkspace(dependencies.tasks.access,ctx,cap);
   const result=await tx.execute<{at:string}>(sql`SELECT clock_timestamp()::text AS at`),clock=result[0];
   if(!clock)throw new Error('Database clock unavailable.');
   const barrierAt=new Date(clock.at);
   const composed=composeRecurrenceCensusScope({tx,context:ctx,access,barrierAt,recordChange:async()=>{throw new Error('A schedule preview cannot write.');}},runtime);
   return work({...composed,dependencies});
  },{isolationLevel:'repeatable read',accessMode:'read only'});}catch(error){if(!isDomainError(error)&&isDatabaseUnavailableError(error))throw temporarilyUnavailableError(error);throw error;}},
 };
 return createDomainTaskScheduleApplication({writer,tools:{newId:()=>randomUUID(),digest:v=>createHash('sha256').update(v,'utf8').digest('hex')}});
}
