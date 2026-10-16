# Bounded task comments and safe activity

This document fixes the first comments/activity contract and implementation boundaries. Source implementation and focused tests are complete. Migration application, compiled runtime and browser acceptance are separate coordinator-owned gates; source completion does not imply that the running database or API has changed.

## Scope and permissions

Ordinary workspace-visible tasks gain create-only plain-text comments and a small activity feed. Existing `task.read` permits an active viewer to read both feeds; `task.edit` permits comment creation. This adds no capability, task visibility mode, mentions, notifications, rich text, links, attachments, edit/delete command, or MCP tool.

Current workspace membership and the current task's workspace/visibility/existence are checked for every request. The existing model supports only `visibility = workspace`; this slice does not claim private-task ACL support. Comment creation rechecks the target before looking up an idempotent receipt, including on exact retry. Missing/revoked/out-of-scope requests retain existing privacy-safe denial behavior.

Fresh comments require an unarchived task and project. An authorized exact retry may replay a previously confirmed comment after archive, since it creates no new comment. Read access to archived task comments/activity remains subject to the same current task scope.

## HTTP and shared contracts

All paths are beneath `/api/v1/workspaces/:workspaceId/tasks/:taskId`:

| Method and suffix | Input | Result |
| --- | --- | --- |
| `POST /comments` | `CreateTaskCommentInput`, required `Idempotency-Key` | `taskCommentResponseSchema`, one `TaskCommentDto` |
| `GET /comments` | `TaskCommentsQueryInput` | `taskCommentsResponseSchema`, `TaskCommentDto[]` plus required `meta.nextCursor` |
| `GET /activity` | `TaskActivityQueryInput` | `taskActivityResponseSchema`, `TaskActivityDto[]` plus required `meta.nextCursor` |

The additive module is `packages/contracts/src/task-comments.ts`, exported through the existing package index. Exact export names:

- `createTaskCommentInputSchema` / `CreateTaskCommentInput`: strict `{ body: string }`.
- `taskCommentSchema` / `TaskCommentDto` and `taskCommentResponseSchema`.
- `taskCommentsQuerySchema` / `TaskCommentsQueryInput`, and `taskCommentsResponseSchema`.
- `taskActivityQuerySchema` / `TaskActivityQueryInput`, `taskActivitySchema` / `TaskActivityDto`, and `taskActivityResponseSchema`.

Both page queries accept only `limit` (default 50, integer 1–100) and `cursor` (opaque string, at most 2048); no client author, workspace, task, order expression or content filter is accepted in query parameters. `meta.nextCursor` is an explicit string or null, never omitted. A response page contains at most 100 rows.

The comment body is nonblank, contains no NUL, and is at most 4000 UTF-16 code units, matching the browser input limit. Validation does not trim, normalize newlines, rewrite markup, or change submitted content. The database also bounds text length. Whitespace-only strings are rejected. The UI renders the body as React text with preserved line breaks; HTML/Markdown/autolinks are outside this slice.

`TaskCommentDto` has exactly these public fields:

```ts
{
  id: string;
  workspaceId: string;
  taskId: string;
  authorUserId: string;
  authorMembershipId: string;
  authorDisplayNameSnapshot: string;
  createdAt: string; // UTC server timestamp
  body: string;
}
```

IDs, the author pair, display-name snapshot and creation time are generated from trusted persistence/context under the write barrier. They are immutable. The snapshot label remains the name recorded when the comment was created, even after a later profile/membership label change. The client cannot submit any author or timestamp field.

`TaskActivityDto` has exactly these public fields:

```ts
{
  id: string;
  workspaceId: string;
  taskId: string;
  kind: 'created' | 'updated' | 'archived' | 'restored' | 'schedule_updated';
  actorUserId: string;
  actorMembershipId: string;
  actorDisplayName: string; // CURRENT membership label, not a historical snapshot
  occurredAt: string;      // immutable audit server timestamp
  changeSeq: string;       // positive bigint represented without JS precision loss
  eventOrdinal: number;
}
```

Activity actor IDs/time come from the immutable audit event. Its display label comes from the current same-workspace actor membership; the feed must not present it as a historical name. This intentionally differs from the stored comment author snapshot.

## Safe activity projection

The SQL query permits only `audit_events.entity_type = 'task'` with the current task ID/workspace and the five listed actions. Whitelist filtering occurs before the page limit. The projection selects only the public DTO columns; it never selects or exposes `diff`, `reason`, request ID, credential ID, raw payload, arbitrary field values or body text.

