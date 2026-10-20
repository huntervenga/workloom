import * as C from '@workloom/contracts';
import {toCommandContext,type CommandContext,type PlanningCheckApplication} from '@workloom/domain';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {IdentityAdapter} from '../identity/identity-adapter.js';
import {parseInput,sendData} from './envelope.js';
import {readIdempotencyKey} from './task-routes.js';
const base='/api/v1/workspaces/:workspaceId/projects/:projectId/planning-checks',project=z.strictObject({workspaceId:C.idSchema,projectId:C.idSchema}),snapshot=project.extend({checkpointId:C.idSchema}),none=z.strictObject({});
export function registerPlanningCheckRoutes(app:FastifyInstance,deps:{identity:IdentityAdapter;checks:PlanningCheckApplication}):void{
 const context=async(request:FastifyRequest,workspaceId:string,key?:string):Promise<CommandContext>=>toCommandContext({actor:await deps.identity.resolveActor(request),source:'web',requestId:request.id},workspaceId,key);
 async function read<P extends{workspaceId:string},Q>(request:FastifyRequest,params:z.ZodType<P>,query:z.ZodType<Q>){const p=parseInput(params,request.params),q=parseInput(query,request.query);return{p,q,ctx:await context(request,p.workspaceId)};}
 async function body<I>(request:FastifyRequest,schema:z.ZodType<I>,write:boolean){const p=parseInput(project,request.params);parseInput(none,request.query);const key=write?readIdempotencyKey(request):undefined,input=parseInput(schema,request.body);return{p,input,ctx:await context(request,p.workspaceId,key)};}
 app.get(`${base}/settings`,async(request,reply)=>{const{p,ctx}=await read(request,project,none);return sendData(request,reply,C.planningCheckSettingsResponseSchema,await deps.checks.getSettings(ctx,p.projectId));});
 app.put(`${base}/settings`,async(request,reply)=>{const{p,input,ctx}=await body(request,C.setPlanningCheckSettingsInputSchema,true);return sendData(request,reply,C.planningCheckSettingsResponseSchema,await deps.checks.setSettings(ctx,p.projectId,input));});
 app.post(`${base}/query`,async(request,reply)=>{const{p,input,ctx}=await body(request,C.queryPlanningChecksInputSchema,false);return sendData(request,reply,C.planningCheckAssessmentResponseSchema,await deps.checks.query(ctx,p.projectId,input));});
 app.get(`${base}/issues`,async(request,reply)=>{const{p,q,ctx}=await read(request,project,C.planningCheckIssueQuerySchema);return sendData(request,reply,C.planningCheckIssuePageResponseSchema,await deps.checks.issues(ctx,p.projectId,q));});
 app.post(`${base}/checkpoints`,async(request,reply)=>{const{p,input,ctx}=await body(request,C.capturePlanningCheckInputSchema,true);return sendData(request,reply,C.planningCheckCheckpointResponseSchema,await deps.checks.capture(ctx,p.projectId,input),{statusCode:201});});
 app.get(`${base}/checkpoints`,async(request,reply)=>{const{p,q,ctx}=await read(request,project,C.planningCheckCheckpointListQuerySchema);return sendData(request,reply,C.planningCheckCheckpointPageResponseSchema,await deps.checks.checkpoints(ctx,p.projectId,q));});
 app.get(`${base}/checkpoints/:checkpointId`,async(request,reply)=>{const{p,ctx}=await read(request,snapshot,none);return sendData(request,reply,C.planningCheckCheckpointResponseSchema,await deps.checks.checkpoint(ctx,p.projectId,p.checkpointId));});
}
