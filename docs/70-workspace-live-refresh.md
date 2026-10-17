# Proposed workspace live refresh

Status: **IMPLEMENTING — not accepted.** This document is the bounded implementation handoff, updated with the coordinator-approved protection rule. Backend source has been implemented and is under review; author-reported checks require root verification. This document records no accepted PostgreSQL, compiled native browser, runtime, authenticated-flow or old-tab result. The first accepted night checkpoint is recorded separately by its owner; it does not accept this feature.

## Outcome and limits

Two clients already authorized for the same workspace should see a colleague's committed changes without manually reloading the page. The initial transport is a lightweight authorized head read every five seconds while the document is visible and the interaction is unprotected. A changed head schedules reads of live workspace data; it never submits a user command, retries a write, changes a draft or reloads the browser.

The intended scale is a small team of about five to seven people. Five seconds is the polling interval, not an unconditional delivery SLA: network failures, hidden documents and protected editing deliberately delay both polling and visible refresh. During protected editing this feature provides no current-authorization, role-change or revocation-notification guarantee. On release it requires a fresh authorized head before any catch-up. Every actual server request still applies the existing current authorization; suspending requests does not authorize a request or bypass server permissions. No promise is made about public Auth, private ACLs, remote MCP, deployment, worker lifecycle or old-tab asset upgrades. Those remain separate gates. This feature uses the current local synthetic identity and existing access policy.

Head polling is preferred over SSE for this slice. Current source has no EventSource, SSE framing, WebSocket or PostgreSQL LISTEN transport. SSE would additionally require connection authentication renewal, disconnect/reconnect handling and event recovery. No stream, subscription table, new worker or database migration is proposed.

## Existing source boundaries

- [Workspace schema](../packages/db/src/schema.ts) stores nonnegative bigint `changeSeq` and `permissionEpoch`. Memberships have an ID, role, active/revoked state and revision.
- [Workspace write runner](../packages/db/src/transactions/workspace-write.ts) takes the workspace barrier, reauthorizes under that barrier and advances `changeSeq` on the first recorded change exactly once per transaction. Rollback also rolls back the sequence, audit and outbox. The head is a committed-change hint; it is not a task revision or a content feed.
- [Access queries](../packages/domain/src/access/access-queries.ts) reread membership on every execution. Absent and revoked memberships return the same NOT_FOUND outcome; an absent capability returns CAPABILITY_REQUIRED.
- [My tasks DB application](../packages/db/src/my-tasks/application.ts) demonstrates one repeatable-read, read-only transaction for authorization and all data reads. [Its domain service](../packages/domain/src/my-tasks/service.ts) does not invoke mutation runners, planning cutoffs or materialization.
- [Query keys](../apps/web/src/lib/queryKeys.ts) scope workspace data by actor and workspace. [Query error policy](../apps/web/src/lib/queryClient.ts) rechecks root workspace access after a nested denial; a root denial drops descendant caches and refreshes workspace discovery.
- [Protected drafts](../apps/web/src/lib/protectedDrafts.ts) and [protected commands](../apps/web/src/lib/protectedCommands.ts) have QueryClient-owned registries with `subscribe`, `getSnapshot` and `protecting`.
- [Task command owner](../apps/web/src/features/tasks/useTaskCommands.ts) registers retained task drafts and quick-create queues above editor lifetime. [Idempotent mutation](../apps/web/src/lib/useIdempotentMutation.ts) retains exact unknown commands and sends a retry only on explicit user action.
- [ShellFrame](../apps/web/src/app/shell/AppShell.tsx) knows current actor/workspace and is the proposed hook mount. It already owns actor and workspace departure cleanup.

Initial source discovery found no HTTP workspace-head endpoint. A dedicated backend endpoint is now being implemented/reviewed under the contract below. Internal `currentChangeSeq` repository methods alone are not authorized public endpoints and must not be exposed directly.

## Exact proposed public contract

Add a contracts module, exported through the existing contracts index. Proposed names are `workspaceChangeHeadSchema`, `workspaceChangeHeadResponseSchema` and `WorkspaceChangeHeadDto`.

```ts
type WorkspaceChangeHeadDto = {
  workspaceId: string;       // canonical lowercase idSchema
  actorUserId: string;       // canonical resolved actor, never client supplied
  membershipId: string;      // canonical current actor's active membership
  membershipRevision: number; // integer 1..2147483647
  role: 'owner' | 'admin' | 'member' | 'viewer';
  changeSeq: string;
  permissionEpoch: string;
};
```

