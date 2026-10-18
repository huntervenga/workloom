import {z} from 'zod';
import {idSchema,issueTeamInvitationInputSchema,revokeTeamInvitationInputSchema,updateTeamMembershipInputSchema,acceptTeamInvitationInputSchema,teamViewResponseSchema,teamInvitationResponseSchema,teamMembershipResponseSchema,acceptTeamInvitationResponseSchema} from '@workloom/contracts';
import {DomainError,capabilityRequiredError,type TeamApplication,type ActorContext} from '@workloom/domain';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {IdentityAdapter} from '../identity/identity-adapter.js';
import {parseInput,sendData} from './envelope.js';
import {readIdempotencyKey} from './task-routes.js';
export interface TeamRouteDependencies {identity:IdentityAdapter;team:TeamApplication}
const emptyQuery=z.object({}).strict(),workspacePath=z.object({workspaceId:idSchema}).strict(),invitePath=workspacePath.extend({invitationId:idSchema}),memberPath=workspacePath.extend({membershipId:idSchema});
export function registerTeamRoutes(app:FastifyInstance,deps:TeamRouteDependencies):void {
 async function actorContext(request:FastifyRequest,write=false):Promise<ActorContext&{idempotencyKey?:string}>{
  if(deps.identity.mode!=='shared')throw capabilityRequiredError();
  parseInput(emptyQuery,request.query);
  const idempotencyKey=write?readIdempotencyKey(request):undefined,intended=write?parseInput(idSchema,request.headers['x-workloom-actor-id']):undefined;
  const actor=await deps.identity.resolveActor(request);if(actor.kind!=='real')throw capabilityRequiredError();if(intended&&intended.toLowerCase()!==actor.userId.toLowerCase())throw new DomainError('REVISION_CONFLICT','The signed-in account changed. Reload and retry.');
  return {actor,source:'web',requestId:request.id,...(idempotencyKey?{idempotencyKey}:{})};
 }
 app.get('/api/v1/workspaces/:workspaceId/team',async(request,reply)=>{const path=parseInput(workspacePath,request.params),c=await actorContext(request);return sendData(request,reply,teamViewResponseSchema,await deps.team.listTeam({...c,workspaceId:path.workspaceId}));});
 app.post('/api/v1/workspaces/:workspaceId/invitations',async(request,reply)=>{const path=parseInput(workspacePath,request.params),input=parseInput(issueTeamInvitationInputSchema,request.body),c=await actorContext(request,true);return sendData(request,reply,teamInvitationResponseSchema,await deps.team.issueInvitation({...c,workspaceId:path.workspaceId},input),{statusCode:201});});
 app.post('/api/v1/workspaces/:workspaceId/invitations/:invitationId/revoke',async(request,reply)=>{const path=parseInput(invitePath,request.params),input=parseInput(revokeTeamInvitationInputSchema,request.body),c=await actorContext(request,true);return sendData(request,reply,teamInvitationResponseSchema,await deps.team.revokeInvitation({...c,workspaceId:path.workspaceId},path.invitationId,input));});
 app.patch('/api/v1/workspaces/:workspaceId/memberships/:membershipId',async(request,reply)=>{const path=parseInput(memberPath,request.params),input=parseInput(updateTeamMembershipInputSchema,request.body),c=await actorContext(request,true);return sendData(request,reply,teamMembershipResponseSchema,await deps.team.updateMembership({...c,workspaceId:path.workspaceId},path.membershipId,input));});
 app.post('/api/v1/invitations/accept',async(request,reply)=>{const input=parseInput(acceptTeamInvitationInputSchema,request.body),c=await actorContext(request,true);return sendData(request,reply,acceptTeamInvitationResponseSchema,await deps.team.acceptInvitation({...c,idempotencyKey:readIdempotencyKey(request)},input));});
}
