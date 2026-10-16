import {createHash,timingSafeEqual} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {localCredentialSchema,localMcpSecretPreimage,type LocalCredentialDto} from '@workloom/contracts';
import {authorizeWorkspace,createLocalCredentialService,DomainError,notFoundError,unauthenticatedError,type LocalCredentialApplication,type LocalCredentialRepository,type CommandContext} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {localMcpCredentials} from '../schema.js';
import {createAccessRepository} from '../repositories/access-repository.js';
import {createTaskRepository} from '../repositories/task-repository.js';
import {createWorkspaceWriteRunner,type WorkspaceWriteOptions} from '../transactions/workspace-write.js';
export interface LocalMcpApplicationOptions extends WorkspaceWriteOptions {readonly cursorSecret?:string;readonly enableTaskWrites?:boolean}
export const digest=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
const metadata=(row:typeof localMcpCredentials.$inferSelect):LocalCredentialDto=>localCredentialSchema.parse({...row,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),revokedAt:row.revokedAt?.toISOString()??null});
export function credentialRepository(tx:WorkloomExecutor,workspaceId:string):LocalCredentialRepository{
 const taskRepo=createTaskRepository(tx);
 return {
 async find(id){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return null;const [row]=await tx.select().from(localMcpCredentials).where(and(eq(localMcpCredentials.workspaceId,workspaceId),eq(localMcpCredentials.id,id))).limit(1);return row?{metadata:metadata(row),secretHash:row.secretHash}:null;},
 async list(owner){const rows=await tx.select().from(localMcpCredentials).where(and(eq(localMcpCredentials.workspaceId,workspaceId),eq(localMcpCredentials.ownerUserId,owner))).orderBy(asc(localMcpCredentials.createdAt),asc(localMcpCredentials.id)).limit(101);return rows.map(metadata);},
 async insert(row){const inserted=await tx.insert(localMcpCredentials).values({...row.metadata,secretHash:row.secretHash,createdAt:new Date(row.metadata.createdAt),expiresAt:new Date(row.metadata.expiresAt),revokedAt:null}).onConflictDoNothing().returning({id:localMcpCredentials.id});if(inserted.length!==1)throw new DomainError('REVISION_CONFLICT','Credential ID already exists.');},
 async revoke(row){const changed=await tx.update(localMcpCredentials).set({revision:row.revision,revokedAt:row.revokedAt?new Date(row.revokedAt):null}).where(and(eq(localMcpCredentials.workspaceId,workspaceId),eq(localMcpCredentials.id,row.id),eq(localMcpCredentials.ownerUserId,row.ownerUserId),eq(localMcpCredentials.revision,row.revision-1))).returning({id:localMcpCredentials.id});if(changed.length!==1)throw notFoundError();},
 receipt:(actor,command,key)=>taskRepo.findIdempotency(workspaceId,actor,command,key),
 saveReceipt:(actor,command,key,payloadHash,result,at)=>taskRepo.insertIdempotency({workspaceId,actorUserId:actor,command,idempotencyKey:key,payloadHash,result,createdAt:at.toISOString()}),
 };
}
export function createLocalCredentialApplication(source:Database|WorkloomExecutor,options:LocalMcpApplicationOptions={}):LocalCredentialApplication{
 const db=isDatabase(source)?source.db:source,runner=createWorkspaceWriteRunner(source,options);
 return createLocalCredentialService({enableTaskWrites:options.enableTaskWrites??false,digest,
 reader:{run:(context,work)=>db.transaction(async tx=>{await bounded(tx);const access=await authorizeWorkspace(createAccessRepository(tx),context,'workspace.read');return work({context,access,repository:credentialRepository(tx,context.workspaceId)});},{isolationLevel:'repeatable read',accessMode:'read only'})},
 writer:{run:(context,capability,work)=>runner.run(context,capability,s=>work({...s,repository:credentialRepository(s.tx,context.workspaceId)}))},
 });
}
export async function bounded(tx:WorkloomExecutor):Promise<void>{await tx.execute(sql`select set_config('lock_timeout','5000ms',true),set_config('statement_timeout','15000ms',true)`);}
export interface BearerProof{readonly id:string;readonly secretHash:string}
export function parseLocalMcpBearer(token:string):BearerProof{
 const match=/^wlm_local_v1_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/.exec(token);if(!match)throw unauthenticatedError();const id=match[1],encoded=match[2];if(!id||!encoded)throw unauthenticatedError();const bytes=Buffer.from(encoded,'base64url');if(bytes.length!==32||bytes.toString('base64url')!==encoded)throw unauthenticatedError();return {id,secretHash:createHash('sha256').update(localMcpSecretPreimage(id,bytes)).digest('hex')};
}
export async function resolveLocalMcpContext(tx:WorkloomExecutor,proof:BearerProof,requestId:string):Promise<{context:CommandContext;metadata:LocalCredentialDto}>{
 if(!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))throw unauthenticatedError();
 const [row]=await tx.select().from(localMcpCredentials).where(eq(localMcpCredentials.id,proof.id)).limit(1);if(!row||!timingSafeEqual(Buffer.from(row.secretHash,'hex'),Buffer.from(proof.secretHash,'hex')))throw unauthenticatedError();
 const actor=await createAccessRepository(tx).findUser(row.ownerUserId);if(!actor)throw unauthenticatedError();
 return {context:{actor:{userId:actor.id,displayName:actor.displayName,kind:actor.kind},workspaceId:row.workspaceId,source:'mcp',requestId},metadata:metadata(row)};
}