The object is strict. Both sequence fields are canonical decimal representations of nonnegative PostgreSQL bigint: `0` or a nonzero-leading digit followed by digits, numerically at most `9223372036854775807`. Reject signs, fractions, whitespace, exponents, leading zeros and overflow. Compare these values with `BigInt`, never `Number` or lexicographic ordering. Include zero because an untouched workspace can have zero committed changes.

Role is included explicitly. Membership revision exists in current source and is useful for detecting access metadata changes, but this proposal does not assert that every possible administrative change already increments it. The explicit current role and workspace permission epoch complement that revision; none authorizes a future content request.

```text
GET /api/v1/workspaces/:workspaceId/change-head
```

The path uses canonical `idSchema`; query parameters are a strict empty object. There is no actor, membership, role, project, cursor or `since` input. Use the existing JSON envelope and request-ID conventions and `Cache-Control: no-store`. The client does not need ETags, HTTP 304 or an audit/event payload. No names, task IDs, timestamps, content or secrets enter this DTO.

## Authorized read service

The HTTP adapter resolves the actor using the existing identity adapter and creates a trusted web `CommandContext`. An injectable domain application exposes `getHead(context): Promise<WorkspaceChangeHeadDto>`.

Within one repeatable-read, read-only transaction:

1. Canonicalize workspace and actor IDs with the existing error conventions.
2. Call `authorizeWorkspace(repository.access, context, 'workspace.read')`.
3. Read `workspaces.changeSeq` and `permissionEpoch` in that same snapshot, scoped by the authorized workspace ID.
4. Return IDs, membership revision and role from the authorized access record plus decimal strings from the workspace row.

Do not call `runWorkspaceWrite`, `recordChange`, a planning guard, cutoff/census/materialization, a receipt writer or an outbox publisher. Do not acquire the workspace write barrier. Repeated head GETs must leave all data, revisions, jobs and receipts unchanged even when planning prerequisites are overdue.

Absent/revoked access remains NOT_FOUND, matching current policy; missing capability remains CAPABILITY_REQUIRED. A head read whose snapshot began before a concurrent revocation may finish under that snapshot. This is the same bounded snapshot model as the existing read pattern, not a claim that in-flight reads can never race revocation. Every later poll reauthorizes independently.

## Client owner and lifecycle

Mount one hook per QueryClient/current actor/current workspace in ShellFrame. Proposed key is `[...queryKeys.workspace(actorId, workspaceId), 'change-head']`. Enable only after a successful current workspace read, valid IDs and an unprotected interaction. Never mount one interval per task row or feature panel.

Use the existing API reader and AbortSignal. Validate response workspace and actor against the hook's captured canonical context before publishing a head. Membership identity must agree with the currently known own membership when available. An unexpected active membership identity requires a fresh workspace/membership read before resuming; it is not silently reused. A response for a previous actor/workspace/protection generation is discarded, including errors. Validate the generation and current protection state before any success or error can reach cache publication, global query-error callbacks or identity/access reset paths.

A current-generation response received while safely idle that reports another actor must trigger the existing identity recheck/reset path; do not apply its head or write its data under the old actor's keys. An identity recheck also waits until protection has ended. Do not act on a mismatched-actor response from an invalidated protection generation. The server's response, not a locally asserted header, establishes the actor.

Use one non-overlapping five-second polling cycle only while visible and unprotected, with no hidden-background or protected-interaction polling. Poll immediately on initial safe activation, visible safe resume and protection release; coalesce simultaneous triggers. Failed reads retry on the bounded polling cycle, with no tight loop or multiplication of TanStack automatic retries. Hidden state or newly acquired protection cancels the scheduled cycle, aborts the current head and feature-initiated catch-up reads, and invalidates their generation. Unmount/scope change does the same. An aborted generation can never publish success, denial or metadata changes, even if transport cancellation loses a race. The next safe activation obtains a fresh authorized head before ordinary catch-up.
Keep state separate:

- `observedHead`: newest validated successful head in this generation.
- `appliedHead`: target of the last fully successful live-data catch-up.
- `pending`: initial catch-up, fresh authorization required after protection, or observed changes not yet fully refreshed.
- one in-flight head read and one coalesced catch-up, each scoped to its actor/workspace/protection generation.

