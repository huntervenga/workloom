import {z} from 'zod';
import {idSchema} from './ids.js';

/** Standalone snapshot schema: no planning/categories imports and no runtime cycle. */
export const workCategorySnapshotSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('categorized'),bindingVersionId:idSchema,bindingRevision:z.number().int().min(1),fieldId:idSchema,fieldDefinitionVersionId:idSchema,fieldLabel:z.string(),optionId:idSchema,optionRevision:z.number().int().min(1),optionLabel:z.string(),color:z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),optionArchivedAt:z.iso.datetime().nullable()}),
 z.object({kind:z.literal('uncategorized'),reason:z.enum(['legacy','unbound','field_unavailable','unset','explicit_clear']),bindingVersionId:idSchema.nullable(),bindingRevision:z.number().int().min(1).nullable(),fieldId:idSchema.nullable()}),
]);
export type WorkCategorySnapshot=z.infer<typeof workCategorySnapshotSchema>;
