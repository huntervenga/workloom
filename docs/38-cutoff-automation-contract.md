# Explicit project cutoff automation

Status: source implementation in progress, not accepted or deployed. The compiled local runtime remains at the separately approved checkpoint. Migration0013, queue installation, deployment and worker startup require separate coordinator gates. Automatic reports remain deferred.

This is the exact additive backend contract for [the approved design](22-next-cutoff-worker.md). It does not change stored period DTOs, pinned snapshots, existing public command hashes or manual freeze semantics. The companion interface is documented in [cutoff readiness UI](36-cutoff-readiness-ui.md).

## Public HTTP surface

All routes use the existing authenticated workspace context and JSON envelope. Actor, role, capability, job identity and server time are never public input.

| Method and suffix under `/api/v1/workspaces/:workspaceId/periods/:periodId` | Input | Result |
| --- | --- | --- |
| GET `/cutoff-readiness` | No query/body | `CutoffReadinessDto` |
| PUT `/cutoff-automation` | `{expectedPeriodRevision,expectedGrantRevision,enabled}` | `CutoffCommandResultDto` |
| POST `/cutoff-retry` | `{expectedPeriodRevision,expectedGrantRevision}` | `CutoffCommandResultDto` |

Both writes require the ordinary idempotency header, a current owner/admin and `plan.freeze_project`. Inputs are strict. Configure accepts expected grant revision0 only when no grant exists; retry requires a positive revision. New commands conflict if either expected revision changed. Current access and target scope are checked before exact public receipt replay.

Enabling or renewing always records a new immutable grant revision attributed to the current administrator; it explicitly replaces previous delegated authority. Disabling records a revoked revision and supersedes live requests. A new grant is never inferred from an old period creator/editor. Existing periods are unconfigured. `requestId:null` means the command created no processing request, including a frozen period or revocation.

Exact public replay returns the original command result after current owner/admin authorization, even if another command subsequently replaced/revoked its grant. It never reinstalls that historical grant or creates another request. UI recovery must fetch fresh readiness after any acknowledgment.

## Read projection

`CutoffReadinessDto` contains period ID/revision, persisted state, database `serverNow`, stored UTC `cutoffAt`, and a nullable baseline header `{id,frozenAt,requestedCutoffAt}`. `persistedState:'frozen'`, nonnull baseline and `readiness:'frozen'` must agree; inconsistent stored state is an error, never a fabricated freeze time.

Automation metadata is independent: `{state:'not_configured'|'enabled'|'revoked',grant}`. Grant metadata includes stable ID, workspace/project/period, revision, scope `project_cutoff`, active/revoked state, exact authorizer user+membership and activation/record times. It does not claim a worker process is running.

Readiness values are `planning`, `overdue_waiting`, `preparing_calendar`, `blocked`, `frozen`. Missing actual calendar compositions and blocker counts cover the full target census. Blocker details are capped at100 and `truncated` identifies a bounded projection. Unconfigured automation is metadata, not a failure counter. Frozen periods have zero missing/blocker counts regardless of current automation state; grant revocation still applies to every internal delivery.

`latestRequest` is nullable `{id,state,createdAt,notBefore,processedAt}`, where state is scheduled/pending/completed/superseded. `latestOutcome` separately retains the latest completed receipt for the current grant, so an outstanding continuation can truthfully show prior pending progress. Actions are current authoritative `canConfigure`, `canRetry`, `canFreezeProject`; retry requests processing and does not promise synchronous completion. Generation blockers do not remove an otherwise authorized retry action.

Reads use a read-only repeatable transaction and database clock. They never reserve headers, materialize calendars, mutate grants, enqueue work, freeze or create reports.

## Internal immutable job and outcomes

`planning.cutoff_requested` version1 carries the immutable job without workspace/schema fields, which are supplied by its enclosing event:

```ts
{
  schemaVersion: 1, requestId, workspaceId, projectId, periodId,
  grantId, grantRevision, periodRevision, cutoffAt, sourceManifestHash
}
```

Internal cutoff instants are canonical UTC millisecond strings matching repository persistence (`Date.toISOString()`). Public period input spelling, command hash and result provenance remain unchanged. Source manifest covers generation inputs and remains stable across successful materialization progress.

The strict outcome contains `schemaVersion,requestId,periodId,status,processedAt,createdCount,remainingCount,baselineId,frozenAt,nextRequestId,blockedCode`. Status is `frozen`, `already_frozen`, `pending`, `not_due`, `stale` or `blocked`; `createdCount` is at most100. Pending commits a fresh durable continuation; early delivery commits a fresh request scheduled at the same cutoff. Neither is a freeze. Stale source processing may identify/request a fresh current job but never freezes from old inputs.

