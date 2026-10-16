import {randomBytes} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {LOCAL_MCP_READ_TOOLS,localMcpToolCallSchema,localMcpToolResultSchema,LOCAL_MCP_LIMITS,type LocalMcpToolResultDto,type LocalMcpToolName} from '@workloom/contracts';
import {DomainError,authorizeWorkspace,allowedLocalMcpScopes,assertLocalCredentialCurrent,assertLocalMcpScope,LOCAL_MCP_TOOL_SCOPE,LOCAL_MCP_SCOPE_CAPABILITY,listWorkspaceMembers,type LocalMcpApplication} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {projects,memberships,taskFieldDefinitions,taskFieldValues} from '../schema.js';
import {createAccessRepository} from '../repositories/access-repository.js';
import {createTaskApplication} from '../tasks/task-application.js';
import {createTaskFieldApplication} from '../fields/task-field-application.js';
import {parseLocalMcpBearer,resolveLocalMcpContext,bounded,type LocalMcpApplicationOptions} from './credentials.js';
const overflow=()=>{throw new DomainError('DOMAIN_VALIDATION_FAILED','The MCP result exceeds this local pilot bound. Narrow the query.');};
/** Scope and token are revalidated for every discovery/read and inside every write barrier. */
export function createLocalMcpApplication(source:Database|WorkloomExecutor,options:LocalMcpApplicationOptions={}):LocalMcpApplication{
 const db=isDatabase(source)?source.db:source,cursorSecret=options.cursorSecret??randomBytes(32).toString('hex'),enableTaskWrites=options.enableTaskWrites??false;
 async function authorizedRead<T>(bearer:string,requestId:string,tool:LocalMcpToolName|undefined,work:(tx:WorkloomExecutor,resolved:Awaited<ReturnType<typeof resolveLocalMcpContext>>,role:Parameters<typeof allowedLocalMcpScopes>[0])=>Promise<T>):Promise<T>{
  const proof=parseLocalMcpBearer(bearer);return db.transaction(async tx=>{await bounded(tx);const resolved=await resolveLocalMcpContext(tx,proof,requestId),capability=tool?LOCAL_MCP_SCOPE_CAPABILITY[LOCAL_MCP_TOOL_SCOPE[tool]]:'workspace.read',access=await authorizeWorkspace(createAccessRepository(tx),resolved.context,capability);const [clock]=await tx.execute<{at:string}>(sql`select clock_timestamp()::text as at`);if(!clock)throw new Error('Database clock unavailable.');assertLocalCredentialCurrent(resolved.metadata,new Date(clock.at));if(tool)assertLocalMcpScope(resolved.metadata,access.membership.role,tool,enableTaskWrites);return work(tx,resolved,access.membership.role);},{isolationLevel:'repeatable read',accessMode:'read only'});
 }
 return {
 async listTools(bearer,requestId){return authorizedRead(bearer,requestId,undefined,async(_tx,{metadata},role)=>({tools:([...LOCAL_MCP_READ_TOOLS,...(enableTaskWrites?['create_task','update_task'] as const:[])]).filter(tool=>metadata.scopes.includes(LOCAL_MCP_TOOL_SCOPE[tool])&&allowedLocalMcpScopes(role,enableTaskWrites).includes(LOCAL_MCP_TOOL_SCOPE[tool]))}));},
 async callTool(bearer,requestId,input){const parsed=localMcpToolCallSchema.safeParse(input);if(!parsed.success)throw new DomainError('VALIDATION_FAILED','Invalid MCP tool input.');const call=parsed.data;
  if(call.tool==='create_task'||call.tool==='update_task'){
   // Root has not enabled phase B. An actual write is always checked again under the barrier.
   const proof=parseLocalMcpBearer(bearer);const initial=await authorizedRead(bearer,requestId,call.tool,async(_tx,resolved)=>resolved);
   const tasks=createTaskApplication(source,{...options,cursorSecret,authorizeInScope:async scope=>{const resolved=await resolveLocalMcpContext(scope.tx,proof,requestId);if(resolved.context.workspaceId!==scope.context.workspaceId||resolved.context.actor.userId!==scope.context.actor.userId)throw new DomainError('UNAUTHENTICATED','No valid identity is available for this request.');assertLocalCredentialCurrent(resolved.metadata,scope.barrierAt);assertLocalMcpScope(resolved.metadata,scope.access.membership.role,call.tool,enableTaskWrites);return {credentialId:proof.id};}});
   const context={...initial.context,idempotencyKey:call.input.operationKey};const data=call.tool==='create_task'?await tasks.createTask(context,call.input.input):await tasks.updateTask(context,call.input.taskId,call.input.input);return {tool:call.tool,data,nextCursor:null};
  }
  return authorizedRead(bearer,requestId,call.tool,async(tx,{context})=>{
   const ws=context.workspaceId,tasks=createTaskApplication(tx,{cursorSecret}),fields=createTaskFieldApplication(tx,{cursorSecret});let output:unknown;
   switch(call.tool){
    case 'list_projects':if((await tx.select({id:projects.id}).from(projects).where(and(eq(projects.workspaceId,ws),isNull(projects.archivedAt))).limit(501)).length>500)overflow();output={tool:call.tool,data:await tasks.listProjects(context),nextCursor:null};break;
    case 'get_project':output={tool:call.tool,data:await tasks.getProject(context,call.input.projectId),nextCursor:null};break;
    case 'search_tasks':{const page=await tasks.listTasks(context,call.input.query);output={tool:call.tool,data:page.items,nextCursor:page.nextCursor};break;}
    case 'get_task':output={tool:call.tool,data:await tasks.getTask(context,call.input.taskId),nextCursor:null};break;
    case 'list_memberships':if((await tx.select({id:memberships.id}).from(memberships).where(and(eq(memberships.workspaceId,ws),eq(memberships.state,'active'))).limit(1001)).length>1000)overflow();output={tool:call.tool,data:await listWorkspaceMembers(createAccessRepository(tx),context),nextCursor:null};break;
    case 'get_field_definitions':if((await tx.select({id:taskFieldDefinitions.id}).from(taskFieldDefinitions).where(and(eq(taskFieldDefinitions.workspaceId,ws),eq(taskFieldDefinitions.projectId,call.input.projectId))).limit(201)).length>200)overflow();output={tool:call.tool,data:await fields.listFields(context,call.input.projectId),nextCursor:null};break;
    case 'get_task_field_values':if((await tx.select({id:taskFieldValues.fieldId}).from(taskFieldValues).where(and(eq(taskFieldValues.workspaceId,ws),eq(taskFieldValues.taskId,call.input.taskId))).limit(201)).length>200)overflow();output={tool:call.tool,data:await fields.listTaskValues(context,call.input.taskId),nextCursor:null};break;
   }
   const result=localMcpToolResultSchema.safeParse(output);if(!result.success||Buffer.byteLength(JSON.stringify(result.data),'utf8')>LOCAL_MCP_LIMITS.responseBytes-2048)overflow();return result.data as LocalMcpToolResultDto;
  });
 }
 };
}
