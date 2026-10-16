import {z} from 'zod';
import {envelopeSchema} from './common/envelope.js';
import {idSchema} from './common/ids.js';
import {
 RECURRENCE_LIMITS,recurrenceBlockedCodeSchema,recurrenceCalendarDateSchema,recurrenceCalendarStateSchema,recurrenceEntityLocatorShape,recurrenceExceptionKindSchema,
 recurrenceHashSchema,recurrenceLocalTimeSchema,recurrencePlannedCalendarSchema,recurrenceLocatorsAllOrNone,recurrenceResolutionPolicySchema,recurrenceResolutionSchema,
 recurrenceScheduleInputSchema,recurrenceTemplateInputSchema,recurrenceTimezoneProvenanceSchema,recurrenceResolutionWarningSchema,
} from './common/recurrence.js';
import {planningPageQuerySchema} from './planning.js';
import {revisionSchema,utcTimestampSchema} from './tasks.js';
export * from './common/recurrence.js';

/** P3b bounded recurrence catalog. See docs/16-p3b-contract.md (implementation underway, not accepted).
 * Every mutation is keyed; previews are keyless consistent reads that never materialize or invent entity IDs.
 * Actor, source, job capability and server time are never accepted by any input.
 */
const reason=z.string().trim().min(1).max(1000);
const periodIds=z.array(idSchema).min(1).max(RECURRENCE_LIMITS.maxTargetPeriods).refine(v=>new Set(v).size===v.length,'Duplicate periods.');
const count=z.number().int().nonnegative();
const queryBoolean=z.union([z.boolean(),z.enum(['true','false']).transform(v=>v==='true')]);

/** Public controlled 409: the target period census is incomplete. Recover via GET recurrence-readiness, not error details. */
export const MATERIALIZATION_REQUIRED='MATERIALIZATION_REQUIRED' as const;
export const RECURRENCE_ERROR_HTTP_STATUS={[MATERIALIZATION_REQUIRED]:409} as const;
/** The only outbox type/version the recurrence relay subscribes to; all other rows stay untouched. */
export const RECURRENCE_MATERIALIZATION_REQUESTED='recurrence.materialization_requested' as const;
export const RECURRENCE_MATERIALIZATION_SCHEMA_VERSION=1 as const;

export const recurrenceSeriesStateSchema=z.enum(['active','paused']);
export const recurrenceSeriesListQuerySchema=planningPageQuerySchema.extend({state:z.enum(['active','paused','all']).default('all')});
export const recurrenceSeriesVersionSchema=z.object({
 id:idSchema,seriesId:idSchema,revision:revisionSchema,effectiveFromNominalDate:recurrenceCalendarDateSchema,
 schedule:recurrenceScheduleInputSchema,template:recurrenceTemplateInputSchema,policyVersion:recurrenceResolutionPolicySchema,
 actorUserId:idSchema,createdAt:utcTimestampSchema,changeSeq:z.string().regex(/^[1-9][0-9]*$/),
});
export const recurrenceGenerationReadinessSchema=z.object({
 authorizationId:idSchema.nullable(),authorizationRevision:revisionSchema.nullable(),authorizerMembershipId:idSchema.nullable(),
 state:z.enum(['ready','blocked']),blockedCode:recurrenceBlockedCodeSchema.nullable(),
});
export const recurrenceSeriesSchema=z.object({
 id:idSchema,workspaceId:idSchema,projectId:idSchema,revision:revisionSchema,state:recurrenceSeriesStateSchema,
 currentVersion:recurrenceSeriesVersionSchema,generation:recurrenceGenerationReadinessSchema,
 /** Explicitly bound periods only (≤52 per series); never a promise of unbounded generation. */
 boundPeriodIds:z.array(idSchema).max(RECURRENCE_LIMITS.maxTargetPeriods).refine(v=>new Set(v).size===v.length,'Duplicate periods.'),
 boundPeriodCount:z.number().int().min(0).max(RECURRENCE_LIMITS.maxTargetPeriods),
 nominalCandidateCount:z.number().int().min(0).max(RECURRENCE_LIMITS.maxNominalCandidatesPerSeries),
 createdAt:utcTimestampSchema,updatedAt:utcTimestampSchema,
}).refine(v=>v.boundPeriodCount===v.boundPeriodIds.length,{path:['boundPeriodCount'],message:'boundPeriodCount must equal boundPeriodIds.length.'});
export const recurrencePeriodBindingSchema=z.object({
 id:idSchema,workspaceId:idSchema,projectId:idSchema,seriesId:idSchema,periodId:idSchema,revision:revisionSchema,
 /** Generation inputs only; stable across successful chunks. */
 sourceManifestHash:recurrenceHashSchema,
 state:z.enum(['complete','pending','blocked']),blockedCode:recurrenceBlockedCodeSchema.nullable(),
 headerCount:count,materializedCount:count,missingCount:count,cancelledHeaderOnlyCount:count,
 createdAt:utcTimestampSchema,
});

