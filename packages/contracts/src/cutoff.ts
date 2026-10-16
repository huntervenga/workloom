import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { recurrenceBlockedCodeSchema, recurrenceHashSchema } from './common/recurrence.js';
import { revisionSchema, utcTimestampSchema } from './tasks.js';

/** Independent projection/commands: legacy period DTOs, mutation hashes and snapshots stay unchanged. */
export const CUTOFF_REQUESTED_EVENT = 'planning.cutoff_requested' as const;
export const CUTOFF_SCHEMA_VERSION = 1 as const;
export const CUTOFF_LIMITS = { maxCreates: 100, maxReadinessBlockers: 100, discoveryBatch: 50, maxDiscoveryBatch: 100 } as const;
const count = z.number().int().nonnegative();
const expectedGrantRevision = z.number().int().min(0).max(2_147_483_646);

export const cutoffBlockedCodeSchema = z.union([
  z.enum(['automation_not_configured', 'cutoff_grant_revoked', 'cutoff_grant_stale', 'cutoff_authorizer_inactive', 'cutoff_authorizer_capability_revoked']),
  recurrenceBlockedCodeSchema,
]);
export const cutoffGrantSchema = z.object({
  id: idSchema, workspaceId: idSchema, projectId: idSchema, periodId: idSchema,
  revision: revisionSchema, scope: z.literal('project_cutoff'), state: z.enum(['active', 'revoked']),
  authorizerUserId: idSchema, authorizerMembershipId: idSchema,
  activatedAt: utcTimestampSchema.nullable(), recordedAt: utcTimestampSchema,
}).refine(value => value.state !== 'active' || value.activatedAt !== null, 'An active grant needs its activation time.');

export const configureCutoffInputSchema = z.strictObject({
  expectedPeriodRevision: revisionSchema, expectedGrantRevision, enabled: z.boolean(),
});
export const retryCutoffInputSchema = z.strictObject({
  expectedPeriodRevision: revisionSchema, expectedGrantRevision: revisionSchema,
});
export const cutoffCommandResultSchema = z.object({ periodId: idSchema, grant: cutoffGrantSchema, requestId: idSchema.nullable() });

export const cutoffWorkerStatusSchema = z.enum(['frozen', 'already_frozen', 'pending', 'not_due', 'stale', 'blocked']);
export const cutoffWorkerOutcomeSchema = z.strictObject({
  schemaVersion: z.literal(CUTOFF_SCHEMA_VERSION), requestId: idSchema, periodId: idSchema,
  status: cutoffWorkerStatusSchema, processedAt: utcTimestampSchema,
  createdCount: count.max(CUTOFF_LIMITS.maxCreates), remainingCount: count,
  baselineId: idSchema.nullable(), frozenAt: utcTimestampSchema.nullable(), nextRequestId: idSchema.nullable(),
  blockedCode: cutoffBlockedCodeSchema.nullable(),
});

/** The job carries stored target/source identities only. It never carries an actor or caller clock. */
export const cutoffJobSchema = z.strictObject({
  schemaVersion: z.literal(CUTOFF_SCHEMA_VERSION), requestId: idSchema,
  workspaceId: idSchema, projectId: idSchema, periodId: idSchema,
  grantId: idSchema, grantRevision: revisionSchema, periodRevision: revisionSchema,
  cutoffAt: utcTimestampSchema, sourceManifestHash: recurrenceHashSchema,
});
export const cutoffRequestedPayloadSchema = cutoffJobSchema.omit({ workspaceId: true, schemaVersion: true });
export const cutoffRequestedEventSchema = z.strictObject({
  eventId: idSchema, workspaceId: idSchema, type: z.literal(CUTOFF_REQUESTED_EVENT), schemaVersion: z.literal(CUTOFF_SCHEMA_VERSION),
  payload: cutoffRequestedPayloadSchema, occurredAt: utcTimestampSchema,
});
export const cutoffRequestInfoSchema = z.object({
  id: idSchema, state: z.enum(['scheduled', 'pending', 'completed', 'superseded']),
  createdAt: utcTimestampSchema, notBefore: utcTimestampSchema, processedAt: utcTimestampSchema.nullable(),
});
export const cutoffReadinessSchema = z.object({
  periodId: idSchema, periodRevision: revisionSchema, persistedState: z.enum(['planning', 'frozen']),
  serverNow: utcTimestampSchema, cutoffAt: utcTimestampSchema,
  baseline: z.object({ id: idSchema, frozenAt: utcTimestampSchema, requestedCutoffAt: utcTimestampSchema }).nullable(),
  automation: z.object({ state: z.enum(['not_configured', 'enabled', 'revoked']), grant: cutoffGrantSchema.nullable() }),
  readiness: z.enum(['planning', 'overdue_waiting', 'preparing_calendar', 'blocked', 'frozen']),
  missingCount: count, blockedCount: count,
  blockers: z.array(z.object({ kind: z.enum(['cutoff', 'recurrence']), code: cutoffBlockedCodeSchema, seriesId: idSchema.nullable(), bindingId: idSchema.nullable() })).max(CUTOFF_LIMITS.maxReadinessBlockers),
  truncated: z.boolean(), latestRequest: cutoffRequestInfoSchema.nullable(), latestOutcome: cutoffWorkerOutcomeSchema.nullable(),
  actions: z.object({ canConfigure: z.boolean(), canRetry: z.boolean(), canFreezeProject: z.boolean() }),
}).refine(value => (value.persistedState === 'frozen') === (value.baseline !== null) && (value.readiness === 'frozen') === (value.persistedState === 'frozen'), 'Frozen readiness requires a persisted baseline.');
export const cutoffReadinessResponseSchema = envelopeSchema(cutoffReadinessSchema);
export const cutoffCommandResponseSchema = envelopeSchema(cutoffCommandResultSchema);
export type CutoffBlockedCode = z.infer<typeof cutoffBlockedCodeSchema>;
export type CutoffGrantDto = z.infer<typeof cutoffGrantSchema>;
export type ConfigureCutoffInput = z.infer<typeof configureCutoffInputSchema>;
export type RetryCutoffInput = z.infer<typeof retryCutoffInputSchema>;
export type CutoffCommandResultDto = z.infer<typeof cutoffCommandResultSchema>;
export type CutoffWorkerStatus = z.infer<typeof cutoffWorkerStatusSchema>;
export type CutoffWorkerOutcome = z.infer<typeof cutoffWorkerOutcomeSchema>;
export type CutoffJob = z.infer<typeof cutoffJobSchema>;
export type CutoffRequestedEvent = z.infer<typeof cutoffRequestedEventSchema>;
export type CutoffReadinessDto = z.infer<typeof cutoffReadinessSchema>;
