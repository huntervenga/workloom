import { z } from 'zod';
import {isImportStringSafe} from './imports.js';
import { idSchema } from './common/ids.js';
import { envelopeSchema } from './common/envelope.js';
import { projectSchema, taskSchema, taskListQuerySchema, createTaskInputSchema, updateTaskInputSchema, utcTimestampSchema } from './tasks.js';
import { membershipSchema } from './workspaces.js';
import { taskFieldDefinitionSchema, taskFieldValueSchema } from './fields.js';
export const LOCAL_MCP_LIMITS = { credentials:100, projects:500, memberships:1000, definitions:200, values:200, responseBytes:2097152 } as const;
export const localMcpScopeSchema=z.enum(['projects.read','tasks.read','members.read','fields.read','tasks.create','tasks.update']);
export type LocalMcpScope=z.infer<typeof localMcpScopeSchema>;
export const LOCAL_MCP_READ_TOOLS=['list_projects','get_project','search_tasks','get_task','list_memberships','get_field_definitions','get_task_field_values'] as const;
export const localMcpToolNameSchema=z.enum([...LOCAL_MCP_READ_TOOLS,'create_task','update_task']);
export type LocalMcpToolName=z.infer<typeof localMcpToolNameSchema>;
const safeName=z.string().trim().min(1).max(100).refine(isImportStringSafe,'Use a valid credential name.');
const scopes=z.array(localMcpScopeSchema).min(1).max(6).refine(x=>new Set(x).size===x.length).transform(x=>[...x].sort());
export const issueLocalCredentialInputSchema=z.object({id:idSchema,name:safeName,secretHash:z.string().regex(/^[a-f0-9]{64}$/),hashVersion:z.literal(1),scopes,expiresInSeconds:z.number().int().min(60).max(86400)}).strict();
export const revokeLocalCredentialInputSchema=z.object({expectedRevision:z.number().int().positive()}).strict();
export const localCredentialSchema=z.object({id:idSchema,workspaceId:idSchema,ownerUserId:idSchema,name:safeName,hashVersion:z.literal(1),scopes,revision:z.number().int().positive(),createdAt:utcTimestampSchema,expiresAt:utcTimestampSchema,revokedAt:utcTimestampSchema.nullable()});
export const localCredentialListSchema=z.object({credentials:z.array(localCredentialSchema).max(100),allowedScopes:z.array(localMcpScopeSchema).max(6)});
export const localMcpToolsSchema=z.object({tools:z.array(localMcpToolNameSchema).max(9)});
const operationKey=z.string().regex(/^[\x21-\x7e]{1,128}$/);
export const localMcpToolCallSchema=z.discriminatedUnion('tool',[
 z.object({tool:z.literal('list_projects'),input:z.object({}).strict()}).strict(),
 z.object({tool:z.literal('get_project'),input:z.object({projectId:idSchema}).strict()}).strict(),
 z.object({tool:z.literal('search_tasks'),input:z.object({query:taskListQuerySchema}).strict()}).strict(),
 z.object({tool:z.literal('get_task'),input:z.object({taskId:idSchema}).strict()}).strict(),
 z.object({tool:z.literal('list_memberships'),input:z.object({}).strict()}).strict(),
 z.object({tool:z.literal('get_field_definitions'),input:z.object({projectId:idSchema}).strict()}).strict(),
 z.object({tool:z.literal('get_task_field_values'),input:z.object({taskId:idSchema}).strict()}).strict(),
 z.object({tool:z.literal('create_task'),input:z.object({operationKey,input:createTaskInputSchema}).strict()}).strict(),
 z.object({tool:z.literal('update_task'),input:z.object({operationKey,taskId:idSchema,input:updateTaskInputSchema}).strict()}).strict(),
]);
export const localMcpToolResultSchema=z.discriminatedUnion('tool',[
 z.object({tool:z.literal('list_projects'),data:z.array(projectSchema).max(500),nextCursor:z.null()}),
 z.object({tool:z.literal('get_project'),data:projectSchema,nextCursor:z.null()}),
 z.object({tool:z.literal('search_tasks'),data:z.array(taskSchema).max(200),nextCursor:z.string().nullable()}),
 z.object({tool:z.literal('get_task'),data:taskSchema,nextCursor:z.null()}),
 z.object({tool:z.literal('list_memberships'),data:z.array(membershipSchema).max(1000),nextCursor:z.null()}),
 z.object({tool:z.literal('get_field_definitions'),data:z.array(taskFieldDefinitionSchema).max(200),nextCursor:z.null()}),
 z.object({tool:z.literal('get_task_field_values'),data:z.array(taskFieldValueSchema).max(200),nextCursor:z.null()}),
 z.object({tool:z.literal('create_task'),data:taskSchema,nextCursor:z.null()}),
 z.object({tool:z.literal('update_task'),data:taskSchema,nextCursor:z.null()}),
]);
export const localCredentialResponseSchema=envelopeSchema(localCredentialSchema);
export const localCredentialListResponseSchema=envelopeSchema(localCredentialListSchema);
export const localMcpToolsResponseSchema=envelopeSchema(localMcpToolsSchema);
export const localMcpToolResponseSchema=envelopeSchema(localMcpToolResultSchema);
export type IssueLocalCredentialInput=z.infer<typeof issueLocalCredentialInputSchema>;
export type RevokeLocalCredentialInput=z.infer<typeof revokeLocalCredentialInputSchema>;
export type LocalCredentialDto=z.infer<typeof localCredentialSchema>;
export type LocalCredentialListDto=z.infer<typeof localCredentialListSchema>;
export type LocalMcpToolsDto=z.infer<typeof localMcpToolsSchema>;
export type LocalMcpToolCall=z.infer<typeof localMcpToolCallSchema>;
export type LocalMcpToolResultDto=z.infer<typeof localMcpToolResultSchema>;
/** Public deterministic bytes; caller hashes with SHA256 using WebCrypto or Node. */
export function localMcpSecretPreimage(credentialId:string,secret:Uint8Array):Uint8Array {
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(credentialId)||secret.length!==32)throw new TypeError('Invalid credential material.');
 const prefix=Uint8Array.from(`workloom.local-mcp.secret.v1\0${credentialId}\0`,x=>x.charCodeAt(0)),bytes=new Uint8Array(prefix.length+32);bytes.set(prefix);bytes.set(secret,prefix.length);return bytes;
}