`task.schedule_updated` is an existing intended event: the schedule apply handler in `packages/domain/src/schedule/service.ts` records `entityType: 'task', action: 'schedule_updated'` when start/due dates change. The bounded feed labels this event without showing its raw date diff. Existing generic task creation/update/archive/restore events are included. Unknown/new audit actions remain absent until explicitly reviewed and added to the contract/SQL whitelist.

Comments use a separate feed. Their audit event is `entityType: 'task_comment', action: 'created'`; it is not folded into generic task activity. Audit/outbox contain comment/task/project IDs and safe metadata only, never comment body or author name. This prevents body duplication into unrelated event consumers.

## Read snapshots and pagination

Each feed page performs current membership authorization, current task-scope lookup, permission epoch, cursor checks and page projection in one PostgreSQL `REPEATABLE READ READ ONLY` transaction. Authorization precedes cursor decoding/use. No read invokes the write runner, planning guard, cutoff, census or materialization.

Comments order by `(createdAt DESC, id DESC)`. Activity orders by `(changeSeq DESC, eventOrdinal DESC)`, whose pair is already unique within a workspace. Queries request `limit + 1` rows, at most 101, then return at most the requested limit. The actor label is joined in the activity query; there is no per-event membership query.

Distinct authenticated cursor kinds (`task-comments` and `task-activity`) bind version, workspace, task, actor user, current membership, permission epoch, limit and the respective last-row anchor. Cursor lifetime is 15 minutes. Legacy task/My tasks cursors and cursors from another task/feed/actor/query are rejected. Every new page reauthorizes before using the cursor. A process restart may invalidate ephemeral-key cursors; the client then reloads the first page.

Pages do not retain a database snapshot across requests. New events/comments may appear ahead of the current continuation. The UI deduplicates loaded IDs, displays a loaded count when useful, and offers refresh; it does not claim an exact full total.

## Write ordering, exact retry and planning isolation

The command name is `task.comment.create`, separate from existing `TaskMutationCommand`. The canonical hash covers the command, target task ID and exact validated body. It injects no new defaults into old task commands or stored receipts.

The transaction uses the existing workspace barrier and bounded lock/statement timeouts:

1. Authorize current `task.edit` membership before and after acquiring the workspace row barrier.
2. Load/authorize the current workspace-scoped task and project before receipt lookup. Unknown/out-of-scope target returns the established denial.
3. Look up the actor-scoped `task.comment.create` receipt. Same target/body/key returns the stored validated result without any writes; a reused key with another target/body conflicts.
4. For a fresh command, reject archived task/project and classify the explicit comment intent as planning-inert.
5. Capture server time and trusted author identity/name, allocate a comment UUID, and insert the append-only row.
6. Record metadata-only audit plus outbox and insert the idempotency receipt in the same transaction. Return the created DTO only after commit.

Any unexpected failure rolls back comment, audit, outbox, receipt and workspace change sequence together. A lost response after commit is resolved by resending the identical command/key. A pending/unknown write must retain its exact submitted body/key and disable a conflicting new submission; no draft is silently replaced after an unrelated confirmation.

The typed planning intent is a separate `family: 'comment'`, `command: 'task.comment.create'`, `target: { taskId }`. It is added explicitly to the exhaustive intent union and footprint classification (`none`), with an early no-op guard classification before census/due-freeze work. There is no generic bypass boolean. Existing task/status/field/meeting commands keep their guards. Composition reuses the existing guard seam; comment creation must never read/freeze periods, materialize recurrence or mutate task/package/participant/worklog revisions.

## Append-only migration and ownership

The backend owner owns the additive contract/domain/db/API modules and their tests, plus the exact shared intent/footprint changes, schema addition and one reviewed `0011_task_comments.sql` migration/journal entry. The frontend owner owns TaskDrawer integration, hooks, draft/unknown-outcome behavior and `comments.json`. Neither owner reverts or rewrites another owner's files.

The reviewed migration source adds `task_comments`, a task timeline index on workspace/task/time/ID, composite same-workspace task FK, and author membership/user FK. A supporting unique constraint on `memberships(workspace_id, id, user_id)` enforces that the immutable author user and membership are the same identity. The comment table has length/time constraints and UPDATE/DELETE/TRUNCATE rejection triggers. `REQUIRED_TABLES` includes the new table so an unmigrated database fails readiness clearly. There is no task revision column change, data backfill or rewrite.