/** One nominal candidate; periodId null means no explicitly bound period ("Период не выбран"). */
export const recurrenceCandidateSchema=z.object({
 occurrenceKey:recurrenceCalendarDateSchema,nominalSequence:z.number().int().min(1).max(RECURRENCE_LIMITS.maxAfterCount).nullable(),
 resolution:recurrenceResolutionSchema,periodId:idSchema.nullable(),
 /** Other nominal keys resolving to the same instant; shown, never merged. */
 collidesWithOccurrenceKeys:z.array(recurrenceCalendarDateSchema),
});
export const recurrencePeriodOwnershipSchema=z.object({periodId:idSchema,periodRevision:revisionSchema,candidateCount:count});
export const recurrenceNominalCountsSchema=z.object({nominalCount:count,consumedNominalCount:count,remainingNominalCount:count,skippedCount:count,cancelledCount:count});

export const recurrenceCreatePreviewInputSchema=z.strictObject({schedule:recurrenceScheduleInputSchema,template:recurrenceTemplateInputSchema,targetPeriodIds:periodIds});
export const createRecurrenceSeriesInputSchema=recurrenceCreatePreviewInputSchema.extend({previewHash:recurrenceHashSchema});
export const recurrenceCreatePreviewSchema=z.object({
 projectId:idSchema,previewHash:recurrenceHashSchema,policyVersion:recurrenceResolutionPolicySchema,
 provenance:recurrenceTimezoneProvenanceSchema,counts:recurrenceNominalCountsSchema,
 candidates:z.array(recurrenceCandidateSchema).max(RECURRENCE_LIMITS.maxNominalCandidatesPerSeries),
 periods:z.array(recurrencePeriodOwnershipSchema),unboundCandidateCount:count,
 warnings:z.array(recurrenceResolutionWarningSchema),
});

export const recurrenceEditPreviewInputSchema=z.strictObject({
 expectedRevision:revisionSchema,effectiveFromNominalDate:recurrenceCalendarDateSchema,
 schedule:recurrenceScheduleInputSchema,template:recurrenceTemplateInputSchema,
});
export const editRecurrenceSeriesInputSchema=recurrenceEditPreviewInputSchema.extend({previewHash:recurrenceHashSchema});
export const recurrenceEditImpactSchema=z.object({
 occurrenceKey:recurrenceCalendarDateSchema,instanceId:idSchema.nullable(),periodId:idSchema.nullable(),
 action:z.enum(['update','create','cancel','retain']),before:recurrenceResolutionSchema.nullable(),after:recurrenceResolutionSchema.nullable(),
});
export const recurrenceProtectedReasonSchema=z.enum(['past','done','posted_attendance','schedule_frozen','cross_period']);
export const recurrenceProtectedTargetSchema=z.object({occurrenceKey:recurrenceCalendarDateSchema,instanceId:idSchema,reasons:z.array(recurrenceProtectedReasonSchema).min(1)});
export const recurrenceEditPreviewSchema=z.object({
 seriesId:idSchema,seriesRevision:revisionSchema,effectiveFromNominalDate:recurrenceCalendarDateSchema,previewHash:recurrenceHashSchema,
 counts:recurrenceNominalCountsSchema,impacts:z.array(recurrenceEditImpactSchema).max(RECURRENCE_LIMITS.maxNominalCandidatesPerSeries),
 /** Non-empty means apply rejects the whole edit; only targets visible to the actor are listed. */
 protectedTargets:z.array(recurrenceProtectedTargetSchema).max(RECURRENCE_LIMITS.maxNominalCandidatesPerSeries),
});

