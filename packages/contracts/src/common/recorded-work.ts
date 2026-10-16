import {z} from 'zod';
import {idSchema} from './ids.js';
import {workCategorySnapshotSchema} from './work-category.js';
import {minutesSchema,revisionSchema,utcTimestampSchema} from '../tasks.js';
const reasonSchema=z.string().trim().min(1).max(1000);
export const manualPeriodWorkLogSchema = z.object({
  id: idSchema, workspaceId: idSchema, projectId: idSchema,
  taskId: idSchema, workPackageId: idSchema, membershipId: idSchema, periodId: idSchema,
  sourceKind: z.literal('manual_period'), sourceKey: z.string(),
  precision: z.literal('period'), revision: revisionSchema, revisionId: idSchema,
  minutes: minutesSchema, state: z.enum(['active', 'void']), reason: reasonSchema.nullable(),
  actorUserId: idSchema, recordedAt: utcTimestampSchema,
  changeSeq: z.string().regex(/^[1-9][0-9]*$/),
  /** Optional without a default: historical stored responses must replay unchanged. */
  category: workCategorySnapshotSchema.optional(),
});
export const attendanceAttributionSchema=z.discriminatedUnion('basis',[
 z.object({basis:z.literal('actual_meeting'),plannedStartAt:utcTimestampSchema,actualStartAt:utcTimestampSchema}),
 z.object({basis:z.literal('planned_absence'),plannedStartAt:utcTimestampSchema,actualStartAt:z.null()}),
]);
export const attendanceWorkLogSchema=manualPeriodWorkLogSchema.omit({sourceKind:true,precision:true}).extend({
 sourceKind:z.literal('meeting_attendance'),precision:z.literal('occurrence'),meetingId:idSchema,attendanceId:idSchema,
 confirmedMeetingRevision:revisionSchema,attribution:attendanceAttributionSchema,
});
export const recordedWorkLogSchema=z.discriminatedUnion('sourceKind',[manualPeriodWorkLogSchema,attendanceWorkLogSchema]);
export type AttendanceAttribution=z.infer<typeof attendanceAttributionSchema>;
export type AttendanceWorkLogDto=z.infer<typeof attendanceWorkLogSchema>;
export type RecordedWorkLogDto=z.infer<typeof recordedWorkLogSchema>;
