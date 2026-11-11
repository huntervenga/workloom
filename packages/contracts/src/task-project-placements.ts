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
/**
 * Moves a task, with all its subtasks, to another project: the target becomes its home project.
 * With keepFormerHome the former home stays in the task's projects as an ordinary placement, so changing
 * the home is one step and the task stays visible where it was.
 */
export const transferTaskProjectInputSchema=z.object({expectedRevision:revisionSchema,projectId:idSchema,sectionId:idSchema.nullable().optional(),keepFormerHome:z.boolean().optional()}).strict();
export const transferTaskProjectResultSchema=z.object({
 task:taskSchema,movedTaskIds:z.array(idSchema).min(1).max(1000),
 /** Custom-field values that were copied into the target project's matching fields. */
 carriedValues:z.number().int().min(0),
 /** Values with no matching field (or option) in the target; they stay with the former project's detached placement. */
 notCarried:z.array(z.object({fieldName:z.string().min(1).max(160),count:z.number().int().min(1)}).strict()).max(200),
}).strict();
export const transferTaskProjectResponseSchema=envelopeSchema(transferTaskProjectResultSchema);
/** A place in the project's shared order: next to an own task or to another linked placement of the project. */
export const placementOrderAnchorSchema=z.union([z.object({taskId:idSchema}).strict(),z.object({placementId:idSchema}).strict()]);
/**
 * `anchor` moves the placement in the project's shared order (own tasks and linked placements, renumbered together):
 * before or after the anchor and into its section, or with `null` to the end of `sectionId` (or of its current section).
 * `position` sets the raw number instead and cannot be combined with `anchor`.
 */
export const updateTaskProjectPlacementInputSchema=z.object({expectedRevision:revisionSchema,sectionId:idSchema.nullable().optional(),position:positionSchema.optional(),
 anchor:placementOrderAnchorSchema.nullable().optional(),placement:z.enum(['before','after']).optional()}).strict()
 .refine(input=>input.sectionId!==undefined||input.position!==undefined||input.anchor!==undefined,{message:'A placement change is required.'})
 .refine(input=>input.anchor===undefined||input.position===undefined,{message:'Pass either an anchor or a position.',path:['position']})
 .refine(input=>input.anchor===undefined||input.anchor===null||input.placement!==undefined,{message:'Say whether the placement goes before or after the anchor.',path:['placement']});
export const changeTaskProjectPlacementStateInputSchema=z.object({expectedRevision:revisionSchema}).strict();
export const projectRowsQuerySchema=z.object({cursor:z.string().min(1).max(4096).optional(),limit:z.coerce.number().int().min(1).max(200).default(100),includeArchived:z.union([z.boolean(),z.enum(['true','false'])]).optional().transform(value=>value===true||value==='true')}).strict();
export const taskProjectPlacementResponseSchema=envelopeSchema(taskProjectPlacementSchema);
export const taskProjectPlacementsResponseSchema=envelopeSchema(z.array(taskProjectPlacementSchema));
export const projectRowsResponseSchema=envelopeSchema(z.array(projectRowSchema));
export type TaskProjectPlacementDto=z.infer<typeof taskProjectPlacementSchema>;
export type ProjectRowDto=z.infer<typeof projectRowSchema>;
export type AttachTaskProjectInput=z.infer<typeof attachTaskProjectInputSchema>;
export type TransferTaskProjectInput=z.infer<typeof transferTaskProjectInputSchema>;
export type TransferTaskProjectResult=z.infer<typeof transferTaskProjectResultSchema>;
export type UpdateTaskProjectPlacementInput=z.infer<typeof updateTaskProjectPlacementInputSchema>;
export type ChangeTaskProjectPlacementStateInput=z.infer<typeof changeTaskProjectPlacementStateInputSchema>;
export type ProjectRowsQuery=z.infer<typeof projectRowsQuerySchema>;
