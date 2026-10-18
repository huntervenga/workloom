import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {teamInvitationSecretPreimage,type AcceptTeamInvitationInput} from '@workloom/contracts';
import {authorizeWorkspace,createTeamService,capabilityRequiredError,notFoundError,DomainError,isDomainError,temporarilyUnavailableError,type ActorContext,type TeamApplication,type TeamInvitationProof,type ChangeEventInput} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {isDatabaseUnavailableError} from '../database-errors.js';
import {users,sharedAuthIdentities,memberships,teamInvitations,workspaces,auditEvents,outboxEvents} from '../schema.js';
import {createAccessRepository} from '../repositories/access-repository.js';
import {createWorkspaceWriteRunner} from '../transactions/workspace-write.js';
import {bounded,digest} from '../local-mcp/credentials.js';
import {teamRepository,membershipDto} from './repository.js';
/** Canonical encoding prevents alternate spellings of the same bearer capability. */
export function proveTeamInvitation(input:AcceptTeamInvitationInput):TeamInvitationProof {
 const bytes=Buffer.from(input.secret,'base64url');if(bytes.length!==32||bytes.toString('base64url')!==input.secret)throw new DomainError('VALIDATION_FAILED','Invalid invitation material.');
 return {id:input.invitationId.toLowerCase(),secretHash:createHash('sha256').update(teamInvitationSecretPreimage(input.invitationId,bytes)).digest('hex')};
}
async function sharedActor(tx:WorkloomExecutor,c:ActorContext){
 if(c.actor.kind!=='real')throw capabilityRequiredError();
 const [actor]=await tx.select({id:users.id,displayName:users.displayName,avatarUrl:users.avatarUrl}).from(users).innerJoin(sharedAuthIdentities,eq(sharedAuthIdentities.userId,users.id)).where(and(eq(users.id,c.actor.userId),eq(users.kind,'real'))).limit(1);
 if(!actor)throw capabilityRequiredError();return actor;
}
function matches(stored:string,proof:string){return /^[a-f0-9]{64}$/.test(stored)&&/^[a-f0-9]{64}$/.test(proof)&&timingSafeEqual(Buffer.from(stored,'hex'),Buffer.from(proof,'hex'));}
export function createTeamApplication(source:Database|WorkloomExecutor):TeamApplication {
 const db=isDatabase(source)?source.db:source,writer=createWorkspaceWriteRunner(source);
 return createTeamService({digest,prove:proveTeamInvitation,
 reader:{run:(context,work)=>db.transaction(async tx=>{await bounded(tx);await sharedActor(tx,context);const access=await authorizeWorkspace(createAccessRepository(tx),context,'members.manage');return work({context,access,repository:teamRepository(tx,context.workspaceId)});},{isolationLevel:'repeatable read',accessMode:'read only'})},
 writer:{run:(context,capability,work)=>writer.run(context,capability,async s=>{await sharedActor(s.tx,context);return work({...s,repository:teamRepository(s.tx,context.workspaceId)});})},
 admission:{async run(context,proof,work){
  try{return await db.transaction(async tx=>{
   await bounded(tx);const actor=await sharedActor(tx,context);
   // A proven capability is the sole exception to the normal pre-membership workspace barrier.
   const [candidate]=await tx.select({workspaceId:teamInvitations.workspaceId,secretHash:teamInvitations.secretHash}).from(teamInvitations).where(eq(teamInvitations.id,proof.id)).limit(1);
   if(!candidate||!matches(candidate.secretHash,proof.secretHash))throw notFoundError();
   const workspaceId=candidate.workspaceId;
   const locked=await tx.select({id:workspaces.id}).from(workspaces).where(eq(workspaces.id,workspaceId)).for('update');if(!locked.length)throw notFoundError();
   // Re-read both the identity and invitation after waiting; the callback never sees a stale grant.
   await sharedActor(tx,context);const repo=teamRepository(tx,workspaceId),invitation=await repo.findInvitation(proof.id);if(!invitation||!matches(invitation.secretHash,proof.secretHash))throw notFoundError();
   const [clock]=await tx.execute<{epoch_ms:number}>(sql`select (extract(epoch from clock_timestamp())*1000)::float8 as epoch_ms`),barrierAt=new Date(Number(clock?.epoch_ms));
   const [existing]=await tx.select().from(memberships).where(and(eq(memberships.workspaceId,workspaceId),eq(memberships.userId,context.actor.userId))).limit(1);
   const currentMember=existing?membershipDto(existing,actor):null,issuer=await repo.findMember(invitation.metadata.createdByMembershipId);
   let changeSeq:bigint|undefined,eventOrdinal=0;
   async function recordChange(event:ChangeEventInput,actorMembershipId:string){
    if(changeSeq===undefined){const [r]=await tx.update(workspaces).set({changeSeq:sql`${workspaces.changeSeq}+1`}).where(eq(workspaces.id,workspaceId)).returning({changeSeq:workspaces.changeSeq});if(!r)throw notFoundError();changeSeq=r.changeSeq;}
    eventOrdinal+=1;await tx.insert(auditEvents).values({workspaceId:workspaceId,changeSeq,eventOrdinal,actorUserId:context.actor.userId,actorMembershipId,source:context.source,requestId:context.requestId,entityType:event.entityType,entityId:event.entityId,entityRevision:event.entityRevision??null,action:event.action,diff:event.diff?{...event.diff}:null,recordedAt:barrierAt});
    if(event.outbox)await tx.insert(outboxEvents).values({workspaceId:workspaceId,changeSeq,eventOrdinal,type:event.outbox.type,schemaVersion:1,aggregateType:event.entityType,aggregateId:event.entityId,aggregateRevision:event.entityRevision??null,payload:{...event.outbox.payload},occurredAt:barrierAt});
   }
   return work({context:{...context,workspaceId:workspaceId},barrierAt,repository:repo,invitation,currentMember,issuer,recordChange,
    async admit(role){
     if((await repo.listMembers()).length>=1000&&!currentMember)throw new DomainError('DOMAIN_VALIDATION_FAILED','Team member limit reached.');
     const row={id:currentMember?.id??randomUUID(),workspaceId:workspaceId,userId:context.actor.userId,displayName:actor.displayName,avatarUrl:actor.avatarUrl,role,state:'active' as const,revision:(currentMember?.revision??0)+1,revokedAt:null};
     if(currentMember)await repo.updateMember(row,barrierAt);else await tx.insert(memberships).values({id:row.id,workspaceId:row.workspaceId,userId:row.userId,role,state:'active',revision:1,createdAt:barrierAt,updatedAt:barrierAt});
     await repo.bumpPermissionEpoch();await recordChange({entityType:'membership',entityId:row.id,entityRevision:row.revision,action:currentMember?'reactivated':'joined',diff:{role},outbox:{type:'team.membership_changed',payload:{membershipId:row.id}}},row.id);return row;
    },
   });
  });}catch(error){if(!isDomainError(error)&&isDatabaseUnavailableError(error))throw temporarilyUnavailableError(error);throw error;}
 }},
 });
}
