import {z} from 'zod';
import {idSchema} from './common/ids.js';
import {envelopeSchema} from './common/envelope.js';
import {revisionSchema,taskSchema,utcTimestampSchema} from './tasks.js';
import {taskFieldDataSchema} from './fields.js';
export const IMPORT_LIMITS={maxCsvBytes:1048576,maxTasks:50,maxColumns:100,maxCellLength:20000,maxMappings:100,maxCustomFields:20,maxParentDepth:20} as const;
/** PostgreSQL text/JSONB cannot store NUL or lone UTF16 surrogates. Never repair accepted raw source. */
export function isImportStringSafe(value:string):boolean {for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c===0)return false;if(c>=0xd800&&c<=0xdbff){const n=value.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;}
const text=(max:number)=>z.string().max(max).refine(isImportStringSafe,'NUL and unpaired surrogates are not supported.');
const column=z.number().int().min(0).max(99);
const sourceValue=text(254).trim().min(1);
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const meaning=z.enum(['ordinary','current_estimate','current_actual']);
const unit=z.enum(['minutes','hours']);
const people=z.array(z.object({sourceValue,membershipId:idSchema}).strict()).max(100);
const statuses=z.array(z.object({sourceValue,statusId:idSchema}).strict()).max(100);
const sections=z.array(z.object({sourceValue,sectionId:idSchema}).strict()).max(100);
const tags=z.array(z.object({sourceValue,tagId:idSchema}).strict()).max(100);
const delimiter=z.enum([';','|',',']);
export const projectImportMappingSchema=z.object({
 externalIdColumn:column,titleColumn:column,defaultStatusId:idSchema,dateFormat:z.enum(['iso','us']),shareableScopeConfirmed:z.boolean(),
 descriptionColumn:column.optional(),startDateColumn:column.optional(),dueDateColumn:column.optional(),parentExternalIdColumn:column.optional(),responsibleColumn:column.optional(),participantsColumn:column.optional(),statusColumn:column.optional(),sectionColumn:column.optional(),tagsColumn:column.optional(),privateColumn:column.optional(),
 participantsDelimiter:delimiter.optional(),tagsDelimiter:delimiter.optional(),assigneeIsParticipant:z.boolean().optional(),
 people,statuses,sections,tags,
 customFields:z.array(z.object({column,fieldId:idSchema,expectedDefinitionRevision:revisionSchema,empty:z.enum(['missing','null']),sourceMeaning:meaning,sourceUnit:unit.optional()}).strict()).max(20),
 preserveColumns:z.array(column).max(100),
}).strict().superRefine((v,c)=>{
 if(v.people.length+v.statuses.length+v.sections.length+v.tags.length>100)c.addIssue({code:'custom',message:'At most100 reference mappings in total.'});
 for(const list of [v.people,v.statuses,v.sections,v.tags])if(new Set(list.map(x=>x.sourceValue)).size!==list.length)c.addIssue({code:'custom',message:'Duplicate source mapping.'});
 if(new Set(v.customFields.map(x=>x.fieldId)).size!==v.customFields.length||new Set(v.customFields.map(x=>x.column)).size!==v.customFields.length||new Set(v.preserveColumns).size!==v.preserveColumns.length)c.addIssue({code:'custom',message:'Duplicate field or column mapping.'});
 const columns=[v.externalIdColumn,v.titleColumn,v.descriptionColumn,v.startDateColumn,v.dueDateColumn,v.parentExternalIdColumn,v.responsibleColumn,v.participantsColumn,v.statusColumn,v.sectionColumn,v.tagsColumn,v.privateColumn,...v.customFields.map(x=>x.column)].filter((x):x is number=>x!==undefined);
 if(new Set(columns).size!==columns.length||v.preserveColumns.some(x=>columns.includes(x)))c.addIssue({code:'custom',message:'Core, custom and preserved columns must not overlap.'});
 if(v.participantsColumn!==undefined&&v.participantsDelimiter===undefined)c.addIssue({code:'custom',path:['participantsDelimiter'],message:'Choose the participant delimiter explicitly.'});
 if(v.tagsColumn!==undefined&&v.tagsDelimiter===undefined)c.addIssue({code:'custom',path:['tagsDelimiter'],message:'Choose the tag delimiter explicitly.'});
}).transform(v=>({...v,people:[...v.people].sort((a,b)=>compare(a.sourceValue,b.sourceValue)),statuses:[...v.statuses].sort((a,b)=>compare(a.sourceValue,b.sourceValue)),sections:[...v.sections].sort((a,b)=>compare(a.sourceValue,b.sourceValue)),tags:[...v.tags].sort((a,b)=>compare(a.sourceValue,b.sourceValue)),customFields:[...v.customFields].sort((a,b)=>compare(a.fieldId,b.fieldId)),preserveColumns:[...v.preserveColumns].sort((a,b)=>a-b)}));
export const stageCsvImportInputSchema=z.object({fileName:text(255).min(1),sourceNamespace:text(160).min(1),csvText:z.string().max(1048576).refine(isImportStringSafe,'NUL and unpaired surrogates are not supported.')}).strict();
export const previewProjectImportInputSchema=z.object({expectedImportRevision:revisionSchema,mapping:projectImportMappingSchema}).strict();
export const applyProjectImportInputSchema=z.object({expectedImportRevision:revisionSchema,mapping:projectImportMappingSchema,previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const projectImportSchema=z.object({id:idSchema,workspaceId:idSchema,projectId:idSchema,sourceNamespace:text(160),fileName:text(255),fileDigest:z.string().regex(/^[a-f0-9]{64}$/),revision:revisionSchema,status:z.enum(['staged','applied']),headers:z.array(text(20000)).min(1).max(100),sourceRows:z.array(z.object({rowNumber:z.number().int().min(1).max(50),cells:z.array(text(20000)).max(100)})).max(50),createdAt:utcTimestampSchema,appliedAt:utcTimestampSchema.nullable()});
export const projectImportIssueSchema=z.object({severity:z.enum(['blocking','warning']),code:z.enum(['missing_external_id','duplicate_external_id','missing_title','unmapped_person','unmapped_status','unmapped_section','unmapped_tag','unmapped_column','invalid_date','invalid_value','invalid_field','parent_missing','parent_cycle','target_changed','source_changed','private_source','scope_unconfirmed','unsupported_relationship']),rowNumber:z.number().int().min(1).nullable(),column:column.nullable(),message:text(1000)});
const customValue=z.object({fieldId:idSchema,value:taskFieldDataSchema,sourceMeaning:meaning,sourceUnit:unit.optional()});
export const projectImportPreviewSchema=z.object({importId:idSchema,projectId:idSchema,importRevision:revisionSchema,sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),previewHash:z.string().regex(/^[a-f0-9]{64}$/),rows:z.array(z.object({rowNumber:z.number().int().min(1),externalId:text(254).nullable(),targetTaskId:idSchema.nullable(),action:z.enum(['create','skip','conflict','blocked']),title:text(20000),parentExternalId:text(254).nullable(),customValues:z.array(customValue).max(20)})).max(50),issues:z.array(projectImportIssueSchema),summary:z.object({sourceRows:z.number().int().nonnegative(),createCount:z.number().int().nonnegative(),skipCount:z.number().int().nonnegative(),conflictCount:z.number().int().nonnegative(),blockedCount:z.number().int().nonnegative(),preservedColumnCount:z.number().int().nonnegative()}),recoveryPeriodIds:z.array(idSchema)});
export const importOwnedRevisionsSchema=z.object({taskRevision:revisionSchema,participantsRevision:revisionSchema,workPackageRevision:revisionSchema,fields:z.array(z.object({fieldId:idSchema,definitionRevision:revisionSchema,valueRevision:z.number().int().nonnegative()})).max(20)});
const reconciliationBase={importId:idSchema,projectId:idSchema,sourceRows:z.number().int().min(0).max(50)};
export const projectImportReconciliationSchema=z.discriminatedUnion('status',[
 z.object({...reconciliationBase,status:z.literal('staged'),createdCount:z.literal(0),skippedCount:z.literal(0),rows:z.array(z.never()).length(0),appliedAt:z.null()}),
 z.object({...reconciliationBase,status:z.literal('applied'),createdCount:z.number().int().nonnegative(),skippedCount:z.number().int().nonnegative(),rows:z.array(z.object({rowNumber:z.number().int().min(1),externalId:text(254),targetTaskId:idSchema,state:z.enum(['created','skipped']),ownedRevisions:importOwnedRevisionsSchema})).max(50),appliedAt:utcTimestampSchema,sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),mappingHash:z.string().regex(/^[a-f0-9]{64}$/),mapping:projectImportMappingSchema}),
]);
export const projectImportAppliedSchema=z.object({import:projectImportSchema,reconciliation:projectImportReconciliationSchema,tasks:z.array(taskSchema).max(50),asOfChangeSeq:z.string().regex(/^[0-9]+$/)});
export const projectImportResponseSchema=envelopeSchema(projectImportSchema);
export const projectImportPreviewResponseSchema=envelopeSchema(projectImportPreviewSchema);
export const projectImportAppliedResponseSchema=envelopeSchema(projectImportAppliedSchema);
export const projectImportReconciliationResponseSchema=envelopeSchema(projectImportReconciliationSchema);
export type StageCsvImportInput=z.infer<typeof stageCsvImportInputSchema>;
export type ProjectImportMapping=z.infer<typeof projectImportMappingSchema>;
export type PreviewProjectImportInput=z.infer<typeof previewProjectImportInputSchema>;
export type ApplyProjectImportInput=z.infer<typeof applyProjectImportInputSchema>;
export type ProjectImportDto=z.infer<typeof projectImportSchema>;
export type ProjectImportIssueDto=z.infer<typeof projectImportIssueSchema>;
export type ProjectImportPreviewDto=z.infer<typeof projectImportPreviewSchema>;
export type ProjectImportReconciliationDto=z.infer<typeof projectImportReconciliationSchema>;
export type ProjectImportAppliedDto=z.infer<typeof projectImportAppliedSchema>;
export type ImportOwnedRevisions=z.infer<typeof importOwnedRevisionsSchema>;
