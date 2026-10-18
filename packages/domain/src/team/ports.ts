import type {TeamInvitationDto,TeamMembershipDto,TeamInviteRole} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
import type {WorkspaceWriteScope,ChangeEventInput} from '../transactions/ports.js';
import type {TeamAcceptanceContext} from './application.js';
export interface StoredTeamInvitation {metadata:TeamInvitationDto;secretHash:string}
export interface TeamRepository {
 findInvitation(id:string):Promise<StoredTeamInvitation|null>;
 listInvitations():Promise<TeamInvitationDto[]>;
 insertInvitation(row:StoredTeamInvitation):Promise<void>;
 updateInvitation(row:TeamInvitationDto):Promise<void>;
 listMembers():Promise<TeamMembershipDto[]>;
 findMember(id:string):Promise<TeamMembershipDto|null>;
 updateMember(row:TeamMembershipDto,at:Date):Promise<void>;
 bumpPermissionEpoch():Promise<void>;
 receipt(actor:string,command:string,key:string):Promise<{payloadHash:string;result:unknown}|null>;
 saveReceipt(actor:string,command:string,key:string,payloadHash:string,result:unknown,at:Date):Promise<void>;
}
export interface TeamWriteScope extends WorkspaceWriteScope {repository:TeamRepository}
export interface TeamReader {run<T>(context:CommandContext,work:(scope:Pick<TeamWriteScope,'context'|'access'|'repository'>)=>Promise<T>):Promise<T>}
export interface TeamInvitationProof {id:string;secretHash:string}
/** Only the admission adapter may enter a foreign workspace after proving possession, then taking its barrier. */
export interface TeamAdmissionScope {
 context:CommandContext;barrierAt:Date;repository:TeamRepository;invitation:StoredTeamInvitation;
 currentMember:TeamMembershipDto|null;issuer:TeamMembershipDto|null;
 admit(role:TeamInviteRole):Promise<TeamMembershipDto>;
 recordChange(event:ChangeEventInput,actorMembershipId:string):Promise<void>;
}
export interface TeamAdmissionRunner {run<T>(context:TeamAcceptanceContext,proof:TeamInvitationProof,work:(scope:TeamAdmissionScope)=>Promise<T>):Promise<T>}