Acquiring protection invalidates the observed head for future dispatch and leaves a fresh-head-required marker. It does not queue an old denial or authorize applying an earlier deferred head. The last applied checkpoint can remain bookkeeping, but only a new head read after release can authorize starting catch-up.

Head identity includes membership ID/revision, role, change sequence and permission epoch. An equal head creates no new invalidation once catch-up has succeeded. Do not discard a pending refresh merely because the next head equals `observedHead`. Unexpected sequence regression within one active generation is a failed/invalid head, not a reason to replace newer observations.

## Initial race and catch-up completion

The first successful head of initial activation or safe activation after protection always schedules one safe catch-up, even when there is no previous head to compare. Otherwise a list loaded before the first head could miss a write committed between those requests. The captured head is not proof that already cached content contains that sequence.

At catch-up start, require a fresh current-generation head and recheck that the document is visible and unprotected; capture its target head and exact eligible live query scope. Cancel eligible reads begun before this catch-up, then mark live workspace queries stale and refetch eligible active queries from the server. Do not accept an already in-flight pre-head answer as this catch-up's completion. Inactive live queries stay stale so their next mount rereads normally; queries disabled until a valid context exists need not be forced to execute.

Use explicit error propagation or inspect each targeted query state. If protection is acquired during catch-up, abort its feature-initiated reads, invalidate its generation and leave a fresh-head-required marker; it cannot advance the applied checkpoint or trigger a stale denial/reset. `invalidateQueries()` resolving without throwing is not sufficient evidence that every refetch succeeded. Advance `appliedHead` only when all eligible active reads completed successfully for the same generation, and no targeted query was cancelled/removed because its scope changed. New or reenabled live queries observed during catch-up must either be included before completion or leave a follow-up catch-up pending. Do not make a query error look like successful synchronization.

If any refresh fails, retain the pending target and existing normal feature error/recovery presentation. A later equal-head poll must retry catch-up when safe. If a newer head arrives during refresh, complete only the captured target and leave the newer head pending for a coalesced follow-up. Never mark a newer head applied merely because a previous refresh finished.

The initial implementation does not claim a transactionally consistent snapshot across all UI queries. The goal is eventual authorized rereading of each active live collection, with existing server projections remaining authoritative.

## Editing, focus and exact retry

**Approved bound: suspend both head polling and ordinary content refresh** whenever any of these conditions holds:

- protected draft registry is active, including collapsed retained task/hour/field drafts and queued quick creates;
- protected command registry is active, including pending or unknown outcomes;
- an inline editor or picker is active, including a pristine editor;
- a form control/contenteditable owns focus, an IME composition is active, or an open dialog/menu owns the interaction.

The reason is concrete: task draft and unknown-command owners live inside ProjectContent. A root access denial can unmount ProjectContent and destroy their retained draft/body/key. Keeping a registry boolean alone does not preserve those values. This slice therefore pauses the poll that could initiate root eviction instead of claiming that continued authorization checks are safe while editing.

Subscribe to registry changes and relevant interaction/visibility transitions. Read current registry and DOM interaction state synchronously before starting a head or catch-up and before publishing a result/error. Acquisition of protection cancels the timer, aborts any in-flight head and feature-initiated catch-up, and invalidates their generation. A late success, 401, 403, 404, role/epoch change or network error from that generation must be discarded before any cache error callback, root recheck, identity reset, cache eviction or owner unmount can follow. Cancellation alone is insufficient; test a transport that ignores abort.

Protection release does not apply a buffered head, denial or metadata recheck. Immediately request a fresh authorized head in a new generation once visible and fully unprotected, then perform the coalesced catch-up only if that fresh request succeeds. Preserve a pending/fresh-head-required marker; do not queue an unbounded list of observations or announcements.

Do not close/reopen dialogs, move focus, change text selection, scroll the page/table, replace component keys, overwrite retained bases/drafts, auto-rebase revisions or clear error/recovery ledgers. Do not call a mutation's `reset`, `mutate`, `retryUncertain` or any quick-create queue action from the live-refresh owner. A head cannot confirm whether an uncertain write committed. Exact method/path/body/idempotency key stay with the existing owner until the person explicitly resolves them.

An editor opened while a safe refresh is already in flight acquires protection: cancel/invalidate that refresh and preserve the owner, its inputs, focus and scroll. Starting catch-up must not install a global loading state that remounts the route. No automatic access-metadata refresh is exempt from this protection rule.

