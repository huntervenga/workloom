import {z} from 'zod';
import {idSchema} from './ids.js';

/** Standalone P3b shapes: only zod/ids imports, never planning/meetings, so no runtime cycle.
 * See docs/16-p3b-contract.md. Optional additions to older stored DTOs never carry defaults.
 */
const revision=z.number().int().min(1);
const instant=z.iso.datetime();
const hex64=z.string().regex(/^[0-9a-f]{64}$/);

export const RECURRENCE_LIMITS={
 maxNominalCandidatesPerSeries:366,maxRealCreatesPerChunk:100,maxTargetPeriods:52,
 maxOnDateSpanDays:366,maxAfterCountScanDays:3660,maxAfterCount:366,maxDurationMinutes:1440,
 maxAttendees:100,maxReadinessBindings:100,workerConcurrencyPerProcess:2,
} as const;
export const RECURRENCE_RESOLUTION_POLICY='first_valid_gap_earlier_overlap_v1' as const;
export const recurrenceResolutionPolicySchema=z.literal(RECURRENCE_RESOLUTION_POLICY);
export const recurrenceHashSchema=hex64;
export const recurrenceTimezoneSchema=z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value}).format();return !/^[+-]/.test(value);}catch{return false;}},'Expected an IANA time zone.');
export const recurrenceLocalTimeSchema=z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/,'Expected HH:mm.');
export const recurrenceOffsetSchema=z.string().regex(/^[+-]([01][0-9]|2[0-3]):[0-5][0-9]$/,'Expected ±HH:mm.');
export const isoWeekdaySchema=z.number().int().min(1).max(7);
export const recurrenceLinkSchema=z.url().max(2048).refine(value=>/^https?:\/\//i.test(value),'Expected an HTTP(S) link.');
/** Exact proleptic-Gregorian UTC day number of a YYYY-MM-DD date (years 0000–9999), or null when invalid.
 * Date.parse of the ISO date-time form never remaps two-digit years (unlike Date.UTC); the round-trip
 * rejects rolled-over days such as 2026-02-30.
 */
function isoDayNumber(date:string):number|null{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;
 const ms=Date.parse(`${date}T00:00:00.000Z`);
 if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==date)return null;
 return ms/86400000;
}
/** Inclusive nominal-calendar days between two YYYY-MM-DD dates (same date → 1). Throws RangeError on invalid dates. */
export function recurrenceCalendarSpanDays(startDate:string,endDate:string):number{
 const start=isoDayNumber(startDate),end=isoDayNumber(endDate);
 if(start===null||end===null)throw new RangeError('Expected valid YYYY-MM-DD dates.');
 return end-start+1;
}
export const RECURRENCE_MIN_DATE='2000-01-01' as const;
export const RECURRENCE_MAX_DATE='2100-12-31' as const;
/** Recurrence schedule/occurrence/effective/exception dates: valid ISO date within 2000-01-01..2100-12-31. */
export const recurrenceCalendarDateSchema=z.string().superRefine((value,ctx)=>{
 if(isoDayNumber(value)===null)ctx.addIssue({code:'custom',message:'Expected a valid YYYY-MM-DD date.'});
 else if(value<RECURRENCE_MIN_DATE||value>RECURRENCE_MAX_DATE)ctx.addIssue({code:'custom',message:`Recurrence dates must be between ${RECURRENCE_MIN_DATE} and ${RECURRENCE_MAX_DATE}.`});
});
const calendarDate=recurrenceCalendarDateSchema;

export const recurrenceEndSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('on_date'),endDate:calendarDate}),
 /** Full nominal budget fixed at creation; skips consume positions and are never appended. */
 z.strictObject({kind:z.literal('after_count'),count:z.number().int().min(1).max(RECURRENCE_LIMITS.maxAfterCount)}),
]);
export const recurrenceFrequencySchema=z.enum(['daily','weekly']);
export const recurrenceScheduleInputSchema=z.strictObject({
 startDate:calendarDate,localTime:recurrenceLocalTimeSchema,timezone:recurrenceTimezoneSchema,frequency:recurrenceFrequencySchema,
 weekdays:z.array(isoWeekdaySchema).min(1).max(7).optional(),
 plannedDurationMinutes:z.number().int().min(1).max(RECURRENCE_LIMITS.maxDurationMinutes),end:recurrenceEndSchema,
}).superRefine((v,ctx)=>{
 if(v.frequency==='daily'&&v.weekdays!==undefined)ctx.addIssue({code:'custom',path:['weekdays'],message:'Daily series take no weekdays.'});
 if(v.frequency==='weekly'&&v.weekdays===undefined)ctx.addIssue({code:'custom',path:['weekdays'],message:'Weekly series need weekdays.'});
 if(v.weekdays!==undefined&&new Set(v.weekdays).size!==v.weekdays.length)ctx.addIssue({code:'custom',path:['weekdays'],message:'Duplicate weekdays.'});
 if(v.end.kind==='on_date'&&isoDayNumber(v.startDate)!==null&&isoDayNumber(v.end.endDate)!==null){const span=recurrenceCalendarSpanDays(v.startDate,v.end.endDate);if(span<1||span>RECURRENCE_LIMITS.maxOnDateSpanDays)ctx.addIssue({code:'custom',path:['end','endDate'],message:'End date must be within 366 calendar days from the start date.'});}
});
export const recurrenceTemplateInputSchema=z.strictObject({
 title:z.string().trim().min(1).max(500),statusId:idSchema,sectionId:idSchema.nullable().optional(),organizerMembershipId:idSchema,
 attendeeMembershipIds:z.array(idSchema).min(1).max(RECURRENCE_LIMITS.maxAttendees).refine(v=>new Set(v).size===v.length,'Duplicate attendees.'),
 joinUrl:recurrenceLinkSchema.nullable().optional(),
});

