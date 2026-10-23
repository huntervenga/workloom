import { z } from 'zod';
import { idSchema } from './common/ids.js';
import { envelopeSchema } from './common/envelope.js';

/**
 * Optional per-project rules that people with project settings access can switch on. Every rule is off until chosen, and a
 * rule only restricts what people can do from now on: existing data is never rewritten by it.
 */
export const projectRulesConfigSchema = z.strictObject({
  /** A task of this project cannot also be placed in another project, and no task can be added to it from elsewhere. */
  singleProject: z.boolean(),
});
export const EMPTY_PROJECT_RULES = { singleProject: false } as const;

export const projectRulesSchema = z.strictObject({ workspaceId: idSchema, projectId: idSchema, revision: z.number().int().nonnegative(), config: projectRulesConfigSchema });
export const setProjectRulesInputSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), config: projectRulesConfigSchema });
export const projectRulesResponseSchema = envelopeSchema(projectRulesSchema);

export type ProjectRulesConfig = z.infer<typeof projectRulesConfigSchema>;
export type ProjectRulesDto = z.infer<typeof projectRulesSchema>;
export type SetProjectRulesInput = z.infer<typeof setProjectRulesInputSchema>;
