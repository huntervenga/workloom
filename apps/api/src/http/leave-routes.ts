import * as C from '@workloom/contracts';
import {toCommandContext,type LeaveApplication} from '@workloom/domain';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {IdentityAdapter} from '../identity/identity-adapter.js';
import {parseInput,sendData} from './envelope.js';
import {readIdempotencyKey} from './task-routes.js';
const base='/api/v1/workspaces/:workspaceId/time-off',workspace=z.strictObject({workspaceId:C.idSchema}),member=workspace.extend({membershipId:C.idSchema}),request=workspace.extend({requestId:C.idSchema}),none=z.strictObject({});
/** Move internal diagnostics into compatible envelope metadata, never strict payload data. */
function leavePresentation(value: unknown): { data: unknown; leaveWarnings?: C.LeaveWarningsDto } {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return { data: value };
 const { warnings, ...data } = value as Record<string, unknown>;
 const parsed = C.leaveWarningsSchema.safeParse(warnings);
 if (warnings !== undefined && !parsed.success) throw new Error('Leave diagnostics did not match their contract.');
 let result = parsed.success ? parsed.data : undefined;
 if (Array.isArray(data.previews)) {
  const children: C.LeaveWarningsDto[] = [];
  data.previews = data.previews.map((row: unknown) => {
   if (!row || typeof row !== 'object') return row;
   const item = row as Record<string, unknown>, presentation = leavePresentation(item.preview);
   if (presentation.leaveWarnings) children.push(presentation.leaveWarnings);
   return { ...item, preview: presentation.data };
  });
  if (!result && children.length) {
   const unique = new Map(children.flatMap(child => child.warnings).map(warning => [JSON.stringify(warning), warning]));
   const totalCount = children.reduce((sum, child) => sum + child.totalCount, 0);
   result = { warnings: [...unique.values()].slice(0, 100), totalCount, truncated: totalCount > 100 || children.some(child => child.truncated) };
  }
 }
 return { data, ...(result ? { leaveWarnings: result } : {}) };
}
export function registerLeaveRoutes(app:FastifyInstance,deps:{identity:IdentityAdapter;leave:LeaveApplication}):void {
 async function context(req:FastifyRequest,workspaceId:string,write=false){const key=write?readIdempotencyKey(req):undefined;return toCommandContext({actor:await deps.identity.resolveActor(req),source:'web',requestId:req.id},workspaceId,key);}
 async function input<P extends {workspaceId:string},T>(req:FastifyRequest,params:z.ZodType<P>,schema:z.ZodType<T>,write=true){const p=parseInput(params,req.params);parseInput(none,req.query);const body=parseInput(schema,req.body);return {p,body,ctx:await context(req,p.workspaceId,write)};}
 app.get(base+'/overview',async(req,reply)=>{const p=parseInput(workspace,req.params);parseInput(none,req.query);const result=leavePresentation(await deps.leave.overview(await context(req,p.workspaceId)));return sendData(req,reply,C.leaveOverviewResponseSchema,result.data,result);});
 app.post(base+'/availability',async(req,reply)=>{const x=await input(req,workspace,C.leaveAvailabilityInputSchema,false);return sendData(req,reply,C.leaveAvailabilityResponseSchema,await deps.leave.availability(x.ctx,x.body));});
 app.post(base+'/preview',async(req,reply)=>{const x=await input(req,workspace,C.previewLeaveRequestInputSchema,false);const result=leavePresentation(await deps.leave.preview(x.ctx,x.body));return sendData(req,reply,C.leaveRequestPreviewResponseSchema,result.data,result);});
 app.post(base+'/requests/bulk-preview',async(req,reply)=>{const x=await input(req,workspace,C.bulkLeaveRequestInputSchema,false);const result=leavePresentation(await deps.leave.previewBulk(x.ctx,x.body));return sendData(req,reply,C.leaveBulkPreviewResponseSchema,result.data,result);});
 app.post(base+'/settings/preview',async(req,reply)=>{const x=await input(req,workspace,C.putLeaveSettingsInputSchema,false);const result=leavePresentation(await deps.leave.previewSettings(x.ctx,x.body));return sendData(req,reply,C.leaveRecalculationPreviewResponseSchema,result.data,result);});
 app.post(base+'/members/:membershipId/profile/preview',async(req,reply)=>{const x=await input(req,member,C.putLeaveProfileInputSchema,false);const result=leavePresentation(await deps.leave.previewProfile(x.ctx,x.p.membershipId,x.body));return sendData(req,reply,C.leaveRecalculationPreviewResponseSchema,result.data,result);});
 app.put(base+'/settings',async(req,reply)=>{const x=await input(req,workspace,C.putLeaveSettingsInputSchema);return sendData(req,reply,C.leaveSettingsResponseSchema,await deps.leave.settings(x.ctx,x.body));});
 app.post(base+'/template',async(req,reply)=>{const x=await input(req,workspace,C.applyLeaveTemplateInputSchema);return sendData(req,reply,C.leaveSettingsResponseSchema,await deps.leave.template(x.ctx,x.body));});
 app.put(base+'/members/:membershipId/profile',async(req,reply)=>{const x=await input(req,member,C.putLeaveProfileInputSchema);return sendData(req,reply,C.leaveProfileResponseSchema,await deps.leave.profile(x.ctx,x.p.membershipId,x.body));});
 app.post(base+'/requests',async(req,reply)=>{const x=await input(req,workspace,C.createLeaveRequestInputSchema);return sendData(req,reply,C.leaveRequestResponseSchema,await deps.leave.create(x.ctx,x.body),{statusCode:201});});
 app.post(base+'/requests/bulk',async(req,reply)=>{const x=await input(req,workspace,C.bulkLeaveRequestInputSchema);return sendData(req,reply,C.leaveRequestListResponseSchema,await deps.leave.bulk(x.ctx,x.body),{statusCode:201,list:true});});
 app.patch(base+'/requests/:requestId',async(req,reply)=>{const x=await input(req,request,C.updateLeaveRequestInputSchema);return sendData(req,reply,C.leaveRequestResponseSchema,await deps.leave.update(x.ctx,x.p.requestId,x.body));});
 app.post(base+'/requests/:requestId/decision',async(req,reply)=>{const x=await input(req,request,C.decideLeaveRequestInputSchema);return sendData(req,reply,C.leaveRequestResponseSchema,await deps.leave.decide(x.ctx,x.p.requestId,x.body));});
 app.post(base+'/adjustments',async(req,reply)=>{const x=await input(req,workspace,C.createLeaveAdjustmentInputSchema);return sendData(req,reply,C.leaveAdjustmentResponseSchema,await deps.leave.adjustment(x.ctx,x.body),{statusCode:201});});
}