export const setRecurrenceSeriesStateInputSchema=z.strictObject({expectedRevision:revisionSchema,state:recurrenceSeriesStateSchema});
export const recurrencePeriodPreviewInputSchema=z.strictObject({expectedRevision:revisionSchema,periodIds});
export const addRecurrencePeriodsInputSchema=recurrencePeriodPreviewInputSchema.extend({previewHash:recurrenceHashSchema});
export const recurrencePeriodPreviewSchema=z.object({
 seriesId:idSchema,seriesRevision:revisionSchema,previewHash:recurrenceHashSchema,
 periods:z.array(recurrencePeriodOwnershipSchema),candidates:z.array(recurrenceCandidateSchema).max(RECURRENCE_LIMITS.maxNominalCandidatesPerSeries),
});
export const recurrencePeriodsResultSchema=z.object({series:recurrenceSeriesSchema,bindings:z.array(recurrencePeriodBindingSchema)});
export const authorizeRecurrenceGenerationInputSchema=z.strictObject({expectedRevision:revisionSchema,expectedAuthorizationRevision:revisionSchema.nullable()});

export const recurrenceInstanceListQuerySchema=planningPageQuerySchema.extend({periodId:idSchema,includeCancelled:queryBoolean.optional()});
export const recurrenceExceptionHeadSchema=z.object({versionId:idSchema,revision:revisionSchema,kind:recurrenceExceptionKindSchema,reason,actorUserId:idSchema,recordedAt:utcTimestampSchema});
/** Stable reserved header: exists before materialization; real locators are all-or-none. */
export const recurrenceInstanceSchema=z.object({
 id:idSchema,workspaceId:idSchema,projectId:idSchema,seriesId:idSchema,bindingId:idSchema,plannedPeriodId:idSchema,
 occurrenceKey:recurrenceCalendarDateSchema,nominalSequence:z.number().int().min(1).max(RECURRENCE_LIMITS.maxAfterCount).nullable(),
 sourceVersionId:idSchema,revision:revisionSchema,calendarState:recurrenceCalendarStateSchema,
 ...recurrenceEntityLocatorShape,meetingRevision:revisionSchema.nullable(),
 resolution:recurrenceResolutionSchema,exception:recurrenceExceptionHeadSchema.nullable(),
 createdAt:utcTimestampSchema,updatedAt:utcTimestampSchema,
}).refine(recurrenceLocatorsAllOrNone,'Meeting, task and package locators are all-or-none.');

const exceptionBase={expectedSeriesRevision:revisionSchema,expectedInstanceRevision:revisionSchema,reason};
const exceptionVariants={
 skip:z.strictObject({...exceptionBase,kind:z.literal('skip')}),
 /** Same key/IDs; must stay inside the originally assigned period and P3a schedule/roster locks. */
 move:z.strictObject({...exceptionBase,kind:z.literal('move'),localDate:recurrenceCalendarDateSchema,localTime:recurrenceLocalTimeSchema}),
 restore:z.strictObject({...exceptionBase,kind:z.literal('restore')}),
 reset:z.strictObject({...exceptionBase,kind:z.literal('reset')}),
};
export const recurrenceExceptionPreviewInputSchema=z.discriminatedUnion('kind',[exceptionVariants.skip,exceptionVariants.move,exceptionVariants.restore,exceptionVariants.reset]);
const withHash={previewHash:recurrenceHashSchema};
export const setRecurrenceExceptionInputSchema=z.discriminatedUnion('kind',[exceptionVariants.skip.extend(withHash),exceptionVariants.move.extend(withHash),exceptionVariants.restore.extend(withHash),exceptionVariants.reset.extend(withHash)]);
export const recurrenceExceptionPreviewSchema=z.object({
 seriesId:idSchema,instanceId:idSchema,occurrenceKey:recurrenceCalendarDateSchema,previewHash:recurrenceHashSchema,kind:recurrenceExceptionKindSchema,
 before:recurrenceResolutionSchema,after:recurrenceResolutionSchema.nullable(),calendarStateAfter:recurrenceCalendarStateSchema,
 beforePlannedCalendar:recurrencePlannedCalendarSchema,afterPlannedCalendar:recurrencePlannedCalendarSchema,
 protectedReasons:z.array(recurrenceProtectedReasonSchema),
});

