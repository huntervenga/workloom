import type {AcceptTeamInvitationInput,AcceptTeamInvitationResult,IssueTeamInvitationInput,RevokeTeamInvitationInput,UpdateTeamMembershipInput,TeamInvitationDto,TeamMembershipDto,TeamViewDto} from '@workloom/contracts';
import type {ActorContext,CommandContext} from '../access/context.js';
export interface TeamAcceptanceContext extends ActorContext {readonly idempotencyKey:string}
export interface TeamApplication {
 listTeam(context:CommandContext):Promise<TeamViewDto>;
 issueInvitation(context:CommandContext,input:IssueTeamInvitationInput):Promise<TeamInvitationDto>;
 revokeInvitation(context:CommandContext,id:string,input:RevokeTeamInvitationInput):Promise<TeamInvitationDto>;
 updateMembership(context:CommandContext,id:string,input:UpdateTeamMembershipInput):Promise<TeamMembershipDto>;
 acceptInvitation(context:TeamAcceptanceContext,input:AcceptTeamInvitationInput):Promise<AcceptTeamInvitationResult>;
}
