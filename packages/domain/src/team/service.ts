import {idSchema,issueTeamInvitationInputSchema,revokeTeamInvitationInputSchema,updateTeamMembershipInputSchema,acceptTeamInvitationInputSchema,teamInvitationSchema,teamMembershipSchema,acceptTeamInvitationResultSchema,type AcceptTeamInvitationInput,type TeamInvitationDto,type TeamMembershipDto} from '@workloom/contracts';
import type {ActorContext,CommandContext} from '../access/context.js';
import type {WorkspaceWriteRunner} from '../transactions/ports.js';
import {DomainError,notFoundError,capabilityRequiredError} from '../errors.js';
import {canonicalJson} from '../tasks/service.js';
import type {TeamApplication,TeamAcceptanceContext} from './application.js';
import type {TeamReader,TeamWriteScope,TeamAdmissionRunner,TeamInvitationProof,TeamRepository} from './ports.js';
import {allowedTeamInviteRoles,assertTeamRoleGrant,assertTeamMemberManagement,validateTeamAdmission} from './policy.js';
const invalid=()=>new DomainError('VALIDATION_FAILED','Invalid team command.');
function real(c:ActorContext){if(c.actor.kind!=='real')throw capabilityRequiredError();}
function key(c:CommandContext|TeamAcceptanceContext):string {real(c);if(!c.idempotencyKey||! /^[\x21-\x7e]{1,128}$/.test(c.idempotencyKey))throw invalid();return c.idempotencyKey;}
async function receipt(repo:TeamRepository,actor:string,command:string,k:string,h:string){const cached=await repo.receipt(actor,command,k);if(cached&&cached.payloadHash!==h)throw new DomainError('IDEMPOTENCY_KEY_REUSED','Idempotency key was reused.');return cached;}
export function createTeamService(deps:{reader:TeamReader;writer:WorkspaceWriteRunner<TeamWriteScope>;admission:TeamAdmissionRunner;digest:(s:string)=>string;prove:(p:AcceptTeamInvitationInput)=>TeamInvitationProof}):TeamApplication {
 const hash=(x:unknown)=>deps.digest(canonicalJson(x));
 return {
 async listTeam(context){real(context);return deps.reader.run(context,async s=>{const members=await s.repository.listMembers(),invitations=await s.repository.listInvitations();if(members.length>1000||invitations.length>1000)throw new DomainError('DOMAIN_VALIDATION_FAILED','Team list exceeds the pilot limit.');return {members,invitations,allowedInviteRoles:allowedTeamInviteRoles(s.access.membership.role)};});},
 async issueInvitation(context,input){const p=issueTeamInvitationInputSchema.safeParse(input);if(!p.success)throw invalid();const k=key(context),command='team.invitation.issue',h=hash({command,input:p.data});return deps.writer.run(context,'members.manage',async s=>{
  assertTeamRoleGrant(s.access.membership.role,p.data.role);const cached=await receipt(s.repository,context.actor.userId,command,k,h);if(cached)return teamInvitationSchema.parse(cached.result);
  if(await s.repository.findInvitation(p.data.id))throw new DomainError('REVISION_CONFLICT','Invitation ID already exists.');
  const all=await s.repository.listInvitations();if(all.length>=1000||all.filter(i=>!i.acceptedAt&&!i.revokedAt&&new Date(i.expiresAt)>s.barrierAt).length>=100)throw new DomainError('DOMAIN_VALIDATION_FAILED','Invitation limit reached.');
  let pending:TeamMembershipDto|undefined;
  if(p.data.recipient){
   const existing=await s.repository.findPendingMember(p.data.recipient.email);
   if(existing){
    if(!existing.pending)throw new DomainError('DOMAIN_VALIDATION_FAILED','This invited person has already joined.',{details:{invitationReason:'pending_claimed'}});
    assertTeamRoleGrant(s.access.membership.role,existing.role);
    pending=await s.repository.refreshPendingMember(existing,p.data.recipient,p.data.role,s.barrierAt);
   }else{
    if((await s.repository.listMembers()).length>=1000)throw new DomainError('DOMAIN_VALIDATION_FAILED','Team member limit reached.');
    pending=await s.repository.createPendingMember(p.data.recipient,p.data.role,s.barrierAt);
   }
   await s.repository.bumpPermissionEpoch();
   await s.recordChange({entityType:'membership',entityId:pending.id,entityRevision:pending.revision,action:existing?'invitation_updated':'invited',diff:{role:pending.role,pending:true},outbox:{type:'team.membership_changed',payload:{membershipId:pending.id}}});
   // Regeneration replaces earlier unconsumed links for this person, never their tasks.
   const pendingId=pending.id;
   for(const prior of all.filter(i=>i.pendingMembershipId===pendingId&&!i.acceptedAt&&!i.revokedAt)){
    const revoked={...prior,revision:prior.revision+1,revokedAt:s.barrierAt.toISOString()};
    await s.repository.updateInvitation(revoked);
    await s.recordChange({entityType:'team_invitation',entityId:prior.id,entityRevision:revoked.revision,action:'revoked',outbox:{type:'team.invitation_revoked',payload:{invitationId:prior.id}}});
   }
  }
  const row:TeamInvitationDto={id:p.data.id,workspaceId:context.workspaceId,role:p.data.role,hashVersion:1,createdByUserId:context.actor.userId,createdByMembershipId:s.access.membership.id,createdAt:s.barrierAt.toISOString(),expiresAt:new Date(s.barrierAt.getTime()+p.data.expiresInSeconds*1000).toISOString(),revision:1,revokedAt:null,acceptedAt:null,acceptedByUserId:null,acceptedMembershipId:null,...(p.data.recipient&&pending?{recipient:p.data.recipient,pendingMembershipId:pending.id}:{})};
  await s.repository.insertInvitation({metadata:row,secretHash:p.data.secretHash});await s.recordChange({entityType:'team_invitation',entityId:row.id,entityRevision:1,action:'issued',diff:{role:row.role,expiresAt:row.expiresAt},outbox:{type:'team.invitation_issued',payload:{invitationId:row.id}}});await s.repository.saveReceipt(context.actor.userId,command,k,h,row,s.barrierAt);return row;
 });},
 async revokeInvitation(context,id,input){const parsed=revokeTeamInvitationInputSchema.safeParse(input);if(!idSchema.safeParse(id).success||!parsed.success)throw invalid();const k=key(context),command='team.invitation.revoke',h=hash({command,id,input:parsed.data});return deps.writer.run(context,'members.manage',async s=>{
  const found=await s.repository.findInvitation(id);if(!found)throw notFoundError();assertTeamRoleGrant(s.access.membership.role,found.metadata.role);const cached=await receipt(s.repository,context.actor.userId,command,k,h);if(cached)return teamInvitationSchema.parse(cached.result);
  const before=found.metadata;if(before.revision!==parsed.data.expectedRevision)throw new DomainError('REVISION_CONFLICT','Invitation changed.');if(before.acceptedAt)throw new DomainError('DOMAIN_VALIDATION_FAILED','An accepted invitation cannot be revoked; revoke the membership instead.');
  const row=before.revokedAt?before:{...before,revision:before.revision+1,revokedAt:s.barrierAt.toISOString()};if(!before.revokedAt){await s.repository.updateInvitation(row);await s.recordChange({entityType:'team_invitation',entityId:id,entityRevision:row.revision,action:'revoked',outbox:{type:'team.invitation_revoked',payload:{invitationId:id}}});}await s.repository.saveReceipt(context.actor.userId,command,k,h,row,s.barrierAt);return row;
 });},
 async updateMembership(context,id,input){const parsed=updateTeamMembershipInputSchema.safeParse(input);if(!idSchema.safeParse(id).success||!parsed.success)throw invalid();const p=parsed.data,k=key(context),command='team.membership.update',h=hash({command,id,input:p});return deps.writer.run(context,'members.manage',async s=>{
  const before=await s.repository.findMember(id);if(!before)throw notFoundError();assertTeamMemberManagement(s.access.membership.role,before,p.role);const cached=await receipt(s.repository,context.actor.userId,command,k,h);if(cached)return teamMembershipSchema.parse(cached.result);
  if(before.pending&&p.state==='active')throw new DomainError('DOMAIN_VALIDATION_FAILED','Generate a new invitation to change an invited person role.');
  if(before.revision!==p.expectedRevision)throw new DomainError('REVISION_CONFLICT','Membership changed.');if(before.state==='revoked'&&p.state==='active')throw new DomainError('DOMAIN_VALIDATION_FAILED','A new invitation is required to restore access.');if(p.state==='revoked'&&p.role!==before.role)throw new DomainError('DOMAIN_VALIDATION_FAILED','Revoke access without changing its role.');
  const changed=before.role!==p.role||before.state!==p.state,row=changed?{...before,role:p.role,state:p.state,revision:before.revision+1,revokedAt:p.state==='revoked'?s.barrierAt.toISOString():null}:before;
  if(changed){await s.repository.updateMember(row,s.barrierAt);await s.repository.bumpPermissionEpoch();await s.recordChange({entityType:'membership',entityId:id,entityRevision:row.revision,action:p.state==='revoked'?'revoked':'role_changed',diff:{role:row.role,state:row.state},outbox:{type:'team.membership_changed',payload:{membershipId:id}}});
   if(before.pending&&p.state==='revoked')for(const invitation of (await s.repository.listInvitations()).filter(i=>i.pendingMembershipId===id&&!i.acceptedAt&&!i.revokedAt)){
    const revoked={...invitation,revision:invitation.revision+1,revokedAt:s.barrierAt.toISOString()};await s.repository.updateInvitation(revoked);
    await s.recordChange({entityType:'team_invitation',entityId:invitation.id,entityRevision:revoked.revision,action:'revoked',outbox:{type:'team.invitation_revoked',payload:{invitationId:invitation.id}}});
   }
  }await s.repository.saveReceipt(context.actor.userId,command,k,h,row,s.barrierAt);return row;
 });},
 async acceptInvitation(context,input){const p=acceptTeamInvitationInputSchema.safeParse(input);if(!p.success)throw invalid();const k=key(context),proof=deps.prove(p.data),command='team.invitation.accept',h=hash({command,invitationId:proof.id,secretHash:proof.secretHash});return deps.admission.run(context,proof,async s=>{
  const mode=validateTeamAdmission(s.invitation.metadata,s.currentMember,s.issuer,context.actor.userId,s.barrierAt);const cached=await receipt(s.repository,context.actor.userId,command,k,h);if(cached)return acceptTeamInvitationResultSchema.parse(cached.result);
  if(mode==='replay'){const result=acceptTeamInvitationResultSchema.parse({workspaceId:s.context.workspaceId,membershipId:s.invitation.metadata.acceptedMembershipId});await s.repository.saveReceipt(context.actor.userId,command,k,h,result,s.barrierAt);return result;}
  const member=s.currentMember?.state==='active'?s.currentMember:await s.admit(s.invitation.metadata.role);
  const row={...s.invitation.metadata,revision:s.invitation.metadata.revision+1,acceptedAt:s.barrierAt.toISOString(),acceptedByUserId:context.actor.userId,acceptedMembershipId:member.id};await s.repository.updateInvitation(row);
  await s.recordChange({entityType:'team_invitation',entityId:row.id,entityRevision:row.revision,action:'accepted',diff:{membershipId:member.id,role:member.role},outbox:{type:'team.invitation_accepted',payload:{invitationId:row.id,membershipId:member.id}}},member.id);
  const result={workspaceId:s.context.workspaceId,membershipId:member.id};await s.repository.saveReceipt(context.actor.userId,command,k,h,result,s.barrierAt);return result;
 });},
 };
}
