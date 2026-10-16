import {idSchema,LOCAL_MCP_READ_TOOLS,issueLocalCredentialInputSchema,revokeLocalCredentialInputSchema,localCredentialResponseSchema,localCredentialListResponseSchema,localMcpToolsResponseSchema,localMcpToolResponseSchema,localMcpToolCallSchema} from '@workloom/contracts';
import {toCommandContext,unauthenticatedError,type LocalCredentialApplication,type LocalMcpApplication} from '@workloom/domain';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import type {IdentityAdapter} from '../identity/identity-adapter.js';
import {parseInput,sendData} from './envelope.js';
import {readIdempotencyKey} from './task-routes.js';
import {assertTrustedOrigin,type RequestGuardOptions} from './request-guards.js';
const base='/api/v1/workspaces/:workspaceId/mcp-credentials';
const workspace=z.object({workspaceId:idSchema});const credential=workspace.extend({credentialId:idSchema});const empty=z.strictObject({});
export interface LocalMcpRouteDependencies {readonly identity:IdentityAdapter;readonly credentials:LocalCredentialApplication;readonly mcp:LocalMcpApplication;readonly guards:RequestGuardOptions}
function bearer(request:FastifyRequest):string {
 const value=request.headers.authorization;
 if(typeof value!=='string'||!/^Bearer [^\s]+$/.test(value)||value.length>256)throw unauthenticatedError();
 return value.slice(7);
}
export function registerLocalMcpRoutes(app:FastifyInstance,deps:LocalMcpRouteDependencies):void {
 async function context(request:FastifyRequest,workspaceId:string,key?:string){const actor=await deps.identity.resolveActor(request);return toCommandContext({actor,source:'web',requestId:request.id},workspaceId,key);}
 app.post(base,async(request,reply)=>{const p=parseInput(workspace,request.params);parseInput(empty,request.query);const key=readIdempotencyKey(request),input=parseInput(issueLocalCredentialInputSchema,request.body);return sendData(request,reply,localCredentialResponseSchema,await deps.credentials.issueCredential(await context(request,p.workspaceId,key),input),{statusCode:201});});
 app.get(base,async(request,reply)=>{const p=parseInput(workspace,request.params);parseInput(empty,request.query);return sendData(request,reply,localCredentialListResponseSchema,await deps.credentials.listCredentials(await context(request,p.workspaceId)));});
 app.post(`${base}/:credentialId/revoke`,async(request,reply)=>{const p=parseInput(credential,request.params);parseInput(empty,request.query);const key=readIdempotencyKey(request),input=parseInput(revokeLocalCredentialInputSchema,request.body);return sendData(request,reply,localCredentialResponseSchema,await deps.credentials.revokeCredential(await context(request,p.workspaceId,key),p.credentialId,input));});
 // These routes never resolve the browser/dev identity: bearer is the only identity boundary.
 app.get('/api/v1/local-mcp/tools',async(request,reply)=>{assertTrustedOrigin({method:'POST',headers:request.headers},deps.guards);parseInput(empty,request.query);return sendData(request,reply,localMcpToolsResponseSchema,await deps.mcp.listTools(bearer(request),request.id));});
 async function dispatch(tool:string,request:FastifyRequest,reply:FastifyReply){parseInput(empty,request.query);const token=bearer(request);const call=parseInput(localMcpToolCallSchema,{tool,input:request.body});return sendData(request,reply,localMcpToolResponseSchema,await deps.mcp.callTool(token,request.id,call));}
 app.post('/api/v1/local-mcp/tools/:toolName',async(request,reply)=>{const p=parseInput(z.object({toolName:z.enum(LOCAL_MCP_READ_TOOLS)}),request.params);return dispatch(p.toolName,request,reply);});
 // Exact literal routes alone accept full escaped shared task descriptions/participants.
 for(const tool of ['create_task','update_task'] as const)app.post(`/api/v1/local-mcp/tools/${tool}`,{bodyLimit:256*1024},async(request,reply)=>dispatch(tool,request,reply));
}