The tradeoff is explicit: authorization/role/revocation information may be stale for the entire editing or unknown-outcome interval. This feature provides no revocation notification while protected. Every actual content or write request still reauthorizes server-side; this bound neither bypasses permissions nor guarantees that an already cached screen stays currently authorized. Unknown outcomes remain explicit user recovery, even if that protection lasts indefinitely.

This hook governs requests and refresh it initiates. Existing feature-specific explicit reload, mutation-success invalidation, window-focus and reconnect behavior remain independently testable; this slice alone does not prove those paths are draft safe or protect owners from an unrelated request's denial. Do not broaden its guarantee silently.

## Access changes, denial and transient failure

Only a current-generation head result/error received while visible and unprotected may enter access policy. A safe-idle head 401 invokes the existing identity recheck/reset path. A safe-idle head 403/404 follows the root workspace-denial/cache policy, cancels applicable reads, hides cached descendant content, refreshes workspace discovery and stops the automatic head/content loop. The same denial from an invalidated or now-protected generation has no cache/identity effect; it is discarded, and release requires an entirely new head request.

Implement narrow head-query integration in the existing query error policy or a shared helper so stale generation errors never reach the generic nested-denial callback. Do not call `discardWorkspaceData` as a shortcut: it clears mutation cache as part of intentional departure. A denial is not proof that an earlier write failed. Preserve neutral recovery language and do not label an unknown command unsaved.

After safe-idle denial, root access rechecks must run outside the ordinary success-publishing cache path. They may confirm unavailability and support recovery UI, but a successful background root recheck must not automatically overwrite the denied root cache, remount the old page or reenable polling. Otherwise head-denial/root-success can loop through owner unmounts. Automatic focus/reconnect/root reads must respect this suspended state. Do not recreate an enabled head query merely because eviction removed its previous entry.

Only an explicit user access-recovery action starts a fresh current-identity/root authorization read. That action also waits for any newly acquired protection to end. Resume only after current workspace access and identity binding are confirmed, then obtain a new head and perform initial catch-up. Recovery must not replay a write or publish success from a pre-denial/pre-protection request.

A changed role, membership revision or permission epoch detected safely idle schedules an access-metadata recheck under the same visible/unprotected/generation guard. Metadata rechecks also suspend on protection. No old observation may trigger them after release; obtain a fresh head first. They never enable a write from the head DTO alone. Content endpoints continue to make their own current authorization decisions.

Network, 429, 503 and malformed-response failures do not erase loaded content, discard drafts, clear pending/fresh-head-required work or send a write. Retry only in a safe visible idle cycle. Retain existing safe error presentation; avoid a global announcement every five seconds. Any localized synchronization message reports failure or paused refresh without exposing IDs, promising current authorization while editing, or claiming every view is current.

## Live query predicate and immutable exclusions

Only after a fresh safely idle head succeeds, begin with the exact `queryKeys.workspace(actorId, workspaceId)` prefix. Refresh the root workspace, memberships, project list/metadata/sections/statuses, tags, task lists/details/discussion/activity, fields/current values/history/columns, current time summaries, planning periods/packages/commitments/baseline lists/worklogs/report-run lists, meetings, recurrence readiness, dependencies, schedule context and other mutable authorized collections under that prefix. Existing feature readers still enforce their own context and bounds.

Exclude the head query itself to prevent feedback. Do not invalidate another actor/workspace, identity discovery unrelated to an access change, or a mutation cache.

Exclude these immutable pinned payload prefixes:

- `[...workspaceScope, 'planning', 'run', runId]` and descendants, including rows;
- `[...workspaceScope, 'workCategories', 'run', runId]` and descendants, including rows.

The singular `run` branch is immutable. Planning `period/.../runs` and work-category `runs/...` are mutable lists of available runs and must refresh. Preserve the currently selected run ID, week/person URL, task filters, graph roots and comparison/baseline choice. No live update recalculates a report or silently replaces its pinned run. Use [planning keys](../apps/web/src/features/planning/queries.ts), [work-category keys](../apps/web/src/features/work-categories/queries.ts) and the existing [recurrence live-planning predicate](../apps/web/src/features/recurrence/queries.ts) as source references.

