import * as C from '@workloom/contracts';
import {toCommandContext,type SummaryTemplateApplication} from '@workloom/domain';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {IdentityAdapter} from '../identity/identity-adapter.js';
import {parseInput,sendData} from './envelope.js';
import {readIdempotencyKey} from './task-routes.js';
const base='/api/v1/workspaces/:workspaceId/projects/:projectId',project=z.strictObject({workspaceId:C.idSchema,projectId:C.idSchema}),template=project.extend({templateId:C.idSchema}),binding=project.extend({bindingId:C.idSchema}),none=z.strictObject({});
export function registerSummaryTemplateRoutes(app:FastifyInstance,deps:{identity:IdentityAdapter;templates:SummaryTemplateApplication}):void{
 async function body<P extends {workspaceId:string},I>(request:FastifyRequest,params:z.ZodType<P>,schema:z.ZodType<I>){const p=parseInput(params,request.params);parseInput(none,request.query);const key=readIdempotencyKey(request),input=parseInput(schema,request.body),ctx=toCommandContext({actor:await deps.identity.resolveActor(request),source:'web',requestId:request.id},p.workspaceId,key);return{p,input,ctx};}
 app.get(`${base}/summary-templates`,async(request,reply)=>{const p=parseInput(project,request.params);parseInput(none,request.query);const ctx=toCommandContext({actor:await deps.identity.resolveActor(request),source:'web',requestId:request.id},p.workspaceId);return sendData(request,reply,C.summaryTemplateCatalogResponseSchema,await deps.templates.catalog(ctx,p.projectId));});
 app.post(`${base}/summary-templates`,async(request,reply)=>{const{p,input,ctx}=await body(request,project,C.createSummaryTemplateInputSchema);return sendData(request,reply,C.summaryTemplateCatalogResponseSchema,await deps.templates.create(ctx,p.projectId,input),{statusCode:201});});
 app.patch(`${base}/summary-templates/:templateId`,async(request,reply)=>{const{p,input,ctx}=await body(request,template,C.updateSummaryTemplateInputSchema);return sendData(request,reply,C.summaryTemplateCatalogResponseSchema,await deps.templates.update(ctx,p.projectId,p.templateId,input));});
 app.put(`${base}/summary-template-bindings`,async(request,reply)=>{const{p,input,ctx}=await body(request,project,C.bindSummaryTemplateInputSchema);return sendData(request,reply,C.summaryTemplateCatalogResponseSchema,await deps.templates.bind(ctx,p.projectId,input));});
 app.patch(`${base}/summary-template-bindings/:bindingId`,async(request,reply)=>{const{p,input,ctx}=await body(request,binding,C.customizeSummaryTemplateInputSchema);return sendData(request,reply,C.summaryTemplateCatalogResponseSchema,await deps.templates.customize(ctx,p.projectId,p.bindingId,input));});
 for(const command of ['reset','detach'] as const)app.post(`${base}/summary-template-bindings/:bindingId/${command}`,async(request,reply)=>{const{p,input,ctx}=await body(request,binding,C.resetSummaryTemplateInputSchema);return sendData(request,reply,C.summaryTemplateCatalogResponseSchema,await deps.templates[command](ctx,p.projectId,p.bindingId,input));});
}
