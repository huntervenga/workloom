import {idSchema,issueLocalCredentialInputSchema,revokeLocalCredentialInputSchema,localCredentialSchema,type LocalCredentialDto,type LocalMcpScope} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {WorkspaceWriteRunner,WorkspaceWriteScope} from '../transactions/ports.js';
import {DomainError,notFoundError,capabilityRequiredError} from '../errors.js';
import {canonicalJson} from '../tasks/service.js';
import {allowedLocalMcpScopes} from './policy.js';
import type {LocalCredentialApplication} from './application.js';
export interface StoredLocalCredential {metadata:LocalCredentialDto;secretHash:string}
export interface LocalCredentialRepository {
 find(id:string):Promise<StoredLocalCredential|null>;list(ownerUserId:string):Promise<LocalCredentialDto[]>;
 insert(row:StoredLocalCredential):Promise<void>;revoke(row:LocalCredentialDto):Promise<void>;
 receipt(actor:string,command:string,key:string):Promise<{payloadHash:string;result:unknown}|null>;
 saveReceipt(actor:string,command:string,key:string,payloadHash:string,result:unknown,at:Date):Promise<void>;
}
export interface LocalCredentialScope extends WorkspaceWriteScope {repository:LocalCredentialRepository}
export interface LocalCredentialReader {run<T>(context:CommandContext,work:(scope:Pick<LocalCredentialScope,'context'|'access'|'repository'>)=>Promise<T>):Promise<T>}
export function createLocalCredentialService(deps:{reader:LocalCredentialReader;writer:WorkspaceWriteRunner<LocalCredentialScope>;digest:(s:string)=>string;enableTaskWrites?:boolean}):LocalCredentialApplication {
 const hash=(x:unknown)=>deps.digest(canonicalJson(x));
 const fail=()=>{throw new DomainError('VALIDATION_FAILED','Invalid credential input.');};
 function key(c:CommandContext){if(!c.idempotencyKey||! /^[\x21-\x7e]{1,128}$/.test(c.idempotencyKey))return fail();return c.idempotencyKey;}
 return {
 async listCredentials(context){return deps.reader.run(context,async s=>{const credentials=await s.repository.list(context.actor.userId);if(credentials.length>100)throw new DomainError('DOMAIN_VALIDATION_FAILED','Too many credentials.');return {credentials,allowedScopes:allowedLocalMcpScopes(s.access.membership.role,deps.enableTaskWrites)};});},
 async issueCredential(context,input){const parsed=issueLocalCredentialInputSchema.safeParse(input);if(!parsed.success)return fail();const p=parsed.data,k=key(context),command='local_mcp.credential.issue',payloadHash=hash({command,input:p});return deps.writer.run(context,'workspace.read',async s=>{
  const allowed=allowedLocalMcpScopes(s.access.membership.role,deps.enableTaskWrites);if(p.scopes.some(scope=>!allowed.includes(scope)))throw capabilityRequiredError();
  const cached=await s.repository.receipt(context.actor.userId,command,k);if(cached){if(cached.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','Idempotency key was reused.');return localCredentialSchema.parse(cached.result);}
  if(await s.repository.find(p.id))throw new DomainError('REVISION_CONFLICT','Credential ID already exists.');
  if((await s.repository.list(context.actor.userId)).length>=100)throw new DomainError('DOMAIN_VALIDATION_FAILED','At most 100 credentials per member and workspace.');
  const metadata:LocalCredentialDto={id:p.id,workspaceId:context.workspaceId,ownerUserId:context.actor.userId,name:p.name,hashVersion:1,scopes:p.scopes as LocalMcpScope[],revision:1,createdAt:s.barrierAt.toISOString(),expiresAt:new Date(s.barrierAt.getTime()+p.expiresInSeconds*1000).toISOString(),revokedAt:null};
  await s.repository.insert({metadata,secretHash:p.secretHash});await s.recordChange({entityType:'local_mcp_credential',entityId:p.id,entityRevision:1,action:'issued',diff:{scopes:metadata.scopes,expiresAt:metadata.expiresAt},outbox:{type:'local_mcp.credential_issued',payload:{credentialId:p.id}}});await s.repository.saveReceipt(context.actor.userId,command,k,payloadHash,metadata,s.barrierAt);return metadata;
 });},
 async revokeCredential(context,credentialPath,input){const identity=idSchema.safeParse(credentialPath);if(!identity.success)return fail();const id=identity.data;const parsed=revokeLocalCredentialInputSchema.safeParse(input);if(!parsed.success)return fail();const p=parsed.data,k=key(context),command='local_mcp.credential.revoke',payloadHash=hash({command,target:{credentialId:id},input:p});return deps.writer.run(context,'workspace.read',async s=>{
  const row=await s.repository.find(id);if(!row||row.metadata.ownerUserId!==context.actor.userId)throw notFoundError();const cached=await s.repository.receipt(context.actor.userId,command,k);if(cached){if(cached.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','Idempotency key was reused.');return localCredentialSchema.parse(cached.result);}
  if(row.metadata.revision!==p.expectedRevision)throw new DomainError('REVISION_CONFLICT','Credential revision changed.');
  const metadata=row.metadata.revokedAt?row.metadata:{...row.metadata,revokedAt:s.barrierAt.toISOString(),revision:2};if(!row.metadata.revokedAt){await s.repository.revoke(metadata);await s.recordChange({entityType:'local_mcp_credential',entityId:id,entityRevision:2,action:'revoked',outbox:{type:'local_mcp.credential_revoked',payload:{credentialId:id}}});}await s.repository.saveReceipt(context.actor.userId,command,k,payloadHash,metadata,s.barrierAt);return metadata;
 });}
 };
}
