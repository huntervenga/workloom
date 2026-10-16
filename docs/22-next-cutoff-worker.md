# P2c next slice: deadline freeze worker and truthful overdue UI

**PLANNED / NOT IMPLEMENTED.** Handoff drafted16October2026; no source, DDL, dependency, queue registration or worker start is authorized by this document.
The accepted application ends at bounded P5b plus local UI follow-ups; see [current journal](11-implementation-progress.md) and [handoff](21-local-pilot-handoff.md).

## Current behavior and precise gap

- [P2a](13-p2a-contract.md) freezes an overdue period before the next qualifying NEW command through the mandatory workspace guard.
- Current reads can still return `state:planning` after `cutoffAt`; they neither freeze plans nor create report runs.
- Exact successful command replay rechecks current authorization but performs no new mutation; it must not become an implicit deadline job.
- The [P3b worker](16-p3b-contract.md) materializes recurrence bindings and can freeze its completed overdue target period; it is not a general deadline scanner.
- A period without recurrence work or a later write has no general deadline job today. The worker is OFF in the accepted local handoff.
- Weekly report creation remains an explicit command. A background report scheduler, notifications, close/correction workflow and production operations are deferred.

## Bounded outcome

Add general project-period cutoff processing and a read-only explanation of overdue state, reusing immutable P2a freezes.
Process explicit stored UTC `cutoffAt` values; never infer a period from overlapping calendar weeks or reinterpret old instants in another timezone.
No new plan/fact arithmetic, personal-plan allocation policy, package completion accuracy or recurrence rule engine belongs in this slice.

## Actual reuse points (existing files; new names below are proposals)

| Responsibility | Current seam |
| --- | --- |
| Due-clock and typed mutation protection | `packages/domain/src/planning/freeze.ts`: `createPlanningMutationGuard`, `performFreeze`, committed-outcome unwrap |
| Period create/update and manual freeze | `packages/domain/src/planning/service.ts`; public port `packages/domain/src/planning/application.ts` |
| Same-pool transaction/census composition | `packages/db/src/planning/planning-application.ts`; `packages/db/src/recurrence/census-scope.ts` |
| Workspace lock, current membership, post-wait DB clock | `packages/db/src/transactions/workspace-write.ts`: `runWorkspaceWrite` |
| Stored-authority and durable delivery pattern | `packages/domain/src/recurrence/worker.ts`; `packages/db/src/recurrence/worker-facade.ts` |
| Exact subscription / same-TX enqueue | `packages/db/src/recurrence/outbox-relay.ts`; `apps/worker/src/relay.ts` |
| Explicit queue/DLQ install and strict runtime verification | `packages/db/src/queue/schema.ts`; `apps/worker/src/queue.ts`, `apps/worker/src/bootstrap.ts`, `apps/worker/src/runtime.ts` |
| Current period UI/read contracts | `packages/contracts/src/planning.ts`; `apps/web/src/routes/WeeklyPage.tsx` |

## Authorization decision before implementation

**Proposal:** explicit per-period cutoff delegation, issued/replaced/revoked by a CURRENT owner/admin with `plan.freeze_project`.
There is NO such grant on today's period.create command/table. Do not treat an old creator ID, last editor or recurrence grant as an existing delegation.
Existing periods start `automation_not_configured`; an authorized person must explicitly enable them. New-period opt-in must also be explicit.
Persist immutable grant revisions with workspace/project/period, authorizer user+membership, scope `project_cutoff`, revision, state and activation time.
A job carries IDs, grant revision, period revision, cutoff instant and request ID—not actor, role, capabilities, MCP bearer or caller-selected server time.
Resolve hints server-side, then re-read the CURRENT grant and active authorizer membership/capability under the same workspace barrier BEFORE any receipt.
Revocation/downgrade blocks new delivery AND old-result replay; never silently substitute another administrator. Reauthorization is a separate audited command.
Use source `job`, real stored authorizer identity, grant ID/revision and job correlation as separate audit provenance; no payload impersonation.
If a service principal is desired instead, approve its identity/capability/revocation contract first; it is not a shortcut in this proposal.

## Job / transaction protocol

1. Proposed internal `freezeDuePeriod(job)` opens ONE real workspace UOW; no public freeze command nested in another runner.
2. After the lock, use `scope.barrierAt` from `clock_timestamp()`. Re-read target period, project, current grant and current capability.
3. Validate current tenant/scope/access AND that the job names the CURRENT grant revision before any receipt. Old-grant delivery is denied/stale; it cannot borrow replacement authority.
4. Receipt key is workspace+request ID, independent of the execution actor. The request ID is stable only for the SAME immutable job; replacement grant/cutoff requests get fresh IDs and hashes.
5. After authorization, exact lost-ACK replay returns its original outcome without another event; payload mismatch conflicts. Only a NEW delivery then evaluates not-due/period-source change/already-frozen outcomes. Never backdate `frozenAt` or rewrite a baseline.
6. Ensure ONLY the target period's recurrence census through the existing in-scope materializer; do not enter the global due-freeze loop recursively.
7. Complete census calls the existing `performFreeze(scope,period,'project',null,'cutoff',tools)` in that same transaction.
8. It creates/reuses personal and project snapshots, locks, first package observations, audit/outbox and receipt atomically.
9. Unexpected SQL/outbox failure rolls back ALL prerequisite materialization, snapshots, events and receipt; retry uses the same request ID.
10. A stale source/request may request a fresh current job durably; it never freezes a client-supplied old preview or commits a partial baseline.

