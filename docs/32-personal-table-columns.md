# Personal task-table column preferences

This is the reviewed contract and source implementation record for personal table columns. The coordinator released source work after the comments `0011` checkpoint; backend/frontend source and migration `0012` are implemented. The separately approved main migration and controlled runtime restart passed on2026-10-16 at09:43UTC; browser acceptance is recorded separately below. Source-only checks remain distinct from actual compiled/API/database evidence.

## Outcome and scope

Each person can choose the order and visibility of built-in and custom task-table columns for one project without changing colleagues' defaults. Preferences survive remount/reload. Shared custom-column settings remain the project defaults and continue to own widths. This slice stores no task values, task filters, grouping, sort, widths, saved-view names or permissions.

The existing graph-layout command is a concrete permission precedent: `setGraphLayout` in `packages/domain/src/dependencies/service.ts` uses `task.read` for a person's own layout. Personal table preferences use the same capability, so an active viewer may read/change only their own display preferences. A currently readable archived project remains eligible: these writes do not edit the project or its tasks and do not inherit normal entity-write archive restrictions.

## Exact HTTP and contract names

Both methods use:

```text
/api/v1/workspaces/:workspaceId/projects/:projectId/table-preferences/me
```

| Method | Input | Output |
| --- | --- | --- |
| `GET` | No query/body parameters | `personalTablePreferenceResponseSchema` |
| `PUT` | `UpdatePersonalTablePreferenceInput`, required `Idempotency-Key` | The same single-object envelope |

There is no route, query parameter or body field for another actor/user/membership. Identity is inferred from the trusted actor and current membership. Path IDs and custom field UUIDs use the existing canonical lowercase ID schema. Unknown body/query/ref keys are rejected.

The new additive contract module is `packages/contracts/src/table-preferences.ts`, exported through the package index:

| Exported schema | Exported type |
| --- | --- |
| `taskTableBuiltinColumnSchema` | `TaskTableBuiltinColumn` |
| `tableColumnRefSchema` | `TableColumnRef` |
| `columnChoiceSchema` | `ColumnChoice` |
| `personalTablePreferenceSchema` | `PersonalTablePreferenceDto` |
| `updatePersonalTablePreferenceInputSchema` | `UpdatePersonalTablePreferenceInput` |
| `personalTablePreferenceResponseSchema` | Existing envelope pattern |

```ts
type TaskTableBuiltinColumn =
  | 'title' | 'status' | 'responsible' | 'participants' | 'dueDate'
  | 'tags' | 'priority' | 'estimate' | 'weeklyPlan' | 'weeklyActual';

type TableColumnRef =
  | { kind: 'builtin'; key: TaskTableBuiltinColumn }
  | { kind: 'field'; fieldId: string };

type ColumnChoice = { column: TableColumnRef; visible: boolean };

type PersonalTablePreferenceDto = {
  workspaceId: string;
  projectId: string;
  membershipId: string;
  revision: number; // 0 only for an absent row
  columns: ColumnChoice[] | null;
};

type UpdatePersonalTablePreferenceInput = {
  expectedRevision: number;
  columns: ColumnChoice[] | null;
};
```

`column` is the final choice property name; earlier coordination drafts that used `ref` are superseded. The two weekly keys are stable preference IDs; their existing injected table IDs (`weekly-plan`, `weekly-fact`) remain an implementation detail mapped explicitly by the frontend.

## Ordered choices, bounds and defaults

A non-null array preserves both order and visibility, including hidden entries. Its first entry must be `{ column: { kind: 'builtin', key: 'title' }, visible: true }`. Title cannot move or hide. Other built-ins are optional; missing/new choices are reconciled in the UI without an automatic write.

Every reference is unique after canonicalization. The array has 1–210 entries: ten finite built-ins plus at most 200 custom references. Duplicate built-ins, duplicate field IDs (including case variants), arbitrary built-ins, malformed IDs, hidden/misplaced title and overflow fail validation. An empty array is not a reset; reset is explicit `columns: null`.

`columns: null` means **follow current shared defaults**, not a persisted copy of today's resolved columns. An absent row returns `{revision: 0, columns: null}` with inferred workspace/project/membership and creates nothing. A successful reset writes/retains a row with an incremented positive revision and `columns: null`; it never deletes the row or returns its revision to zero.

Canonical default reconciliation agreed with the coordinator and frontend owner:

- Full choice order follows the existing table layout: title, status, responsible, participants, dueDate, tags, priority, weeklyPlan, weeklyActual, custom fields in shared position order, estimate.
- Daily built-in defaults show title/status/responsible/dueDate/tags/estimate; participants/priority start hidden.
- Weekly plan/actual choices start visible but produce cells only after the existing time hook resolves a valid context for an explicitly selected week. Its existing own-membership fallback is valid; no explicit worker URL parameter or new person-selection prerequisite is introduced. They remain stored/configurable while that context is absent.
- Custom default visibility follows current shared `ProjectColumnsDto`; personal explicit visibility is not overridden by a later shared visibility flag. Widths continue to come from shared settings. Active definitions absent from shared settings append at the end and start hidden.

Known archived/disabled fields belong to the project and may remain in stored choices with their position/visibility preserved, but they do not render headers, values or editors while disabled. Their labels are ordinary authorized field metadata, never invented translations. Field locks affect editability, not personal visibility or ownership validation.

A newly discovered active own-project field appends according to current shared/default order and visibility. Merely discovering it causes no `PUT`, row creation, audit event or revision increment. The same is true when a weekly context appears/disappears or a known field is disabled/reactivated.

## Pure frontend reconciliation

The frontend owner will implement one pure reconciliation function with these inputs:

- Stored `ColumnChoice[] | null`.
- Current authorized own-project field definitions, including archived definitions.
- Current shared `ProjectColumnsDto`.
- Explicit week/person availability.

Its result contains `choices`, `effectiveVisibleRefs`, `addedRefs`, `inactiveRefs` and `invalidRefs`. For null, it derives current defaults. For an explicit array, it preserves known stored order/visibility, appends newly available references in default order, and computes a renderable subset. It never changes the stored preference or issues a write.

A foreign/missing field ID never resolves a name, value or editor. Such a legacy/corrupt stored reference is inert during GET/render and blocks a new Save until explicitly removed/reloaded. It is not grandfathered through backend validation. There is currently no field-delete command; archived genuinely owned rows remain valid, so ordinary disable/reactivate flows do not require an unknown-reference exception.

If reconciled choices exceed the 210-entry bound, show a controlled local limit state and retain the draft; do not silently truncate or send an oversized preference. Reset/discard remain explicit recovery actions. UI/source review must confirm this bounded behavior before implementation is accepted.

A single Columns control replaces the old Daily/All preset toggle. Legacy `?columns=all` is a deprecated display hint and does not override the persisted/null preference; it causes no mount-time navigation or automatic write. It may be cleaned from the URL only during a later explicit view action. The chooser uses explicit Save/Reset/Discard and keyboard-accessible move controls. Hidden/temporarily inactive choices keep their relative position. Closing/reopening, locale switching and a revision conflict retain the draft until an explicit choice discards it. Title remains pinned first. Changing personal columns must preserve existing inline editing, task selection, weekly context, existing route guards and uncertain task/comment commands.

## Current authorization and validation order

`GET` runs current membership authorization (`task.read`), current same-workspace project scope and the own preference read in one `REPEATABLE READ READ ONLY` transaction. A missing preference is synthesized only in the response as revision zero/null. The read performs no mutation, cutoff, census or materialization.

`PUT` uses the existing workspace write barrier with its bounded lock/statement timeouts:

1. Recheck the active actor membership/capability before and after the barrier.
2. Load the current same-workspace project, including an archived project, before receipt lookup.
3. Validate all submitted custom references against the current project in one bounded query (at most 200 IDs), including known archived definitions. Missing, foreign-workspace and other-project refs are rejected without resolving their labels. Reset/null requires no field lookup.
4. Find the receipt for this actor, command and operation key. The canonical hash includes command, project target, expected revision and the exact normalized choice order/visibility (or null). Matching input returns the stored outcome without writing; another payload under that key conflicts.
5. For a fresh command, compare the current own row revision (zero if absent) with `expectedRevision`. A mismatch is the established revision conflict; there is no automatic merge or overwrite.
6. Classify the new explicit intent as planning-inert, then persist the own row and increment revision. Every accepted fresh `PUT`, including reset and a same-content explicit save, advances this preference revision. Repeating the same operation key is the no-write exact retry.
7. Record minimal metadata-only audit/outbox and the idempotency receipt in the same transaction; return only after commit.

