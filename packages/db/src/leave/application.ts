import {createHash,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {authorizeWorkspace,createLeaveService,notFoundError,temporarilyUnavailableError,isDomainError,type LeaveApplication,type LeaveScope} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {isDatabaseUnavailableError} from '../database-errors.js';
import {createAccessRepository} from '../repositories/access-repository.js';
import {workspaces} from '../schema.js';
import {createWorkspaceWriteRunner} from '../transactions/workspace-write.js';
import {createLeaveRepository} from './repository.js';
/** Calendar commands have their own capability/intents and do not census unrelated recurring meetings. */
export function createLeaveApplication(source:Database|WorkloomExecutor):LeaveApplication {
 const db=isDatabase(source)?source.db:source,writer=createWorkspaceWriteRunner(source);
 return createLeaveService({newId:randomUUID,digest:(s)=>createHash('sha256').update(s).digest('hex'),
  write:(context,capability,work)=>writer.run(context,capability,scope=>work({...scope,repository:createLeaveRepository(scope.tx,context.workspaceId)})),
  async read(context,capability,work){try{return await db.transaction(async tx=>{
   await tx.execute(sql`select set_config('lock_timeout','5000ms',true),set_config('statement_timeout','15000ms',true)`);
   const accessRepo=createAccessRepository(tx);await authorizeWorkspace(accessRepo,context,capability);
   const [row]=await tx.select({id:workspaces.id}).from(workspaces).where(eq(workspaces.id,context.workspaceId)).for('share');if(!row)throw notFoundError();
   const access=await authorizeWorkspace(accessRepo,context,capability);
   const [clock]=await tx.execute<{epoch_ms:number}>(sql`select (extract(epoch from clock_timestamp())*1000)::float8 as epoch_ms`);
   const scope:LeaveScope={context,access,barrierAt:new Date(Number(clock?.epoch_ms)),repository:createLeaveRepository(tx,context.workspaceId),recordChange:async()=>{throw new Error('A leave read cannot record mutations.');}};
   const result=await work(scope);await authorizeWorkspace(accessRepo,context,capability);return result;
  },{isolationLevel:'read committed'});}catch(e){if(!isDomainError(e)&&isDatabaseUnavailableError(e))throw temporarilyUnavailableError(e);throw e;}}
 });
}
