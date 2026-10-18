import {and,asc,eq,sql} from 'drizzle-orm';
import {teamInvitationSchema,teamMembershipSchema,type TeamInvitationDto,type TeamMembershipDto} from '@workloom/contracts';
import {DomainError,type TeamRepository} from '@workloom/domain';
import type {WorkloomExecutor} from '../client.js';
import {teamInvitations,memberships,users,workspaces} from '../schema.js';
import {createTaskRepository} from '../repositories/task-repository.js';
export const invitationDto=(r:typeof teamInvitations.$inferSelect):TeamInvitationDto=>teamInvitationSchema.parse({...r,createdAt:r.createdAt.toISOString(),expiresAt:r.expiresAt.toISOString(),revokedAt:r.revokedAt?.toISOString()??null,acceptedAt:r.acceptedAt?.toISOString()??null});
export const membershipDto=(r:typeof memberships.$inferSelect,u:{displayName:string;avatarUrl:string|null}):TeamMembershipDto=>teamMembershipSchema.parse({...r,displayName:u.displayName,avatarUrl:u.avatarUrl,revokedAt:r.revokedAt?.toISOString()??null});
export function teamRepository(tx:WorkloomExecutor,workspaceId:string):TeamRepository {
 const tasks=createTaskRepository(tx);
 return {
 async findInvitation(id){const [r]=await tx.select().from(teamInvitations).where(and(eq(teamInvitations.workspaceId,workspaceId),eq(teamInvitations.id,id))).limit(1);return r?{metadata:invitationDto(r),secretHash:r.secretHash}:null;},
 async listInvitations(){return (await tx.select().from(teamInvitations).where(eq(teamInvitations.workspaceId,workspaceId)).orderBy(asc(teamInvitations.createdAt),asc(teamInvitations.id)).limit(1001)).map(invitationDto);},
 async insertInvitation({metadata:r,secretHash}){const inserted=await tx.insert(teamInvitations).values({...r,secretHash,createdAt:new Date(r.createdAt),expiresAt:new Date(r.expiresAt),revokedAt:null,acceptedAt:null}).onConflictDoNothing().returning({id:teamInvitations.id});if(inserted.length!==1)throw new DomainError('REVISION_CONFLICT','Invitation ID already exists.');},
 async updateInvitation(r){const changed=await tx.update(teamInvitations).set({revision:r.revision,revokedAt:r.revokedAt?new Date(r.revokedAt):null,acceptedAt:r.acceptedAt?new Date(r.acceptedAt):null,acceptedByUserId:r.acceptedByUserId,acceptedMembershipId:r.acceptedMembershipId}).where(and(eq(teamInvitations.workspaceId,workspaceId),eq(teamInvitations.id,r.id),eq(teamInvitations.revision,r.revision-1))).returning({id:teamInvitations.id});if(changed.length!==1)throw new DomainError('REVISION_CONFLICT','Invitation changed.');},
 async listMembers(){const rows=await tx.select({m:memberships,u:{displayName:users.displayName,avatarUrl:users.avatarUrl}}).from(memberships).innerJoin(users,eq(users.id,memberships.userId)).where(eq(memberships.workspaceId,workspaceId)).orderBy(asc(users.displayName),asc(memberships.id)).limit(1001);return rows.map(r=>membershipDto(r.m,r.u));},
 async findMember(id){const [r]=await tx.select({m:memberships,u:{displayName:users.displayName,avatarUrl:users.avatarUrl}}).from(memberships).innerJoin(users,eq(users.id,memberships.userId)).where(and(eq(memberships.workspaceId,workspaceId),eq(memberships.id,id))).limit(1);return r?membershipDto(r.m,r.u):null;},
 async updateMember(r,at){const changed=await tx.update(memberships).set({role:r.role,state:r.state,revision:r.revision,revokedAt:r.revokedAt?new Date(r.revokedAt):null,updatedAt:at}).where(and(eq(memberships.workspaceId,workspaceId),eq(memberships.id,r.id),eq(memberships.revision,r.revision-1))).returning({id:memberships.id});if(changed.length!==1)throw new DomainError('REVISION_CONFLICT','Membership changed.');},
 async bumpPermissionEpoch(){await tx.update(workspaces).set({permissionEpoch:sql`${workspaces.permissionEpoch}+1`}).where(eq(workspaces.id,workspaceId));},
 receipt:(actor,command,key)=>tasks.findIdempotency(workspaceId,actor,command,key),
 saveReceipt:(actor,command,key,payloadHash,result,at)=>tasks.insertIdempotency({workspaceId,actorUserId:actor,command,idempotencyKey:key,payloadHash,result,createdAt:at.toISOString()}),
 };
}