The command is `table.preference.set`, with a separate typed intent family `table_preference` and target `{ projectId }`. It is classified as an early no-op in the planning guard, before census/due-freeze work, and as an explicit `none` footprint. No generic bypass switch is introduced. Existing task/field commands, historical hashes and cached results remain unchanged.

An exact old receipt can be replayed after later valid preference saves and must return its original DTO without restoring the old head. The UI retires only the confirmed submitted session and refetches the current authoritative row; it does not treat a historical receipt as permission to overwrite a newer head. Current authorization/project/reference checks still precede receipt use.

A pending/unknown request retains its exact body, expected revision and operation key. It permits only unchanged retry until resolved; it must not be replaced with a reconciled draft/new key. Known conflicts require an explicit reload/review. No other actor's preference is queried or written.

## Persistence and migration plan

One new mutable head table, `personal_table_preferences`, is defined in the reviewed source `0012_personal_table_preferences.sql`:

- Natural primary/unique identity `(workspace_id, project_id, membership_id)`; no shared/default row and no arbitrary view key.
- Composite same-workspace project and membership foreign keys with no cascade delete.
- Positive stored integer revision, nullable JSONB `columns`, and finite server `updated_at` (internal metadata; not required in the public DTO).
- SQL structural/size/uniqueness/title constraints for non-null choices, aligned with the finite contract. Current field ownership is validated in the domain's bounded query, not by a JSON check that queries mutable state.
- No row backfill: all current people/projects initially follow defaults at revision zero. No task/field/shared-column rows are rewritten.

The preference head is mutable; audit and receipts retain their existing immutable/exact-outcome behavior. Reset is a versioned null head, not a delete. Preference writes do not increment `permission_epoch`, task/package/participant/worklog/field revisions or shared column-setting revisions. They do use the normal workspace change sequence for their own committed event.

Audit/outbox expose only workspace/project/membership IDs and preference revision. They contain no choice array, field labels, field values or resolved personal display content. The event type/entity is specific to personal table preference; the safe task activity feed does not pick it up.

The backend owner owns the new contracts/domain/db/API modules, exact guard/footprint additions, schema/client registration, migration SQL/snapshot/journal/readiness changes, backend tests and this document. TaskUX owns chooser/reconciliation/hooks, TaskTable/ProjectPage integration, frontend tests and the new English namespace. Existing shared field-management defaults remain under their current ownership.

The coordinator released `0012` source only after QA confirmed main `0011` complete. Migration review and disposable upgrade/fault tests precede any main application. Runtime build/restart/main migration remain coordinator-owned.

## Required acceptance gates

- Property/contract cases: canonical UUID duplicate detection, finite built-ins, title first+visible, all flag/order combinations, null reset, exact limits including 200 custom/210 total, malformed/foreign/missing reference rejection, and no client-selected identity.
- Pure reconciliation: hidden order preserved; defaults change dynamically under null; new refs append; archived own refs retain position but render nothing; reactivation recovers visibility; weekly context absence/presence does not discard preference; shared visibility changes do not overwrite personal explicit flags; no automatic writes; controlled overflow and invalid legacy refs.
- Authorization: active viewer can GET/PUT own preference on a readable archived project; another actor sees only their own head; revoked/foreign project denial occurs before exact receipt; current project/field scope is rechecked after the write barrier.
- Version/exact retry: initial revision zero creates no row; first write uses zero; concurrent different-key writers with one expected revision yield one success/one conflict; same-key concurrent requests commit once; changed payload/key conflicts; reset increases revision; old receipts replay unchanged after newer saves without restoring old state; lost post-commit return recovers by exact retry.
- Real PostgreSQL atomicity: injected failures after head save, audit, outbox and receipt roll back all rows and workspace sequence. Composite FK and JSON constraints fail safely. A populated pre-0012 upgrade preserves every old row/history and readiness is refused until the new schema exists.
- Planning isolation: overdue/blocked recurrence/cutoff fixtures remain unchanged; no task/field/worklog/shared-layout revision changes; audit/outbox contain metadata only; GET performs no writes.
- UI: keyboard reorder and visibility, explicit save/reset/conflict recovery, reload/remount and language switch draft retention, unknown/pending exact retry, no loss of inline/task/comment drafts, no foreign labels/values, weekly cells only for explicit context and no fabricated totals.

