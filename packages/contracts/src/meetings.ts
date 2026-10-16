import {z} from 'zod';
import {envelopeSchema} from './common/envelope.js';
import {idSchema} from './common/ids.js';
import {meetingSchema,meetingTimezoneSchema,meetingLinkSchema} from './common/meeting.js';
import {attendanceWorkLogSchema,recordedWorkLogSchema} from './common/recorded-work.js';
import {periodCommitmentSchema,planningPageQuerySchema,workLogListQuerySchema} from './planning.js';
import {minutesSchema,revisionSchema,taskSchema,utcTimestampSchema} from './tasks.js';
export {meetingSchema,meetingSnapshotSchema,meetingTimezoneSchema,meetingLinkSchema} from './common/meeting.js';
export type {MeetingDto,MeetingSnapshotDto} from './common/meeting.js';
const reason=z.string().trim().min(1).max(1000);
const ids=z.array(idSchema).min(1).max(100).refine(v=>new Set(v).size===v.length,'Duplicate attendees.');
const duration=z.number().int().min(1).max(1440);
const url=meetingLinkSchema.nullable();
export const meetingListQuerySchema=planningPageQuerySchema.extend({plannedPeriodId:idSchema,state:z.enum(['scheduled','cancelled','all']).default('scheduled')});
export const meetingListItemSchema=z.object({task:taskSchema,meeting:meetingSchema});
export const createMeetingInputSchema=z.strictObject({title:z.string().trim().min(1).max(500),statusId:idSchema,sectionId:idSchema.nullable().optional(),plannedPeriodId:idSchema,plannedStartAt:utcTimestampSchema,timezone:meetingTimezoneSchema,plannedDurationMinutes:duration,organizerMembershipId:idSchema,attendeeMembershipIds:ids,joinUrl:url.optional()});
export const updateMeetingInputSchema=z.strictObject({expectedMeetingRevision:revisionSchema,expectedParticipantsRevision:revisionSchema.optional(),expectedWorkPackageRevision:revisionSchema.optional(),plannedStartAt:utcTimestampSchema.optional(),timezone:meetingTimezoneSchema.optional(),plannedDurationMinutes:duration.optional(),organizerMembershipId:idSchema.optional(),attendeeMembershipIds:ids.optional(),actualStartAt:utcTimestampSchema.nullable().optional(),actualDurationMinutes:duration.nullable().optional(),state:z.enum(['scheduled','cancelled']).optional(),joinUrl:url.optional(),recordingUrl:url.optional(),summaryUrl:url.optional(),summaryText:z.string().max(20000).nullable().optional()}).superRefine((v,ctx)=>{
 if(!Object.keys(v).some(k=>!k.startsWith('expected')))ctx.addIssue({code:'custom',message:'Provide a change.'});
 if(v.attendeeMembershipIds!==undefined&&(v.expectedParticipantsRevision===undefined||v.expectedWorkPackageRevision===undefined))ctx.addIssue({code:'custom',message:'Roster changes need participant and package revisions.'});
 if(v.plannedDurationMinutes!==undefined&&v.expectedWorkPackageRevision===undefined)ctx.addIssue({code:'custom',message:'Duration changes need package revision.'});
});
export const meetingAttendanceSchema=z.object({id:idSchema,workspaceId:idSchema,meetingId:idSchema,taskId:idSchema,membershipId:idSchema,revision:revisionSchema,rosterActive:z.boolean(),status:z.enum(['unknown','present','partial','absent']),postingState:z.enum(['unconfirmed','active','void']),minutes:minutesSchema.nullable(),confirmedMeetingRevision:revisionSchema.nullable(),workLog:attendanceWorkLogSchema.nullable()});
const postingBase={attendanceId:idSchema,expectedAttendanceRevision:revisionSchema,expectedWorkLogRevision:revisionSchema.nullable()};
export const attendancePostingInputSchema=z.union([
 z.strictObject({...postingBase,kind:z.literal('confirm'),status:z.literal('present'),attributionBasis:z.literal('actual_meeting'),minutes:duration.optional(),reason:reason.nullable().optional()}),
 z.strictObject({...postingBase,kind:z.literal('confirm'),status:z.literal('partial'),attributionBasis:z.literal('actual_meeting'),minutes:duration,reason:reason.nullable().optional()}),
 z.strictObject({...postingBase,kind:z.literal('confirm'),status:z.literal('absent'),attributionBasis:z.enum(['actual_meeting','planned_absence']),minutes:z.literal(0).optional(),reason:reason.nullable().optional()}),
 z.strictObject({...postingBase,kind:z.literal('void'),reason}),
]);
export const confirmAttendanceInputSchema=z.strictObject({expectedMeetingRevision:revisionSchema,periodId:idSchema,rows:z.array(attendancePostingInputSchema).min(1).max(100).refine(rows=>new Set(rows.map(r=>r.attendanceId)).size===rows.length,'Duplicate attendance rows.')});
export const attendancePostingSchema=z.object({meeting:meetingSchema,attendances:z.array(meetingAttendanceSchema)});
export const attendanceHistorySchema=z.object({id:idSchema,attendanceId:idSchema,revision:revisionSchema,rosterActive:z.boolean(),status:z.enum(['unknown','present','partial','absent']),postingState:z.enum(['unconfirmed','active','void']),minutes:minutesSchema.nullable(),confirmedMeetingRevision:revisionSchema.nullable(),actorUserId:idSchema,reason:reason.nullable(),recordedAt:utcTimestampSchema,changeSeq:z.string().regex(/^[1-9][0-9]*$/),workLog:attendanceWorkLogSchema.nullable()});
export const meetingPlanProposalSchema=z.object({membershipId:idSchema,proposedMinutes:minutesSchema,workPackageId:idSchema,plannedPeriodId:idSchema});
export const meetingCreationSchema=z.object({task:taskSchema,meeting:meetingSchema,attendances:z.array(meetingAttendanceSchema),planProposals:z.array(meetingPlanProposalSchema)});
const planRows=z.array(z.strictObject({membershipId:idSchema,plannedMinutes:minutesSchema.nullable()})).min(1).max(100).refine(v=>new Set(v.map(r=>r.membershipId)).size===v.length,'Duplicate workers.');
export const meetingPlanPreviewInputSchema=z.strictObject({expectedMeetingRevision:revisionSchema,rows:planRows});
export const meetingPlanPreviewRowSchema=z.object({membershipId:idSchema,plannedMinutes:minutesSchema.nullable(),commitment:periodCommitmentSchema.nullable(),expectedCommitmentRevision:revisionSchema.nullable(),allocations:z.array(z.object({taskId:idSchema,minutes:minutesSchema})),unallocatedMinutes:minutesSchema.nullable()});
export const meetingPlanPreviewSchema=z.object({meetingId:idSchema,periodId:idSchema,meetingRevision:revisionSchema,participantsRevision:revisionSchema,workPackageRevision:revisionSchema,periodRevision:revisionSchema,previewHash:z.string().regex(/^[0-9a-f]{64}$/),rows:z.array(meetingPlanPreviewRowSchema)});
export const applyMeetingPlanInputSchema=z.strictObject({expectedMeetingRevision:revisionSchema,previewHash:z.string().regex(/^[0-9a-f]{64}$/),rows:z.array(z.strictObject({membershipId:idSchema,plannedMinutes:minutesSchema.nullable(),expectedCommitmentRevision:revisionSchema.nullable()})).min(1).max(100).refine(v=>new Set(v.map(r=>r.membershipId)).size===v.length,'Duplicate workers.')});
export const meetingPlanResultSchema=z.object({meetingId:idSchema,periodId:idSchema,commitments:z.array(periodCommitmentSchema)});
export const recordedWorkListQuerySchema=workLogListQuerySchema;
export const meetingResponseSchema=envelopeSchema(meetingSchema);
export const meetingListResponseSchema=envelopeSchema(z.array(meetingListItemSchema));
export const meetingCreationResponseSchema=envelopeSchema(meetingCreationSchema);
export const meetingAttendanceListResponseSchema=envelopeSchema(z.array(meetingAttendanceSchema));
export const attendancePostingResponseSchema=envelopeSchema(attendancePostingSchema);
export const attendanceHistoryListResponseSchema=envelopeSchema(z.array(attendanceHistorySchema));
export const meetingPlanPreviewResponseSchema=envelopeSchema(meetingPlanPreviewSchema);
export const meetingPlanResultResponseSchema=envelopeSchema(meetingPlanResultSchema);
export const recordedWorkListResponseSchema=envelopeSchema(z.array(recordedWorkLogSchema));
export type MeetingListQuery=z.infer<typeof meetingListQuerySchema>;
export type MeetingListItemDto=z.infer<typeof meetingListItemSchema>;
export type CreateMeetingInput=z.infer<typeof createMeetingInputSchema>;
export type UpdateMeetingInput=z.infer<typeof updateMeetingInputSchema>;
export type AttendanceDto=z.infer<typeof meetingAttendanceSchema>;
export type AttendancePostingInput=z.infer<typeof attendancePostingInputSchema>;
export type ConfirmAttendanceInput=z.infer<typeof confirmAttendanceInputSchema>;
export type AttendancePostingDto=z.infer<typeof attendancePostingSchema>;
export type AttendanceHistoryDto=z.infer<typeof attendanceHistorySchema>;
export type MeetingPlanProposalDto=z.infer<typeof meetingPlanProposalSchema>;
export type MeetingCreationDto=z.infer<typeof meetingCreationSchema>;
export type MeetingPlanPreviewInput=z.infer<typeof meetingPlanPreviewInputSchema>;
export type MeetingPlanPreviewRowDto=z.infer<typeof meetingPlanPreviewRowSchema>;
export type MeetingPlanPreviewDto=z.infer<typeof meetingPlanPreviewSchema>;
export type ApplyMeetingPlanInput=z.infer<typeof applyMeetingPlanInputSchema>;
export type MeetingPlanResultDto=z.infer<typeof meetingPlanResultSchema>;
export type RecordedWorkListQuery=z.infer<typeof recordedWorkListQuerySchema>;