Before every internal receipt replay, resolve the exact current grant and authorizer, enter one workspace write barrier, re-read the grant, active membership and `plan.freeze_project`, and read database time after waiting. Replacement/revocation/downgrade denies historical worker receipt replay. No replacement administrator or recurrence grant supplies missing cutoff authority. Stored request hash must match the exact immutable job.

Only the target period is prepared. Required recurrence census includes paused series: pause is not cancellation. Current generation authority is necessary only for actual missing creations; complete persisted materialization and cancelled null-locator headers may freeze without future-generation reauthorization. Ordinary paused recurrence workers and manual semantics remain unchanged. Reauthorization/resume hooks enqueue a fresh cutoff request within their existing authorized transaction.

Each chunk creates at most100 real meeting/task/package compositions across the whole period. A pending chunk persists only census progress, continuation and receipt. The final complete chunk calls the existing in-scope project freeze, preserving personal/project snapshots, first package observations, locks and original unknown values. There is no global due-freeze recursion or nested public command. Any late SQL/outbox failure rolls back all calendar, baseline, audit, request and receipt changes together.

## Persistence and durable catch-up

Migration0013 adds immutable `planning_cutoff_grant_versions`, current `planning_cutoff_automations` heads, immutable-input/write-once-receipt `planning_cutoff_requests`, and a singleton `planning_cutoff_discovery_state`. Composite tenant/project/period and authorizer foreign keys prevent scope substitution. A partial unique index permits one live request per target; history remains available. SQL triggers forbid grant mutation/removal, request payload edits/removal and changed receipts. No existing period is enabled by migration.

Configure, cutoff updates and recurrence source recovery emit requests in the caller's workspace transaction. A fixed-clock, durable seek sweep discovers due active heads in `(cutoffAt,periodId)` order, at most100 targets per batch (default50). It commits each authorized target request before advancing the checkpoint. Lease ownership/revision prevents an old process advancing a newer owner's cursor; failures leave the cursor for safe deduplicated replay. Historical unchanged blocked receipts suppress hot retries until explicit recovery or changed source. A due same-grant/same-source terminal `not_due` receipt without a live request may be repaired by discovery. The normal early-delivery transaction always creates its replacement atomically; the terminal case is an injected invariant-recovery fixture, not a normal crash window.

The cutoff relay subscribes only to exact `planning.cutoff_requested` rows. Enqueue and dispatch receipt use the same database transaction. It validates version/schema/identities and exact payload equality against the immutable persisted request. Poison, unknown versions and unrelated events remain retained and visible; valid later rows can progress. Runtime queue/DLQ lifecycle is separately owned by the worker composition and never installs schema automatically.

## Verification and remaining gates

The backend integration suite uses the standard validated `TEST_DATABASE_URL` solely to create its own fresh disposable child. There is no `DATABASE_URL` fallback, base mutation or unknown-database cleanup. Source checks and PostgreSQL proof are recorded by the coordinator; acceptance remains pending until the complete backend/worker/UI suite and a coordinated compiled browser gate pass. Main-database migration, explicit queue installation and worker startup are separate operations.

Backend source checkpoint on 16 October 2026, 10:45 UTC:

- Source-aliased contracts/domain/db/API regression:64 files,1110 tests passed.
- Backend source TypeScript no-emit and scoped ESLint passed; whitespace diff check passed.
- Real PostgreSQL backend acceptance:21 tests passed, including populated pre-0013 upgrade, unchanged historical rows/journal, no implicit opt-in, target-only112+112 calendars, paused/cancelled policy, current authority and queued downgrade, canonical timestamp relay/replay, immutable SQL guards and late-failure rollback/retry.
- Standard nonempty test base `workloom_test_cutoff_backend_1040` stayed unchanged (SHA-256 `b516dc70a9680fb6a5992a4c352541c68ce19d43416723627f997b46b8290996`). Its exact child and base were removed; owned catalog count0 at `2026-10-16T10:45:05.624Z`.
- Read-only comparison matched new table columns/types/nullability/primary flags, foreign-key/check/index names and the planning-period metadata against snapshot0013. This is a structural inspection, not a generator no-diff claim. A schema generator check was not run because automatic approval review rejected its potential to create unintended migration artifacts.

These checks do not claim compiled browser acceptance, main migration, queue installation, worker startup or production deployment. The coordinator records worker queue and UI proofs separately.
