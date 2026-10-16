import {z} from 'zod';
import {idSchema} from './ids.js';
import {revisionSchema,utcTimestampSchema} from '../tasks.js';
export const meetingTimezoneSchema=z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value}).format();return !/^[+-]/.test(value);}catch{return false;}},'Expected an IANA time zone.');
export const meetingLinkSchema=z.url().max(2048).refine(value=>/^https?:\/\//i.test(value),'Expected an HTTP(S) link.');
export const meetingSchema=z.object({
 id:idSchema,workspaceId:idSchema,projectId:idSchema,taskId:idSchema,workPackageId:idSchema,revision:revisionSchema,participantsRevision:revisionSchema,
 plannedPeriodId:idSchema,plannedStartAt:utcTimestampSchema,timezone:meetingTimezoneSchema,plannedDurationMinutes:z.number().int().min(1).max(1440),
 organizerMembershipId:idSchema,state:z.enum(['scheduled','cancelled']),actualStartAt:utcTimestampSchema.nullable(),actualDurationMinutes:z.number().int().min(1).max(1440).nullable(),
 joinUrl:meetingLinkSchema.nullable(),recordingUrl:meetingLinkSchema.nullable(),summaryUrl:meetingLinkSchema.nullable(),summaryText:z.string().max(20000).nullable(),
 scheduleFrozen:z.boolean(),hasPostedAttendance:z.boolean(),createdAt:utcTimestampSchema,updatedAt:utcTimestampSchema,
});
export const meetingSnapshotSchema=z.object({meeting:meetingSchema,attendees:z.array(z.object({id:idSchema,membershipId:idSchema,revision:revisionSchema,rosterActive:z.boolean()})),commitmentIds:z.array(idSchema)});
export type MeetingDto=z.infer<typeof meetingSchema>;
export type MeetingSnapshotDto=z.infer<typeof meetingSnapshotSchema>;
