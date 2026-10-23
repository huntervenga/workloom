import type {TeamInviteRole,TeamMembershipDto,TeamInvitationDto} from '@workloom/contracts';
import {capabilityRequiredError,notFoundError} from '../errors.js';
export function allowedTeamInviteRoles(role:string):TeamInviteRole[]{return role==='owner'?['admin','member','viewer']:role==='admin'?['member','viewer']:[];}
export function assertTeamRoleGrant(actorRole:string,targetRole:string):void {if(!allowedTeamInviteRoles(actorRole).includes(targetRole as TeamInviteRole))throw capabilityRequiredError();}
export function assertTeamMemberManagement(actorRole:string,target:TeamMembershipDto,nextRole:TeamInviteRole):void {assertTeamRoleGrant(actorRole,target.role);assertTeamRoleGrant(actorRole,nextRole);}
/** Pending capabilities expire/revoke with their issuer. Consumed capabilities never reactivate a revoked membership. */
export function validateTeamAdmission(invite:TeamInvitationDto,member:TeamMembershipDto|null,issuer:TeamMembershipDto|null,userId:string,at:Date):'replay'|'admit' {
 if(invite.acceptedAt!==null){if(invite.acceptedByUserId!==userId||member?.id!==invite.acceptedMembershipId||member.state!=='active')throw notFoundError();return 'replay';}
 if(invite.revokedAt!==null||new Date(invite.expiresAt).getTime()<=at.getTime()||issuer?.state!=='active'||issuer.id!==invite.createdByMembershipId||issuer.userId!==invite.createdByUserId||!allowedTeamInviteRoles(issuer.role).includes(invite.role))throw notFoundError();
 // Reactivation changes a stable membership, so the issuer must also be allowed to manage its previous role.
 if(member?.state==='revoked'){
  // An unused bearer link is not a fresh authorization after an access revocation.
  // Equal timestamps fail closed too; missing/invalid revocation evidence cannot restore access.
  if(member.revokedAt===null||!(Date.parse(invite.createdAt)>Date.parse(member.revokedAt))||!allowedTeamInviteRoles(issuer.role).includes(member.role as TeamInviteRole))throw notFoundError();
 }
 return 'admit';
}
