export * from './common/envelope.js';
export * from './common/ids.js';
export * from './fields.js';
export * from './identity.js';
export * from './tasks.js';
export * from './workspaces.js';
export * from './planning.js';
export * from './common/work-category.js';
export * from './categories.js';
export * from './common/recorded-work.js';
export * from './meetings.js';
export * from './recurrence.js';
export * from './dependencies.js';

export * from './schedule.js';

export * from './imports.js';
export * from './local-mcp.js';
export * from './automation.js';
export * from './task-defaults.js';
export * from './project-copy.js';
export * from './task-continuation.js';

export * from './inbox.js';
export * from './my-tasks.js';
export { createTaskCommentInputSchema, taskCommentSchema, taskCommentsQuerySchema, taskActivityQuerySchema, taskCommentResponseSchema, taskCommentsResponseSchema, taskActivityKindSchema, taskActivitySchema, taskActivityResponseSchema } from './task-comments.js';
export type { CreateTaskCommentInput, TaskCommentDto, TaskCommentsQueryInput, TaskActivityQueryInput, TaskTimelineQuery, TaskActivityDto } from './task-comments.js';
export { taskTableBuiltinColumnSchema, tableColumnRefSchema, columnChoiceSchema, personalTablePreferenceSchema, updatePersonalTablePreferenceInputSchema, personalTablePreferenceResponseSchema } from './table-preferences.js';
export type { TaskTableBuiltinColumn, TableColumnRef, ColumnChoice, PersonalTablePreferenceDto, UpdatePersonalTablePreferenceInput } from './table-preferences.js';

export * from './cutoff.js';

export * from './workspace-change-head.js';

export { createWorkspaceInputSchema, isSupportedWorkspaceTimezone } from './workspace-create.js';
export type { CreateWorkspaceInput } from './workspace-create.js';

export * from './task-row.js';

export { safeProfilePhotoUrl, profilePhotoUrlSchema, MAX_PROFILE_PHOTO_URL_LENGTH } from './profile-photo.js';
export type { ProfilePhotoUrl } from './profile-photo.js';

// One bounded comments-and-actions feed; legacy comments/activity exports remain unchanged.
export { taskTimelineQuerySchema, taskTimelineItemSchema, taskTimelineResponseSchema, taskTimelineActivityKindSchema, taskActivityChangeSchema, taskActivityLabelRefSchema, taskActivityTaskRefSchema } from './task-comments.js';
export type { TaskTimelineQueryInput, TaskTimelineItemDto, TaskTimelineResponse, TaskActivityChangeDto, TaskActivityLabelRef, TaskActivityTaskRef } from './task-comments.js';

export * from './task-project-placements.js';

export * from './team.js';

export * from './field-policies.js';

export * from './generic-reports.js';

export * from './leave.js';
export * from './leave-api.js';

export * from './workspace-reports.js';

export * from "./planning-checks.js";

export * from './duplication.js';

export * from './summary-templates.js';

export * from './shared-activities.js';
export * from './leave-warnings.js';
