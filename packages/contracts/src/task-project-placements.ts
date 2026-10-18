import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { positionSchema, revisionSchema, utcTimestampSchema, projectSchema, taskSchema, taskStatusSchema } from './tasks.js';
export const taskProjectPlacementSchema = z.object({
 id:idSchema,workspaceId:idSchema,taskId:idSchema,projectId:idSchema,homeProjectId:idSchema,
 sectionId:idSchema.nullable(),position:positionSchema,revision:revisionSchema,
 archivedAt:utcTimestampSchema.nullable(),createdAt:utcTimestampSchema,updatedAt:utcTimestampSchema,
}).strict();
export const projectRowSchema=z.object({placement:taskProjectPlacementSchema,canonicalTask:taskSchema,canonicalStatus:taskStatusSchema,homeProject:projectSchema}).strict().superRefine((row,ctx)=>{
 if(row.placement.taskId!==row.canonicalTask.id||row.placement.workspaceId!==row.canonicalTask.workspaceId||row.placement.homeProjectId!==row.canonicalTask.projectId||row.homeProject.id!==row.canonicalTask.projectId||row.homeProject.workspaceId!==row.canonicalTask.workspaceId||row.canonicalStatus.id!==row.canonicalTask.statusId||row.canonicalStatus.projectId!==row.canonicalTask.projectId||row.canonicalStatus.workspaceId!==row.canonicalTask.workspaceId)ctx.addIssue({code:'custom',message:'The row must preserve canonical task, home project and status identity.'});
});
export const attachTaskProjectInputSchema=z.object({projectId:idSchema,expectedTaskRevision:revisionSchema,sectionId:idSchema.nullable().optional(),position:positionSchema.optional()}).strict();
export const updateTaskProjectPlacementInputSchema=z.object({expectedRevision:revisionSchema,sectionId:idSchema.nullable().optional(),position:positionSchema.optional()}).strict().refine(input=>input.sectionId!==undefined||input.position!==undefined,{message:'A placement change is required.'});
export const changeTaskProjectPlacementStateInputSchema=z.object({expectedRevision:revisionSchema}).strict();
export const projectRowsQuerySchema=z.object({cursor:z.string().min(1).max(4096).optional(),limit:z.coerce.number().int().min(1).max(200).default(100),includeArchived:z.union([z.boolean(),z.enum(['true','false'])]).optional().transform(value=>value===true||value==='true')}).strict();
export const taskProjectPlacementResponseSchema=envelopeSchema(taskProjectPlacementSchema);
export const taskProjectPlacementsResponseSchema=envelopeSchema(z.array(taskProjectPlacementSchema));
export const projectRowsResponseSchema=envelopeSchema(z.array(projectRowSchema));
export type TaskProjectPlacementDto=z.infer<typeof taskProjectPlacementSchema>;
export type ProjectRowDto=z.infer<typeof projectRowSchema>;
export type AttachTaskProjectInput=z.infer<typeof attachTaskProjectInputSchema>;
export type UpdateTaskProjectPlacementInput=z.infer<typeof updateTaskProjectPlacementInputSchema>;
export type ChangeTaskProjectPlacementStateInput=z.infer<typeof changeTaskProjectPlacementStateInputSchema>;
export type ProjectRowsQuery=z.infer<typeof projectRowsQuerySchema>;
