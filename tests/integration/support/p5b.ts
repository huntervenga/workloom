// Real loopback HTTP only. Active secrets stay in memory and are never diagnostic values.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {localCredentialResponseSchema,localCredentialListResponseSchema,localMcpToolsResponseSchema,localMcpToolResponseSchema,type LocalMcpScope,type LocalMcpToolCall,type LocalCredentialDto} from '@workloom/contracts';
import {rawRequest,type RawResponse} from './http.js';
import {expectEnvelope} from './p1a.js';
import {P5aClient} from './p5a.js';
import type {PlanningHarness} from './p2a-fixture.js';
export function credentialMaterial(){const id=randomUUID(),bytes=randomBytes(32),secret=bytes.toString('base64url');const secretHash=createHash('sha256').update(Buffer.concat([Buffer.from(`workloom.local-mcp.secret.v1\0${id}\0`),bytes])).digest('hex');return{id,secret,secretHash,token:`wlm_local_v1_${id}.${secret}`};}
export class P5bClient extends P5aClient {
 credentialPath(id?:string){return `/mcp-credentials${id?`/${id}/revoke`:''}`;}
 async issue(material:ReturnType<typeof credentialMaterial>,scopes:LocalMcpScope[],key?:string){return expectEnvelope(await this.post(this.credentialPath(),{id:material.id,name:'Synthetic local MCP',secretHash:material.secretHash,hashVersion:1,scopes,expiresInSeconds:3600},key),201,localCredentialResponseSchema).data;}
 async credentials(){return expectEnvelope(await this.get(this.credentialPath()),200,localCredentialListResponseSchema).data;}
 async revoke(credential:LocalCredentialDto,key?:string){return expectEnvelope(await this.post(this.credentialPath(credential.id),{expectedRevision:credential.revision},key),200,localCredentialResponseSchema).data;}
 bridge(token:string,tool?:LocalMcpToolCall):Promise<RawResponse>{return rawRequest(this.api.baseUrl,`/api/v1/local-mcp/tools${tool?`/${tool.tool}`:''}`,{method:tool?'POST':'GET',headers:{authorization:`Bearer ${token}`,origin:this.api.baseUrl,...(tool?{'content-type':'application/json'}:{})},...(tool?{body:JSON.stringify(tool.input)}:{})});}
 async tools(token:string){return expectEnvelope(await this.bridge(token),200,localMcpToolsResponseSchema).data;}
 async call(token:string,call:LocalMcpToolCall){return expectEnvelope(await this.bridge(token,call),200,localMcpToolResponseSchema).data;}
}
export function p5bClients(h:PlanningHarness){const wrap=(c:PlanningHarness['owner'])=>new P5bClient(c.api,c.workspaceId);return{owner:wrap(h.owner),replica:wrap(h.replica),member:wrap(h.member),viewer:wrap(h.viewer),outsider:wrap(h.outsider)};}
