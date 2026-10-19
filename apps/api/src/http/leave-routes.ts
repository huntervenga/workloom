import * as C from '@workloom/contracts';
import {toCommandContext,type LeaveApplication} from '@workloom/domain';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {IdentityAdapter} from '../identity/identity-adapter.js';
import {parseInput,sendData} from './envelope.js';
import {readIdempotencyKey} from './task-routes.js';
const base='/api/v1/workspaces/:workspaceId/time-off',workspace=z.strictObject({workspaceId:C.idSchema}),member=workspace.extend({membershipId:C.idSchema}),request=workspace.extend({requestId:C.idSchema}),none=z.strictObject({});
export function registerLeaveRoutes(app:FastifyInstance,deps:{identity:IdentityAdapter;leave:LeaveApplication}):void {
 async function context(req:FastifyRequest,workspaceId:string,write=false){const key=write?readIdempotencyKey(req):undefined;return toCommandContext({actor:await deps.identity.resolveActor(req),source:'web',requestId:req.id},workspaceId,key);}
 async function input<P extends {workspaceId:string},T>(req:FastifyRequest,params:z.ZodType<P>,schema:z.ZodType<T>,write=true){const p=parseInput(params,req.params);parseInput(none,req.query);const body=parseInput(schema,req.body);return {p,body,ctx:await context(req,p.workspaceId,write)};}
 app.get(base+'/overview',async(req,reply)=>{const p=parseInput(workspace,req.params);parseInput(none,req.query);return sendData(req,reply,C.leaveOverviewResponseSchema,await deps.leave.overview(await context(req,p.workspaceId)));});
 app.post(base+'/availability',async(req,reply)=>{const x=await input(req,workspace,C.leaveAvailabilityInputSchema,false);return sendData(req,reply,C.leaveAvailabilityResponseSchema,await deps.leave.availability(x.ctx,x.body));});
 app.post(base+'/preview',async(req,reply)=>{const x=await input(req,workspace,C.previewLeaveRequestInputSchema,false);return sendData(req,reply,C.leaveRequestPreviewResponseSchema,await deps.leave.preview(x.ctx,x.body));});
 app.post(base+'/requests/bulk-preview',async(req,reply)=>{const x=await input(req,workspace,C.bulkLeaveRequestInputSchema,false);return sendData(req,reply,C.leaveBulkPreviewResponseSchema,await deps.leave.previewBulk(x.ctx,x.body));});
 app.post(base+'/settings/preview',async(req,reply)=>{const x=await input(req,workspace,C.putLeaveSettingsInputSchema,false);return sendData(req,reply,C.leaveRecalculationPreviewResponseSchema,await deps.leave.previewSettings(x.ctx,x.body));});
 app.post(base+'/members/:membershipId/profile/preview',async(req,reply)=>{const x=await input(req,member,C.putLeaveProfileInputSchema,false);return sendData(req,reply,C.leaveRecalculationPreviewResponseSchema,await deps.leave.previewProfile(x.ctx,x.p.membershipId,x.body));});
 app.put(base+'/settings',async(req,reply)=>{const x=await input(req,workspace,C.putLeaveSettingsInputSchema);return sendData(req,reply,C.leaveSettingsResponseSchema,await deps.leave.settings(x.ctx,x.body));});
 app.post(base+'/template',async(req,reply)=>{const x=await input(req,workspace,C.applyLeaveTemplateInputSchema);return sendData(req,reply,C.leaveSettingsResponseSchema,await deps.leave.template(x.ctx,x.body));});
 app.put(base+'/members/:membershipId/profile',async(req,reply)=>{const x=await input(req,member,C.putLeaveProfileInputSchema);return sendData(req,reply,C.leaveProfileResponseSchema,await deps.leave.profile(x.ctx,x.p.membershipId,x.body));});
 app.post(base+'/requests',async(req,reply)=>{const x=await input(req,workspace,C.createLeaveRequestInputSchema);return sendData(req,reply,C.leaveRequestResponseSchema,await deps.leave.create(x.ctx,x.body),{statusCode:201});});
 app.post(base+'/requests/bulk',async(req,reply)=>{const x=await input(req,workspace,C.bulkLeaveRequestInputSchema);return sendData(req,reply,C.leaveRequestListResponseSchema,await deps.leave.bulk(x.ctx,x.body),{statusCode:201,list:true});});
 app.patch(base+'/requests/:requestId',async(req,reply)=>{const x=await input(req,request,C.updateLeaveRequestInputSchema);return sendData(req,reply,C.leaveRequestResponseSchema,await deps.leave.update(x.ctx,x.p.requestId,x.body));});
 app.post(base+'/requests/:requestId/decision',async(req,reply)=>{const x=await input(req,request,C.decideLeaveRequestInputSchema);return sendData(req,reply,C.leaveRequestResponseSchema,await deps.leave.decide(x.ctx,x.p.requestId,x.body));});
 app.post(base+'/adjustments',async(req,reply)=>{const x=await input(req,workspace,C.createLeaveAdjustmentInputSchema);return sendData(req,reply,C.leaveAdjustmentResponseSchema,await deps.leave.adjustment(x.ctx,x.body),{statusCode:201});});
}