The requirements above are checked by the focused source-level evidence below; compiled build, main migration, API/browser and visual verification remain separate gates.


## Source verification — 2026-10-16

- **27 pure server cases pass**: four contract/property cases (including every one of 512 visibility combinations with varied order), six domain cases, four HTTP adapter cases, and 13 migration/static cases.
- **14 actual PostgreSQL cases pass** in `packages/db/integration/table-preferences.test.ts`. The populated pre-0012 upgrade preserves all old 55 public table row hashes and migration history; readiness refuses the pending schema, applies only 0012, then passes. Viewer access to a readable archived project accepts stored archived own-project fields. Actor isolation, foreign/missing field rejection, versioned reset/same-content save, concurrent exact/stale revision writers, old receipt after a newer head, and a lost application return after actual commit are covered.
- Four AFTER INSERT/UPDATE database fault stages (preference head, audit, outbox, receipt) leave all 56 public table hashes and workspace sequence unchanged. The SQL validator is checked against 512 flag/order combinations plus malformed shapes, JSON null, duplicate/title errors, total bounds and 201 custom refs below the total bound. Composite FKs, positive revision and direct JSON constraint failures are exercised.
- Actual `REPEATABLE READ READ ONLY` settings and a concurrent membership change prove the GET authorization/projection snapshot; subsequent fresh access is denied, and ordinary GET changes no rows. An overdue blocked recurrence fixture remains blocked with unchanged source rows and permission epoch after a viewer preference save. Audit/outbox allow only minimal IDs/revision metadata.
- Shared fixture compatibility derives absent own preferences from the actual resolved fixture actor and membership; explicit handlers still win, another actor's membership is never borrowed, and unknown PUT remains unimplemented. Malformed-success responses still reach the application parser unchanged.

The isolated run log is `/tmp/workloom-preferences-postgres.log`. Exact owned base `workloom_test_preferences_base_5e9006dd0f` and child `wl_db_preferences_11a2a187_test` were removed; a maintenance catalog read found zero names matching `%preferences%`. No main rows/schema, compiled `dist` or runtime process changed. Source aliases were used while the compiled API stayed frozen. After the coordinator's normal library build, the focused PG command is `npm run test:integration --workspace @workloom/db -- integration/table-preferences.test.ts` against an explicitly configured synthetic `TEST_DATABASE_URL`; the helper creates/drops its own empty database and never falls back to `DATABASE_URL`.

The chooser keeps the dialog open after a confirmed save and successful authoritative-head refresh, with localized **Columns saved. Current settings refreshed.** feedback until the next edit/discard. A late acknowledgement never opens/closes or refocuses a dialog and never installs an old receipt as the current head. A failed head refresh blocks new saves until an explicit successful Reload; confirmed refreshed feedback appears only once the head is fresh.

## Actual main/runtime/browser verification — 2026-10-16

Separate MAIN0012 approval applied only the reviewed migration at **09:43:15.248–09:43:17.444UTC** after a fresh private backup and an actual owned-copy restore. All55 old tables/17,177rows and12 prior migration receipts remained exact; the new table was empty, with six expected constraints/primary index and the immutable strict validator. Normal helper restart preserved all56 tables exactly. Current API returns the strict absent own revision0/null response without a write. Full preservation/backup/runtime provenance is in [25](25-ux-verification.md).

The complete **eight desktop/mobile preference cases passed21.2s**, last output **09:48:20.289UTC**, against the frozen compiled checkpoint (`86e88b7` test correction; production source `96c8da9` plus `72fbe92`). They verify actual DB save/reload, keyboard order and visibility, actor isolation with a real allowlisted viewer session, null reset at positive revision, real committed lost-ACK exact body/key retry across dialog-content remount, newer authoritative head preservation, hidden inline draft recovery, and weekly/field catalog reconciliation without automatic preference writes. Shared defaults/task revisions remain unchanged. This is not a claim of whole-page command recovery, browser actor switching or real revocation coverage.

The same run identified a **rapid drawer Close→Week route race**: the old task query can reappear when week selection follows close immediately. Settled preference cases pass with explicit actual-state assertions; that does not resolve the fast-action defect. The coordinator assigned a separate source fix and next-compiled rapid regression. See [25](25-ux-verification.md) for the original failing trace, exact route timeline and preserved initial QA failures. Main preference persistence/retry acceptance and this remaining route issue are reported separately.
