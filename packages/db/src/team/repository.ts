import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {teamInvitationSchema,teamMembershipSchema,type TeamInvitationDto,type TeamMembershipDto} from '@workloom/contracts';
import {DomainError,type TeamRepository} from '@workloom/domain';
import type {WorkloomExecutor} from '../client.js';
import {teamInvitations,teamPendingMembers,memberships,users,workspaces} from '../schema.js';
import {createTaskRepository} from '../repositories/task-repository.js';
export const invitationDto=(r:typeof teamInvitations.$inferSelect):TeamInvitationDto=>{
 const {recipient,pendingMembershipId,...metadata}=r;
 return teamInvitationSchema.parse({...metadata,...(recipient?{recipient}:{}),...(pendingMembershipId?{pendingMembershipId}:{}),createdAt:r.createdAt.toISOString(),expiresAt:r.expiresAt.toISOString(),revokedAt:r.revokedAt?.toISOString()??null,acceptedAt:r.acceptedAt?.toISOString()??null});
};
export const membershipDto=(r:typeof memberships.$inferSelect,u:{displayName:string;avatarUrl:string|null},pending?:typeof teamPendingMembers.$inferSelect|null):TeamMembershipDto=>teamMembershipSchema.parse({...r,displayName:u.displayName,avatarUrl:u.avatarUrl,revokedAt:r.revokedAt?.toISOString()??null,...(pending?{pending:pending.claimedAt===null,email:pending.email}:{})});
export function teamRepository(tx:WorkloomExecutor,workspaceId:string):TeamRepository {
 const tasks=createTaskRepository(tx);
 const memberQuery=()=>tx.select({m:memberships,u:{displayName:users.displayName,avatarUrl:users.avatarUrl},p:teamPendingMembers}).from(memberships).innerJoin(users,eq(users.id,memberships.userId)).leftJoin(teamPendingMembers,and(eq(teamPendingMembers.workspaceId,memberships.workspaceId),eq(teamPendingMembers.membershipId,memberships.id)));
 return {
 async findInvitation(id){const [r]=await tx.select().from(teamInvitations).where(and(eq(teamInvitations.workspaceId,workspaceId),eq(teamInvitations.id,id))).limit(1);return r?{metadata:invitationDto(r),secretHash:r.secretHash}:null;},
 async listInvitations(){return (await tx.select().from(teamInvitations).where(eq(teamInvitations.workspaceId,workspaceId)).orderBy(asc(teamInvitations.createdAt),asc(teamInvitations.id)).limit(1001)).map(invitationDto);},
 async insertInvitation({metadata:r,secretHash}){const inserted=await tx.insert(teamInvitations).values({...r,secretHash,createdAt:new Date(r.createdAt),expiresAt:new Date(r.expiresAt),revokedAt:null,acceptedAt:null}).onConflictDoNothing().returning({id:teamInvitations.id});if(inserted.length!==1)throw new DomainError('REVISION_CONFLICT','Invitation ID already exists.');},
 async updateInvitation(r){const changed=await tx.update(teamInvitations).set({revision:r.revision,revokedAt:r.revokedAt?new Date(r.revokedAt):null,acceptedAt:r.acceptedAt?new Date(r.acceptedAt):null,acceptedByUserId:r.acceptedByUserId,acceptedMembershipId:r.acceptedMembershipId}).where(and(eq(teamInvitations.workspaceId,workspaceId),eq(teamInvitations.id,r.id),eq(teamInvitations.revision,r.revision-1))).returning({id:teamInvitations.id});if(changed.length!==1)throw new DomainError('REVISION_CONFLICT','Invitation changed.');},
 async listMembers(){const rows=await memberQuery().where(eq(memberships.workspaceId,workspaceId)).orderBy(asc(users.displayName),asc(memberships.id)).limit(1001);return rows.map(r=>membershipDto(r.m,r.u,r.p));},
 async findMember(id){const [r]=await memberQuery().where(and(eq(memberships.workspaceId,workspaceId),eq(memberships.id,id))).limit(1);return r?membershipDto(r.m,r.u,r.p):null;},
 async updateMember(r,at){const changed=await tx.update(memberships).set({role:r.role,state:r.state,revision:r.revision,revokedAt:r.revokedAt?new Date(r.revokedAt):null,updatedAt:at}).where(and(eq(memberships.workspaceId,workspaceId),eq(memberships.id,r.id),eq(memberships.revision,r.revision-1))).returning({id:memberships.id});if(changed.length!==1)throw new DomainError('REVISION_CONFLICT','Membership changed.');},
 async findPendingMember(email){const [r]=await memberQuery().where(and(eq(memberships.workspaceId,workspaceId),eq(teamPendingMembers.email,email))).limit(1);return r?membershipDto(r.m,r.u,r.p):null;},
 async createPendingMember(recipient,role,at){
  const userId=randomUUID(),id=randomUUID(),displayName=[recipient.firstName,recipient.lastName].filter(Boolean).join(' ');
  await tx.insert(users).values({id:userId,displayName,kind:'real',createdAt:at,updatedAt:at});
  await tx.insert(memberships).values({id,workspaceId,userId,role,state:'active',revision:1,createdAt:at,updatedAt:at});
  await tx.insert(teamPendingMembers).values({workspaceId,membershipId:id,placeholderUserId:userId,...recipient,createdAt:at});
  return {id,workspaceId,userId,displayName,avatarUrl:null,role,state:'active',revision:1,revokedAt:null,pending:true,email:recipient.email};
 },
 async refreshPendingMember(member,recipient,role,at){
  const [pending]=await tx.select().from(teamPendingMembers).where(and(eq(teamPendingMembers.workspaceId,workspaceId),eq(teamPendingMembers.membershipId,member.id),eq(teamPendingMembers.placeholderUserId,member.userId))).limit(1);
  if(!pending||pending.claimedAt!==null)throw new DomainError('REVISION_CONFLICT','Invited person changed.');
  const displayName=[recipient.firstName,recipient.lastName].filter(Boolean).join(' ');
  const [changed]=await tx.update(memberships).set({role,state:'active',revokedAt:null,revision:member.revision+1,updatedAt:at}).where(and(eq(memberships.workspaceId,workspaceId),eq(memberships.id,member.id),eq(memberships.userId,member.userId),eq(memberships.revision,member.revision))).returning();
  if(!changed)throw new DomainError('REVISION_CONFLICT','Invited person changed.');
  await tx.update(users).set({displayName,updatedAt:at}).where(eq(users.id,member.userId));
  await tx.update(teamPendingMembers).set({firstName:recipient.firstName,lastName:recipient.lastName}).where(and(eq(teamPendingMembers.workspaceId,workspaceId),eq(teamPendingMembers.membershipId,member.id)));
  return membershipDto(changed,{displayName,avatarUrl:null},pending);
 },
 async bumpPermissionEpoch(){await tx.update(workspaces).set({permissionEpoch:sql`${workspaces.permissionEpoch}+1`}).where(eq(workspaces.id,workspaceId));},
 receipt:(actor,command,key)=>tasks.findIdempotency(workspaceId,actor,command,key),
 saveReceipt:(actor,command,key,payloadHash,result,at)=>tasks.insertIdempotency({workspaceId,actorUserId:actor,command,idempotencyKey:key,payloadHash,result,createdAt:at.toISOString()}),
 };
}