Current task/field/meeting/import/schedule guards remain mandatory. The worker supplements them; it cannot provide a bypass while a job is delayed.
Existing tagged `FIELD_LOCKED`/`PREVIEW_STALE` outcomes still commit prerequisite freeze before rejecting the proposed user edit OUTSIDE the transaction.
Pure worker progress has its own typed outcome, not a fake successful user mutation or an exception caught after partial handler writes.

## Recurrence and bounded recovery

- Reuse stable instance identity, cancelled header-only census, current materialized roster/self semantics and immutable calendar locks from P3b.
- The cutoff grant does NOT replace generation grants. Missing/revoked recurrence authority blocks readiness without borrowing the cutoff administrator's rights.
- Proposed policy: paused pre-generation is not cancellation; required cutoff census may prepare registered occurrences under STILL-current generation grants.
- Confirm that policy explicitly in UI/contracts before GO; ordinary recurrence background jobs must retain their accepted paused/no-hot-retry behavior.
- At most100 actual entity creates per chunk. Reserved/cancelled null-locator headers do not consume that budget or become fake missing tasks.
- Pending chunk commits only approved target census progress + durable continuation + receipt; NO partial baseline or unrelated proposed edit.
- Final complete chunk freezes ONLY its overdue target period atomically. Two overdue periods each exceeding100 must progress independently without A↔B recovery loops.
- Source manifest reflects generation inputs, stable across its own progress; full readiness can separately reflect output state.
- Blocked grants need explicit recovery; pending is normal work, not repeated failure-budget consumption. Reauthorization/resume must guarantee a fresh durable request.

## Discovery, queues and health

Propose an exact versioned event `planning.cutoff_requested` v1 and a separately registered queue/DLQ; these exports/subscriptions do NOT exist yet.
Period opt-in/cutoff changes/reauthorization enqueue in the SAME transaction; queue relay enqueue+dispatch receipt uses the same DB transaction.
Initial delivery must be durably scheduled NOT BEFORE stored cutoffAt; an early `not_due` receipt is not completion of the cutoff.
Catch-up after that instant emits a FRESH due request ID if needed, never reuses a cached early request forever; deduplicate active pending requests per target/grant/cutoff.
Add a bounded due-period discovery sweep for catch-up after long inactivity; select only minimal eligible tenant IDs with stable seek pagination, not all task documents.
The sweep must persist durable requests before advancing its checkpoint; it cannot rely on one process timer having survived until the deadline.
Unknown versions of that EXACT subscribed event remain blocked/visible while supported v1 rows progress; unrelated outbox events remain untouched.
Reuse finite connection/lock/statement/handler timeouts, DLQ retention, health and drain/SIGTERM behavior; explicit local queue CLI owns schema changes.
Runtime never installs/repairs queues. Proposed concurrency2/process is not a global replica limit; the workspace DB barrier provides strict tenant serialization.

## Truthful overdue UI (read-only proposal)

Expose current authorized readiness with persisted period state, serverNow, cutoffAt, baseline ID/frozenAt, automation status and bounded blocker codes.
Display `overdue_waiting` / `preparing_calendar` / `blocked` separately from a genuinely persisted `frozen`; worker-OFF is not success.
A read never starts a job, materializes an occurrence, freezes a plan or creates a report. Explicit configure/retry/manual-freeze actions require current capabilities.
Keep historical period DTO/cache/pinned JSON unchanged: a new projection or optional NO-default addition, not a fabricated state in old snapshots.
Show requested cutoff and actual freeze time when delayed. Missing first estimate remains original-unknown; later current values never fabricate an original baseline.

## First implementation and ownership

1. Freeze exact grant/job/readiness DTOs, outcomes, bounded discovery cursor and current-authority ports; review migration/legacy JSON compatibility.
2. Core owner: additive grant/receipt/discovery persistence + same-UOW facade using existing freeze/census; one migration owner, no applied migration edits.
3. Backend owner: exact relay/queue handler and bounded catch-up lifecycle; frontend owner: truthful readiness and explicit owner/admin delegation controls.
4. QA owner: real PG races/faults + actual queue lifecycle + desktop/mobile overdue states; preserve current old-column/cache/report proof before dev upgrade.
5. Accept only the bounded general cutoff+UI slice; scheduler-created reports remain deferred. Worker stays OFF until a separate verified start is authorized.

## Meaningful acceptance

- Real DB-clock cutoff/edit and manual-freeze/job races: exactly one project baseline, correct original sources, protected edit rejected after committed freeze.
- Lost ACK, concurrent duplicate deliveries, stale grant and revoked/downgraded authorizer: no duplicate snapshots/continuations; authorization precedes receipt replay.
- Two >100-candidate overdue periods, cancelled headers, paused policy, missing grants, late SQL failure and same-key recovery: complete census or truthful blocker, never partial baseline.
- Days of inactivity then restart catch-up, cutoff moved under the barrier, overlapping periods and DST gap/overlap inputs: stored UTC instant honored once, no timezone re-resolution guess.
- Worker stopped/blocked/delayed UI, viewer reads, foreign tenant probes and manual recovery retain current ACL and accurate timestamps without read-side writes.
- Unknown/null estimates, shared detail packages, missing fields and already-frozen personal sources remain immutable; no imported hours become original plan/fact history.
