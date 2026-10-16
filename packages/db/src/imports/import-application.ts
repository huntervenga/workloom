import {sql} from 'drizzle-orm';
import {createHash,randomUUID} from 'node:crypto';
import {authorizeWorkspace,createProjectImportApplication as domainApplication,isDomainError,temporarilyUnavailableError,type ProjectImportApplication,type ProjectImportUnitOfWork} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {isDatabaseUnavailableError} from '../database-errors.js';
import {createProjectImportRepository} from '../repositories/project-import-repository.js';
import {createTaskRepository} from '../repositories/task-repository.js';
import {composeRecurrenceCensusScope,createRecurrenceRuntime} from '../recurrence/census-scope.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from '../transactions/workspace-write.js';
export function createProjectImportApplication(source:Database|WorkloomExecutor,options:WorkspaceWriteOptions={}):ProjectImportApplication {
 const db=isDatabase(source)?source.db:source,runner=createWorkspaceWriteRunner(source,options),runtime=createRecurrenceRuntime();
 const writer:ProjectImportUnitOfWork={run(ctx,cap,work){return runner.run(ctx,cap,scope=>work({...composeRecurrenceCensusScope(scope,runtime),imports:createProjectImportRepository(scope.tx)}));},
 async read(ctx,cap,work){try{return await db.transaction(async tx=>{const access=await authorizeWorkspace(createTaskRepository(tx).access,ctx,cap),[clock]=await tx.execute<{at:string}>(sql`SELECT clock_timestamp()::text AS at`);if(!clock)throw new Error('Database clock unavailable.');return work({...composeRecurrenceCensusScope({tx,context:ctx,access,barrierAt:new Date(clock.at),recordChange:async()=>{throw new Error('An import preview cannot write.');}},runtime),imports:createProjectImportRepository(tx)});},{isolationLevel:'repeatable read',accessMode:'read only'});}catch(e){if(!isDomainError(e)&&isDatabaseUnavailableError(e))throw temporarilyUnavailableError(e);throw e;}}};
 return domainApplication({writer,tools:{newId:()=>randomUUID(),digest:v=>createHash('sha256').update(v,'utf8').digest('hex')}});
}
