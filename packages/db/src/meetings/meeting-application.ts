import {createHash,randomUUID} from 'node:crypto';
import {authorizeWorkspace,createMeetingApplication as createDomainMeetingApplication,createWorkCategoryResolver,isDomainError,temporarilyUnavailableError,type MeetingApplication,type MeetingUnitOfWork,type PlanningTools} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {isDatabaseUnavailableError} from '../database-errors.js';
import {createPlanningCursorCodec} from '../planning/cursor.js';
import {createMeetingRepository} from '../repositories/meeting-repository.js';
import {createWorkCategoryRepository} from '../repositories/work-category-repository.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from '../transactions/workspace-write.js';
export interface MeetingApplicationOptions extends WorkspaceWriteOptions{readonly cursorSecret?:string}
export function createMeetingApplication(source:Database|WorkloomExecutor,options:MeetingApplicationOptions={}):MeetingApplication{
 const {cursorSecret,...writeOptions}=options,runner=createWorkspaceWriteRunner(source,writeOptions),db=isDatabase(source)?source.db:source;
 const codec=createPlanningCursorCodec(cursorSecret===undefined?{}:{secret:cursorSecret}),tools:PlanningTools={newId:()=>randomUUID(),digest:v=>createHash('sha256').update(v,'utf8').digest('hex'),encodeCursor:v=>codec.encode(v),decodeCursor:v=>codec.decode(v)};
 const writer:MeetingUnitOfWork={
  run(ctx,cap,work){return runner.run(ctx,cap,scope=>{const meetings=createMeetingRepository(scope.tx);return work({...scope,repository:meetings.planning,meetings,categoryResolver:createWorkCategoryResolver(createWorkCategoryRepository(scope.tx),ctx.workspaceId)});});},
  async read(ctx,cap,work){try{return await db.transaction(async tx=>{const repo=createMeetingRepository(tx);await authorizeWorkspace(repo.planning.tasks.access,ctx,cap);return work(repo);},{isolationLevel:'repeatable read',accessMode:'read only'});}catch(error){if(!isDomainError(error)&&isDatabaseUnavailableError(error))throw temporarilyUnavailableError(error);throw error;}},
 };
 return createDomainMeetingApplication({writer,tools});
}