/** cursor is a signed server token (actor/workspace/period/manifest-bound); never a raw afterKey. */
export const materializePeriodInputSchema=z.strictObject({
 limit:z.number().int().min(1).max(RECURRENCE_LIMITS.maxRealCreatesPerChunk).default(RECURRENCE_LIMITS.maxRealCreatesPerChunk),
 cursor:z.string().min(1).max(4096).optional(),
});
export const recurrenceBindingProgressSchema=z.object({
 bindingId:idSchema,seriesId:idSchema,sourceManifestHash:recurrenceHashSchema,state:z.enum(['complete','pending','blocked']),
 createdCount:count,remainingCount:count,blockedCode:recurrenceBlockedCodeSchema.nullable(),
});
export const recurrenceMaterializationResultSchema=z.object({
 periodId:idSchema,status:z.enum(['complete','pending','blocked']),
 /** Counts REAL meeting/task/package compositions only, never reservation headers. */
 createdCount:z.number().int().min(0).max(RECURRENCE_LIMITS.maxRealCreatesPerChunk),remainingCount:count,
 nextCursor:z.string().min(1).max(4096).nullable(),bindings:z.array(recurrenceBindingProgressSchema).max(RECURRENCE_LIMITS.maxReadinessBindings),
 /** Same as readiness: true iff bindings is a bounded subset; top-level createdCount/remainingCount are always global. */
 truncated:z.boolean(),
 /** Final complete chunk of an overdue period atomically performs only that target-period freeze. */
 frozenBaselineIds:z.array(idSchema),
});
export const recurrenceReadinessSchema=z.object({
 periodId:idSchema,periodRevision:revisionSchema,state:z.enum(['complete','pending','blocked']),
 missingCount:count,blockedCount:count,
 /** truncated is true iff bindings is a bounded subset; missingCount/blockedCount are always global. */
 bindings:z.array(recurrenceBindingProgressSchema).max(RECURRENCE_LIMITS.maxReadinessBindings),truncated:z.boolean(),
});

/** Server-only worker job: no actor; the stored authorizer is revalidated under the workspace barrier. */
export const recurrenceMaterializationJobSchema=z.strictObject({
 workspaceId:idSchema,seriesId:idSchema,bindingId:idSchema,sourceManifestHash:recurrenceHashSchema,
 authorizationRevision:revisionSchema,requestId:z.string().min(1).max(200),
});
export const recurrenceMaterializationRequestedPayloadSchema=z.strictObject({seriesId:idSchema,bindingId:idSchema,sourceManifestHash:recurrenceHashSchema,authorizationRevision:revisionSchema});
export const recurrenceMaterializationRequestedEventSchema=z.strictObject({
 eventId:idSchema,workspaceId:idSchema,type:z.literal(RECURRENCE_MATERIALIZATION_REQUESTED),
 schemaVersion:z.literal(RECURRENCE_MATERIALIZATION_SCHEMA_VERSION),payload:recurrenceMaterializationRequestedPayloadSchema,occurredAt:utcTimestampSchema,
});

export const recurrenceSeriesResponseSchema=envelopeSchema(recurrenceSeriesSchema);
export const recurrenceSeriesListResponseSchema=envelopeSchema(z.array(recurrenceSeriesSchema));
export const recurrenceCreatePreviewResponseSchema=envelopeSchema(recurrenceCreatePreviewSchema);
export const recurrenceEditPreviewResponseSchema=envelopeSchema(recurrenceEditPreviewSchema);
export const recurrencePeriodPreviewResponseSchema=envelopeSchema(recurrencePeriodPreviewSchema);
export const recurrencePeriodsResultResponseSchema=envelopeSchema(recurrencePeriodsResultSchema);
export const recurrenceInstanceResponseSchema=envelopeSchema(recurrenceInstanceSchema);
export const recurrenceInstanceListResponseSchema=envelopeSchema(z.array(recurrenceInstanceSchema));
export const recurrenceExceptionPreviewResponseSchema=envelopeSchema(recurrenceExceptionPreviewSchema);
export const recurrenceMaterializationResultResponseSchema=envelopeSchema(recurrenceMaterializationResultSchema);
export const recurrenceReadinessResponseSchema=envelopeSchema(recurrenceReadinessSchema);

