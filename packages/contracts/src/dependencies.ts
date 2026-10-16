import {z} from 'zod';
import {envelopeSchema} from './common/envelope.js';
import {idSchema} from './common/ids.js';
import {revisionSchema,taskSchema,taskStatusGroupSchema,utcTimestampSchema} from './tasks.js';

/** P4a current dependency projections; no additions/defaults to historical task inputs or output JSON. */
export const DEPENDENCY_LIMITS={maxRoots:100,maxNodes:500,maxEdges:1000,maxPositions:500} as const;
const nonnegative=z.number().int().nonnegative();
const uniqueIds=(max:number)=>z.array(idSchema).min(1).max(max).refine(v=>new Set(v).size===v.length,'Duplicate IDs.');
const page={limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().min(1).max(4096).optional()};
export const dependencyPolicyModeSchema=z.enum(['warn','enforce']);
export const taskDependencySchema=z.object({id:idSchema,workspaceId:idSchema,predecessorTaskId:idSchema,successorTaskId:idSchema,type:z.literal('finish_to_start'),state:z.enum(['active','removed']),revision:revisionSchema,createdAt:utcTimestampSchema,updatedAt:utcTimestampSchema});
export const projectDependencyPolicySchema=z.object({projectId:idSchema,mode:dependencyPolicyModeSchema,revision:nonnegative,updatedAt:utcTimestampSchema.nullable()});
export const dependencyTaskContextSchema=z.object({project:z.object({id:idSchema,name:z.string(),archivedAt:utcTimestampSchema.nullable()}),status:z.object({id:idSchema,name:z.string(),group:taskStatusGroupSchema})});
export const taskBlockingSummarySchema=z.object({taskId:idSchema,policy:projectDependencyPolicySchema.pick({projectId:true,mode:true,revision:true}),isBlocked:z.boolean(),unresolvedCount:nonnegative,canStart:z.boolean(),canComplete:z.boolean(),violatesCurrentStatus:z.boolean()});
export const taskBlockerSchema=z.object({dependency:taskDependencySchema,predecessor:taskSchema,predecessorContext:dependencyTaskContextSchema});
export const taskBlockingSchema=z.object({summary:taskBlockingSummarySchema,blockers:z.array(taskBlockerSchema),asOfChangeSeq:z.string().regex(/^[0-9]+$/)});
export const graphPositionSchema=z.object({taskId:idSchema,x:z.number().finite().min(-100000).max(100000),y:z.number().finite().min(-100000).max(100000)}).strict();
const positions=z.array(graphPositionSchema).max(DEPENDENCY_LIMITS.maxPositions).refine(v=>new Set(v.map(p=>p.taskId)).size===v.length,'Duplicate task positions.');
export const graphLayoutSchema=z.object({workspaceId:idSchema,projectId:idSchema,membershipId:idSchema,viewKey:z.literal('default'),revision:nonnegative,positions,updatedAt:utcTimestampSchema.nullable()});
export const dependencyGraphSchema=z.object({projectId:idSchema,rootTaskIds:uniqueIds(100),neighborDepth:z.number().int().min(0).max(2),asOfChangeSeq:z.string().regex(/^[0-9]+$/),nodes:z.array(z.object({task:taskSchema,context:dependencyTaskContextSchema,blocking:taskBlockingSummarySchema,hasOutsideDependencies:z.boolean(),outsideUnresolvedPredecessorCount:nonnegative})).max(500),edges:z.array(taskDependencySchema).max(1000)});
export const createTaskDependencyInputSchema=z.object({predecessorTaskId:idSchema,successorTaskId:idSchema,type:z.literal('finish_to_start'),expectedAbsent:z.literal(true)}).strict();
export const updateTaskDependencyInputSchema=z.object({expectedRevision:revisionSchema,state:z.enum(['active','removed'])}).strict();
export const updateDependencyPolicyInputSchema=z.object({expectedRevision:nonnegative,mode:dependencyPolicyModeSchema}).strict();
export const setGraphLayoutInputSchema=z.object({expectedRevision:nonnegative,positions}).strict();
export const taskDependencyListQuerySchema=z.union([
 z.object({taskId:idSchema,direction:z.enum(['incoming','outgoing','both']).default('both'),state:z.enum(['active','removed','all']).default('active'),...page}).strict(),
 z.object({projectId:idSchema,state:z.enum(['active','removed','all']).default('active'),...page}).strict(),
]);
export const taskBlockingQuerySchema=z.object(page).strict();
/** HTTP only: arrays/repeated query params are rejected. Domain receives the separate normalized input. */
export const dependencyGraphQuerySchema=z.object({rootTaskIds:z.string().min(1).transform(v=>v.split(',')).pipe(uniqueIds(100)).transform(v=>v.sort()),neighborDepth:z.enum(['0','1','2']).default('1').transform(v=>Number(v))}).strict();
export const dependencyGraphInputSchema=z.object({rootTaskIds:uniqueIds(100).transform(v=>v.sort()),neighborDepth:z.number().int().min(0).max(2).default(1)}).strict();
export const taskDependencyResponseSchema=envelopeSchema(taskDependencySchema);
export const taskDependencyListResponseSchema=envelopeSchema(z.array(taskDependencySchema));
export const taskBlockingResponseSchema=envelopeSchema(taskBlockingSchema);
export const projectDependencyPolicyResponseSchema=envelopeSchema(projectDependencyPolicySchema);
export const dependencyGraphResponseSchema=envelopeSchema(dependencyGraphSchema);
export const graphLayoutResponseSchema=envelopeSchema(graphLayoutSchema);
export type TaskDependencyDto=z.infer<typeof taskDependencySchema>;
export type ProjectDependencyPolicyDto=z.infer<typeof projectDependencyPolicySchema>;
export type DependencyPolicyMode=z.infer<typeof dependencyPolicyModeSchema>;
export type DependencyTaskContextDto=z.infer<typeof dependencyTaskContextSchema>;
export type TaskBlockingSummaryDto=z.infer<typeof taskBlockingSummarySchema>;
export type TaskBlockerDto=z.infer<typeof taskBlockerSchema>;
export type TaskBlockingDto=z.infer<typeof taskBlockingSchema>;
export type GraphPositionDto=z.infer<typeof graphPositionSchema>;
export type GraphLayoutDto=z.infer<typeof graphLayoutSchema>;
export type DependencyGraphDto=z.infer<typeof dependencyGraphSchema>;
export type CreateTaskDependencyInput=z.infer<typeof createTaskDependencyInputSchema>;
export type UpdateTaskDependencyInput=z.infer<typeof updateTaskDependencyInputSchema>;
export type UpdateDependencyPolicyInput=z.infer<typeof updateDependencyPolicyInputSchema>;
export type SetGraphLayoutInput=z.infer<typeof setGraphLayoutInputSchema>;
export type TaskDependencyListQuery=z.infer<typeof taskDependencyListQuerySchema>;
export type TaskBlockingQuery=z.infer<typeof taskBlockingQuerySchema>;
export type DependencyGraphQuery=z.infer<typeof dependencyGraphInputSchema>;