Include `[...workspaceScope, 'imports', projectId, importId]` and its reconciliation descendant: [current import queries](../apps/web/src/features/imports/queries.ts) read artifact revision/status and reconciliation through GETs, so staged-to-applied transitions are mutable. Their explicit preview is a separate operation and must never be regenerated by catch-up. Include `[...workspaceScope, 'local-mcp-credentials']` for the current metadata/status list: [its owner](../apps/web/src/features/mcp/useCredentials.ts) keeps one-time secret material and issuance/revocation in separate local state and mutation hooks, which catch-up must not invoke or replace. No secret is read from the list. Explicitly classify any additional feature prefix encountered during implementation rather than guessing semantic mutability from its name.

## Proposed ownership and integration files

These are implementation ownership boundaries. Some backend paths are now being implemented/reviewed; the table is not a claim that all paths already exist or that any slice is accepted.

| Owner | Files and responsibility |
| --- | --- |
| Backend author | New `packages/contracts/src/workspace-change-head.ts`; contracts index export; new domain `workspace-change-head/application.ts`, `ports.ts`, `service.ts` and domain index export; new DB `workspace-change-head/application.ts`, `repository.ts` and DB index export. Implement strict DTO, authorized read-only snapshot and decimal serialization. No schema/migration edits. |
| Backend author | New `apps/api/src/http/workspace-change-head-routes.ts`; narrow injectable `AppDependencies`/factory/route registration in `apps/api/src/app.ts`. Preserve existing transport contracts. |
| Frontend author | New `apps/web/src/features/workspace/workspaceChangeHead.ts`, `useWorkspaceLiveRefresh.ts` and pure live-key predicate/state helper as needed; narrow query key addition; one mount in `apps/web/src/app/shell/AppShell.tsx`; narrow access-policy integration in `apps/web/src/lib/queryClient.ts`. Implement synchronous protection/generation gates before cache error publication, cancel-on-protection and fresh-head-on-release. Keep denied root recovery outside automatic success publication. Preserve feature draft/command owners. |
| Source-test author | New focused contracts/domain/HTTP tests; frontend hook/state/predicate tests colocated with their owners. Coordinate shared-file edits with authors rather than independently editing the same index, app wiring or query policy. |
| PostgreSQL-test author | New `packages/db/integration/workspace-change-head.test.ts` using the existing disposable DB support. Never use the runtime DB or mutate its memberships. |
| Native-test author | New dedicated two-client spec/config under `tests/e2e`; additive synthetic fixtures and explicit artifact destination coordinated with the runtime owner. Do not reuse or overwrite another active gate's files. |

The root coordinator owns assignment, final diff integration, source checkpoint, runtime permission and acceptance evidence. This document's author owns only `docs/70-workspace-live-refresh.md` for this proposal task. Other contributors' uncommitted work must be preserved.

## Required source acceptance

Contract/domain/HTTP tests must cover canonical IDs and decimal zero/max/overflow, strict request/response keys, authenticated context propagation, wrong actor/workspace/membership binding, active viewer reads, missing/revoked membership, capability failure and no side-effect interfaces. Role and membership revision must come from the authorized snapshot rather than client input.

Frontend tests must use fake timers and controlled promises for: one visible unprotected five-second cycle; no hidden or protected polling; immediate safe resume; no overlapping reads; stale generation responses ignored; equal head produces no repeated invalidation; initial load race catches up; zero-to-positive and values above Number's safe integer; multiple changes coalesce; query-key scope and both immutable-run exclusions; mutable run lists included; no recursive head invalidation.

Prove applied-versus-observed behavior with a failed active refetch, an equal subsequent head, a newer head arriving during catch-up, and a pre-head in-flight content read. Only successful fresh catch-up advances the applied target. Include active-query mounting/enabling during catch-up and cancellation after scope departure or protection acquisition. A cancelled feature-initiated content read must not publish a late denial that unmounts its editor owner.

Prove retained dirty task/hour/field drafts, collapsed quick-create queues, pristine focused inline editors/controls, menus/dialogs, IME composition and pending/unknown writes suspend both head GETs and ordinary content refresh. Acquire protection with a head in flight, including a transport that ignores abort: assert its late success/401/403/404 never reaches root/identity/cache policy or unmounts ProjectContent. Assert the exact retained draft, held command body/key, focus/selection/scroll and filter/week/person/pinned-run context survive. Release must issue an immediate fresh head before one coalesced catch-up; an old observed denial/success must never be replayed. Assert no non-GET request originates from the hook.