export type RecurrenceSeriesState=z.infer<typeof recurrenceSeriesStateSchema>;
export type RecurrenceSeriesListQuery=z.infer<typeof recurrenceSeriesListQuerySchema>;
export type RecurrenceSeriesVersionDto=z.infer<typeof recurrenceSeriesVersionSchema>;
export type RecurrenceGenerationReadinessDto=z.infer<typeof recurrenceGenerationReadinessSchema>;
export type RecurrenceSeriesDto=z.infer<typeof recurrenceSeriesSchema>;
export type RecurrencePeriodBindingDto=z.infer<typeof recurrencePeriodBindingSchema>;
export type RecurrenceCandidateDto=z.infer<typeof recurrenceCandidateSchema>;
export type RecurrencePeriodOwnershipDto=z.infer<typeof recurrencePeriodOwnershipSchema>;
export type RecurrenceNominalCountsDto=z.infer<typeof recurrenceNominalCountsSchema>;
export type RecurrenceCreatePreviewInput=z.infer<typeof recurrenceCreatePreviewInputSchema>;
export type CreateRecurrenceSeriesInput=z.infer<typeof createRecurrenceSeriesInputSchema>;
export type RecurrenceCreatePreviewDto=z.infer<typeof recurrenceCreatePreviewSchema>;
export type RecurrenceEditPreviewInput=z.infer<typeof recurrenceEditPreviewInputSchema>;
export type EditRecurrenceSeriesInput=z.infer<typeof editRecurrenceSeriesInputSchema>;
export type RecurrenceEditImpactDto=z.infer<typeof recurrenceEditImpactSchema>;
export type RecurrenceProtectedReason=z.infer<typeof recurrenceProtectedReasonSchema>;
export type RecurrenceProtectedTargetDto=z.infer<typeof recurrenceProtectedTargetSchema>;
export type RecurrenceEditPreviewDto=z.infer<typeof recurrenceEditPreviewSchema>;
export type SetRecurrenceSeriesStateInput=z.infer<typeof setRecurrenceSeriesStateInputSchema>;
export type RecurrencePeriodPreviewInput=z.infer<typeof recurrencePeriodPreviewInputSchema>;
export type AddRecurrencePeriodsInput=z.infer<typeof addRecurrencePeriodsInputSchema>;
export type RecurrencePeriodPreviewDto=z.infer<typeof recurrencePeriodPreviewSchema>;
export type RecurrencePeriodsResultDto=z.infer<typeof recurrencePeriodsResultSchema>;
export type AuthorizeRecurrenceGenerationInput=z.infer<typeof authorizeRecurrenceGenerationInputSchema>;
export type RecurrenceInstanceListQuery=z.infer<typeof recurrenceInstanceListQuerySchema>;
export type RecurrenceExceptionHeadDto=z.infer<typeof recurrenceExceptionHeadSchema>;
export type RecurrenceInstanceDto=z.infer<typeof recurrenceInstanceSchema>;
export type RecurrenceExceptionPreviewInput=z.infer<typeof recurrenceExceptionPreviewInputSchema>;
export type SetRecurrenceExceptionInput=z.infer<typeof setRecurrenceExceptionInputSchema>;
export type RecurrenceExceptionPreviewDto=z.infer<typeof recurrenceExceptionPreviewSchema>;
export type MaterializePeriodInput=z.infer<typeof materializePeriodInputSchema>;
export type RecurrenceBindingProgressDto=z.infer<typeof recurrenceBindingProgressSchema>;
export type RecurrenceMaterializationResultDto=z.infer<typeof recurrenceMaterializationResultSchema>;
export type RecurrenceReadinessDto=z.infer<typeof recurrenceReadinessSchema>;
export type RecurrenceMaterializationJob=z.infer<typeof recurrenceMaterializationJobSchema>;
export type RecurrenceMaterializationRequestedPayload=z.infer<typeof recurrenceMaterializationRequestedPayloadSchema>;
export type RecurrenceMaterializationRequestedEvent=z.infer<typeof recurrenceMaterializationRequestedEventSchema>;
