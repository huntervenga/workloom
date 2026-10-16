import {authorizeWorkspace,createMeetingApplication as createDomainMeetingApplication,isDomainError,temporarilyUnavailableError,type MeetingApplication,type MeetingUnitOfWork} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {isDatabaseUnavailableError} from '../database-errors.js';
import {composeRecurrenceCensusScope,createRecurrenceRuntime} from '../recurrence/census-scope.js';
import {createMeetingRepository} from '../repositories/meeting-repository.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from '../transactions/workspace-write.js';
export interface MeetingApplicationOptions extends WorkspaceWriteOptions{readonly cursorSecret?:string}
/** Every meeting write scope carries the mandatory same-TX recurrence census (shared composition, no bypass). */
export function createMeetingApplication(source:Database|WorkloomExecutor,options:MeetingApplicationOptions={}):MeetingApplication{
 const {cursorSecret,...writeOptions}=options,runner=createWorkspaceWriteRunner(source,writeOptions),db=isDatabase(source)?source.db:source;
 const recurrence=createRecurrenceRuntime(cursorSecret===undefined?{}:{cursorSecret}),tools=recurrence.tools;
 const writer:MeetingUnitOfWork={
  run(ctx,cap,work){return runner.run(ctx,cap,scope=>{const census=composeRecurrenceCensusScope(scope,recurrence);return work(census);});},
  async read(ctx,cap,work){try{return await db.transaction(async tx=>{const repo=createMeetingRepository(tx);await authorizeWorkspace(repo.planning.tasks.access,ctx,cap);return work(repo);},{isolationLevel:'repeatable read',accessMode:'read only'});}catch(error){if(!isDomainError(error)&&isDatabaseUnavailableError(error))throw temporarilyUnavailableError(error);throw error;}},
 };
 return createDomainMeetingApplication({writer,tools});
}