Prime caches before safe-idle 401/403/404 tests. A current idle denial takes precedence over cached success, triggers root policy and stops the loop. A successful automatic root recheck must not publish success or restart polling; only explicit fresh access recovery may do so. Repeat a denial across several polling/focus/reconnect intervals to prove there is no root-success/head-denial loop. Role/epoch-only access rechecks obey the same protection gate; acquiring protection cancels them and requires a fresh head on release. Network/503/invalid responses retain pending work and recovery state; recovery is not marked successful while a targeted query failed.

Run the affected contract/domain/API/web tests and repository boundary/type/lint/localization checks as appropriate to the actual diff. Root records broader checkpoint gates separately. A source-only success is not native or PostgreSQL evidence.

## Required isolated PostgreSQL acceptance

Use [DB disposable support](../packages/db/integration/support.ts), which requires a synthetic loopback TEST_DATABASE_URL and never falls back to DATABASE_URL. Migrate and seed only a newly created disposable database.

Verify initial sequence zero; committed write visible to a subsequent head; multiple events in one transaction advance once; rolled-back writes leave head unchanged; another workspace is unchanged; sequences above Number's safe range round-trip exactly. Verify membership identity/revision/role and permission epoch changes are reflected by subsequent reads and a revoked/foreign actor receives the existing indistinguishable denial.

Coordinate a read/revocation race to establish the stated snapshot boundary; do not claim stricter real-time revocation than the transaction provides. Compare data digests/counts before and after repeated head reads, including overdue planning/census prerequisites: workspaces, all content, planning baselines/worklogs, audit, outbox, receipts and queue data stay unchanged. No write barrier is taken by the head application. Read authorization and scalar head values belong to the same snapshot.

## Required two-client native acceptance

Use two real browser contexts/pages and real local API against a separately authorized synthetic gate fixture. Separate contexts allow independently selected local synthetic actors without shared-cookie ambiguity. A native gate is separate from unit fault injection and from production/Auth coverage.

1. Open the same project in A and B. A explicitly changes a task title/status/date and adds a discussion comment. While safely idle, B receives the relevant live changes without browser reload within one visible polling cycle plus bounded request time. Assert unchanged B URL/filter/week/person context and no unsolicited non-GET request.
2. In B hold a focused pristine editor, then an unsaved title/drawer/hour/field draft. A changes the same or another task. Both head GETs and ordinary refresh pause, and B's exact draft/focus/selection/scroll survive. Closing/resolving protection issues a fresh head immediately before one catch-up. Include acquisition of an editor while head/catch-up is already in flight; delayed success and denial from the invalidated generation must not affect B.
3. Hold a pending save and simulate a lost response using an explicitly labeled fault seam. A makes another change. B retains the exact original request/key, pauses head polling and sends nothing automatically. Only explicit Retry resends it. After resolution, live catch-up resumes without duplicate task creation or stale receipt replacement.
4. Exercise a collapsed retained draft/quick-create queue and a view switch. Keep pinned weekly and work-type run IDs/content unchanged while their run lists can discover new runs. Use loaded-page scope rather than claiming full task totals.
5. Hide B, change data in A, then reveal B. No hidden interval runs; once visible and unprotected, a fresh authorized head precedes resume catch-up. Repeat with transient head/refetch failure; pending work survives and an equal later head still retries failed catch-up.
6. Check another workspace is unaffected and scope departure rejects a delayed old head response. Exercise actor mismatch through an explicitly controlled local identity scenario; no old-actor cache is reused.
7. Revocation/403/503 must be separately labeled. Real membership revocation belongs only in a disposable isolated gate database. A transport-injected 403/503 proves UI handling only. Prime cached content and test safe-idle head denial: root policy hides cached data and stops the loop; background root success must not restart it. Only explicit fresh access recovery may resume. Separately start a head, acquire a draft/unknown-command protection, then deliver a late denied head through the labeled fault seam: it is discarded, ProjectContent and exact retained draft/body/key survive, and no new head is sent until release. Release must make a fresh head request; its result, not the discarded denial, determines safe-idle recovery. Record that revocation notification was intentionally suspended while protected; no current-authorization guarantee during editing follows from these checks.

Report compiled/browser, PostgreSQL, source, fault-injection, authenticated-flow and old-tab results separately. Missing runtime authorization or a skipped gate is not a pass. Do not restart/reseed the preserved runtime or migrate its database as part of implementing this read-only feature.