/** Planned-only context reviewed when reset/restore inherits the effective series version. */
export const recurrencePlannedCalendarSchema=z.object({
 timezone:recurrenceTimezoneSchema,
 plannedDurationMinutes:z.number().int().min(1).max(RECURRENCE_LIMITS.maxDurationMinutes),
 organizerMembershipId:idSchema,
 attendeeMembershipIds:z.array(idSchema).min(1).max(RECURRENCE_LIMITS.maxAttendees).refine(v=>new Set(v).size===v.length,'Duplicate attendees.'),
});

/** Runtime tz/ICU/implementation provenance; a later tzdata upgrade never rewrites stored resolutions. */
export const recurrenceTimezoneProvenanceSchema=z.object({
 timezone:recurrenceTimezoneSchema,implementation:z.string().min(1).max(100),
 tzdataVersion:z.string().min(1).max(40).nullable(),icuVersion:z.string().min(1).max(40).nullable(),
});
export const recurrenceResolutionWarningSchema=z.enum(['ambiguous_earlier','gap_first_valid','skipped_local_date']);
/** Intended nominal wall time and the resolved instant are separate; end = start + elapsed minutes.
 * resolvedOffset stays ±HH:mm: the resolver rejects (422) non-minute offsets or second-level wall transitions
 * instead of rounding, and candidates whose resolved local date leaves the supported range.
 */
export const recurrenceResolutionSchema=z.object({
 policyVersion:recurrenceResolutionPolicySchema,intendedLocalDate:calendarDate,intendedLocalTime:recurrenceLocalTimeSchema,
 resolvedStartAt:instant,resolvedEndAt:instant,resolvedLocalDate:calendarDate,resolvedLocalTime:recurrenceLocalTimeSchema,
 resolvedOffset:recurrenceOffsetSchema,plannedDurationMinutes:z.number().int().min(1).max(RECURRENCE_LIMITS.maxDurationMinutes),
 warning:recurrenceResolutionWarningSchema.nullable(),provenance:recurrenceTimezoneProvenanceSchema,
});

/** Root-approved policy vectors (docs16 §6; Node 24.19.0 / tz2026b / ICU 78.3). Fixture data, not a resolver. */
export const RECURRENCE_DST_REFERENCE_VECTORS:readonly {readonly timezone:string;readonly intendedLocalDate:string;readonly intendedLocalTime:string;readonly resolvedLocalDate:string;readonly resolvedLocalTime:string;readonly resolvedOffset:string;readonly warning:z.infer<typeof recurrenceResolutionWarningSchema>|null}[]=[
 {timezone:'Asia/Nicosia',intendedLocalDate:'2026-03-29',intendedLocalTime:'03:30',resolvedLocalDate:'2026-03-29',resolvedLocalTime:'04:00',resolvedOffset:'+03:00',warning:'gap_first_valid'},
 {timezone:'Asia/Nicosia',intendedLocalDate:'2026-10-25',intendedLocalTime:'03:30',resolvedLocalDate:'2026-10-25',resolvedLocalTime:'03:30',resolvedOffset:'+03:00',warning:'ambiguous_earlier'},
 {timezone:'America/New_York',intendedLocalDate:'2026-03-08',intendedLocalTime:'02:30',resolvedLocalDate:'2026-03-08',resolvedLocalTime:'03:00',resolvedOffset:'-04:00',warning:'gap_first_valid'},
 {timezone:'America/New_York',intendedLocalDate:'2026-11-01',intendedLocalTime:'01:30',resolvedLocalDate:'2026-11-01',resolvedLocalTime:'01:30',resolvedOffset:'-04:00',warning:'ambiguous_earlier'},
 {timezone:'Australia/Lord_Howe',intendedLocalDate:'2026-10-04',intendedLocalTime:'02:15',resolvedLocalDate:'2026-10-04',resolvedLocalTime:'02:30',resolvedOffset:'+11:00',warning:'gap_first_valid'},
 {timezone:'Australia/Lord_Howe',intendedLocalDate:'2026-04-05',intendedLocalTime:'01:45',resolvedLocalDate:'2026-04-05',resolvedLocalTime:'01:45',resolvedOffset:'+11:00',warning:'ambiguous_earlier'},
 {timezone:'Pacific/Apia',intendedLocalDate:'2011-12-30',intendedLocalTime:'09:00',resolvedLocalDate:'2011-12-31',resolvedLocalTime:'00:00',resolvedOffset:'+14:00',warning:'skipped_local_date'},
 {timezone:'UTC',intendedLocalDate:'2026-03-29',intendedLocalTime:'03:30',resolvedLocalDate:'2026-03-29',resolvedLocalTime:'03:30',resolvedOffset:'+00:00',warning:null},
];