The SQL, journal, schema and migration tests are reviewed together before application. Disposable database migration tests are a separate authorized action. Applying this migration to the existing local database, rebuilding compiled runtime or restarting API is coordinator-owned and requires the checkpoint window; it is not implied by source approval.

## Acceptance gates

Meaningful tests must cover:

- Strict body/identity/query input and explicit pagination metadata; exact submitted text survives round-trip.
- Viewer reads and create denial; absent/revoked membership; cross-workspace targets; current task access checked before exact receipt replay and before bad cursors.
- Exact retry without duplicate row/events/receipt; concurrent same-key requests; changed body/target key conflict; lost post-commit response followed by exact retry.
- Failure after comment insert, audit insert, outbox insert and receipt insert rolls back all proposed state and workspace sequence.
- Composite task/author FKs and actual database UPDATE/DELETE/TRUNCATE rejection.
- Same-time comment ties, activity sequence/ordinal boundaries, cursor kind/actor/task/epoch/limit binding and expiration.
- Whitelist includes intended existing actions including schedule changes; unknown actions and seeded sensitive diff/reason/body fields never enter the public activity DTO.
- Overdue/blocked recurrence fixtures remain unchanged across comment creation; task/package/participant/worklog revisions, planning baselines and recurrence state do not change.
- UI shows markup as literal text, retains the draft through locale switching/close/reopen where required, uses localized feedback keys and safe generic server errors, and preserves exact pending/unknown retry semantics.

Build, database, API, browser and visual evidence must be reported separately. This contract is a plan, not evidence that an endpoint or migrated table is already running.


## Source verification — 2026-10-16

The backend, additive contracts, explicit inert guard classification, schema/SQL/snapshot/journal, readiness table registration and HTTP routes are implemented. Source-alias checks avoided all package `dist` writes while the previous compiled API remained frozen.

- Thirty pure server cases pass: contract validation (3), comment/activity domain rules (7), signed cursor boundaries (3), HTTP transport (4), and migration journal/static checks (13).
- Fourteen actual PostgreSQL integration cases pass. This includes a populated pre-0011 upgrade: all old 54 table row hashes and existing migration history stayed unchanged, readiness refused the pending schema, only `0011_task_comments` applied, and readiness then passed. The remaining cases cover the atomicity, authorization, pagination, current/snapshot labels, safe activity and planning-isolation gates listed above.
- Four rollback cases inject an AFTER INSERT database failure at the comment, audit, outbox and receipt stages and compare every public table hash, including workspace sequence. A separate failure is injected after a real PostgreSQL transaction commits; retry returns the sole confirmed row without changing any table. This is a simulated lost application return after actual commit, not a claim of a physical network disconnect test.
- The overdue recurrence fixture has an incomplete census and a revoked stored authorizer. Comment creation leaves all task/package/participant/worklog/planning/recurrence source tables unchanged; readiness remains blocked.
- Frontend source/component acceptance from its owner: 169 focused cases pass, including 16 new discussion cases. Ordinary saved tasks use mounted sibling Details/Discussion panes, exact plain-text bodies, viewer/current-denial handling, lazy separate Activity, per-task draft identity and exact pending/unknown retry (including authorized archived receipt replay). Meeting discussion UI remains deferred.

The final disposable run used `/tmp/run-workloom-comments-postgres.mjs` with Node 24 and source aliases; its captured log is `/tmp/workloom-comments-postgres.log`. The owned base `workloom_test_comments_base_5dcfd1fc4e` and child `wl_db_comments_1da12755_test` were removed. The earlier passing 13-case run used child `wl_db_comments_55a3891b_test`, also removed. No main-workspace rows, runtime process, compiled package or application database migration was changed by these checks.

The repository test file is `packages/db/integration/task-comments.test.ts`. After the coordinator's normal library build, run `npm run test:integration --workspace @workloom/db -- integration/task-comments.test.ts` against an explicitly configured synthetic `TEST_DATABASE_URL`; tests create/drop their own database through the existing helper and never fall back to `DATABASE_URL`. Unit tests live beside the new source modules. Browser and compiled API evidence remains pending and belongs in the UX verification record.

Final source checks also passed server/web TypeScript, scoped ESLint, localization audit and whitespace checks. Drizzle regeneration reported no schema changes (`/tmp/workloom-comments-schema-check.log`). Normal web verification passed four dedicated discussion-error privacy/recovery cases, the existing ten API cases and production catalog discovery (15 cases together).
