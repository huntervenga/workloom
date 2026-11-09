import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';

export const projectViewSettingsSchema = z.strictObject({
  view: z.enum(['table', 'board', 'gantt', 'graph']),
  grouping: z.enum(['section', 'assignee']),
  sort: z.enum(['manual', 'due_asc']),
  search: z.string().max(200),
  completion: z.enum(['all', 'open']),
  statusId: idSchema.nullable(),
  participantMembershipId: idSchema.nullable(),
  tagId: idSchema.nullable(),
  includeArchived: z.boolean(),
});
export const savedProjectViewSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  settings: projectViewSettingsSchema,
});
export const projectViewListSchema = z.array(savedProjectViewSchema).max(24).refine(
  views => new Set(views.map(view => view.id)).size === views.length &&
    new Set(views.map(view => view.name.normalize('NFC').toLowerCase())).size === views.length,
  'View IDs and names must be unique.',
);
const revision = z.number().int().min(0).max(2147483647);
export const projectViewsSchema = z.strictObject({
  workspaceId: idSchema, projectId: idSchema, revision, views: projectViewListSchema,
});
export const setProjectViewsInputSchema = z.strictObject({ expectedRevision: revision, views: projectViewListSchema });
export const projectViewsResponseSchema = envelopeSchema(projectViewsSchema);
export type ProjectViewSettings = z.infer<typeof projectViewSettingsSchema>;
export type SavedProjectView = z.infer<typeof savedProjectViewSchema>;
export type ProjectViewsDto = z.infer<typeof projectViewsSchema>;
export type SetProjectViewsInput = z.infer<typeof setProjectViewsInputSchema>;