/** Bounded, payload-free generation block reasons shared by readiness, worker outcomes and health. */
export const recurrenceBlockedCodeSchema=z.enum([
 'authorization_missing','authorizer_inactive','authorizer_capability_revoked','authorization_revision_stale',
 'cross_period_conflict','candidate_limit_exceeded','source_unavailable','unsupported_event_version',
]);
export const recurrenceCalendarStateSchema=z.enum(['scheduled','cancelled']);
export const recurrenceExceptionKindSchema=z.enum(['skip','move','restore','reset']);

/** Real meeting/task/package locators are all present or all null (reserved header). */
export function recurrenceLocatorsAllOrNone(v:{readonly meetingId:string|null;readonly taskId:string|null;readonly workPackageId:string|null}):boolean{
 const present=[v.meetingId,v.taskId,v.workPackageId].filter(id=>id!==null).length;
 return present===0||present===3;
}
const locatorMessage='Meeting, task and package locators are all-or-none.';
export const recurrenceEntityLocatorShape={meetingId:idSchema.nullable(),taskId:idSchema.nullable(),workPackageId:idSchema.nullable()};

/** Optional additive locator on fresh Meeting reads; stable reserved header identity and original nominal key. */
export const recurrenceOccurrenceRefSchema=z.object({
 seriesId:idSchema,instanceId:idSchema,occurrenceKey:calendarDate,nominalSequence:z.number().int().min(1).max(RECURRENCE_LIMITS.maxAfterCount).nullable(),
});

/** One calendar-census row of a frozen period: active and paused series, cancelled header-only rows included. */
export const recurrenceCensusEntrySchema=z.object({
 instanceId:idSchema,seriesId:idSchema,bindingId:idSchema,occurrenceKey:calendarDate,
 nominalSequence:z.number().int().min(1).max(RECURRENCE_LIMITS.maxAfterCount).nullable(),
 sourceVersionId:idSchema,exceptionVersionId:idSchema.nullable(),calendarState:recurrenceCalendarStateSchema,
 resolution:recurrenceResolutionSchema,...recurrenceEntityLocatorShape,
 meetingRevision:revision.nullable(),participantsRevision:revision.nullable(),
}).refine(recurrenceLocatorsAllOrNone,locatorMessage);
/** Optional, no-default planning snapshot section: calendar-only, no personal plan/minute cohort/package baseline. */
export const recurrenceSnapshotSectionSchema=z.object({
 schemaVersion:z.literal(1),policyVersion:recurrenceResolutionPolicySchema,
 bindings:z.array(z.object({bindingId:idSchema,seriesId:idSchema,bindingRevision:revision,seriesState:z.enum(['active','paused']),seriesVersionIds:z.array(idSchema).min(1),sourceManifestHash:hex64})),
 census:z.array(recurrenceCensusEntrySchema),
});

export type RecurrenceScheduleInput=z.infer<typeof recurrenceScheduleInputSchema>;
export type RecurrenceEnd=z.infer<typeof recurrenceEndSchema>;
export type RecurrenceTemplateInput=z.infer<typeof recurrenceTemplateInputSchema>;
export type RecurrenceTimezoneProvenance=z.infer<typeof recurrenceTimezoneProvenanceSchema>;
export type RecurrenceResolutionWarning=z.infer<typeof recurrenceResolutionWarningSchema>;
export type RecurrenceResolutionDto=z.infer<typeof recurrenceResolutionSchema>;
export type RecurrenceBlockedCode=z.infer<typeof recurrenceBlockedCodeSchema>;
export type RecurrenceCalendarState=z.infer<typeof recurrenceCalendarStateSchema>;
export type RecurrenceExceptionKind=z.infer<typeof recurrenceExceptionKindSchema>;
export type RecurrenceOccurrenceRef=z.infer<typeof recurrenceOccurrenceRefSchema>;
export type RecurrenceCensusEntryDto=z.infer<typeof recurrenceCensusEntrySchema>;
export type RecurrenceSnapshotSectionDto=z.infer<typeof recurrenceSnapshotSectionSchema>;

export type RecurrencePlannedCalendarDto=z.infer<typeof recurrencePlannedCalendarSchema>;
