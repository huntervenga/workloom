# Workspace manager dashboard: bounded read contract

**IMPLEMENTATION IN PROGRESS — NOT A RELEASE ACCEPTANCE.** This contract implements a bounded first part of [96](96-workspace-report-trends.md), alongside the project dashboard from [95](95-manager-calendar-board-and-reports.md). Runtime activation, browser acceptance and final verification are separate owner steps.

## Routes and configuration

- `GET /api/v1/workspaces/:workspaceId/workspace-reports/sources` discovers active projects' valid saved reports with ordinary duration comparison fields, current field definitions/options, active member names/avatars and the trusted workspace-local `today`/timezone.
- `POST /api/v1/workspaces/:workspaceId/workspace-reports/query` is a read. It creates no reports, snapshots, periods, receipts or audit records and needs no Idempotency-Key. No new tables or migrations are introduced.
- A query selects 1–20 distinct saved report references with expected revisions, one mapping per canonical home project, an inclusive date range of 1–366 days (1900–2200), week/month display buckets and all-active or explicitly selected people. `hierarchy` is explicitly root/all; `completion` controls eligible paired comparison only. All ordinary values remain custom fields selected by stable IDs, never names.
- A saved report supplies **bindings only**: Plan/Actual IDs, optional single-select category and optional custom date source. Its saved person/status/tag/date-range filters, hierarchy and capacity selection are not inherited. Therefore selecting an individual's saved report cannot silently narrow a team dashboard to that person. The workspace query's own people/range/hierarchy/completion are visible configuration.
- A query source can override `categoryFieldId` with a current same-project single-select field, or set null. An omitted override uses the saved report's category grouping if any; no category is guessed from a field name. `report_date_field` requires an explicit saved custom-date binding for every selected report; otherwise the query rejects, rather than substituting due date.

## Scope, attribution and precision

The scope is **selected authorized projects**, not an implicit whole-workspace claim. The server unions workspace-visible, unarchived canonical task presence in selected projects and deduplicates canonical task IDs before calculating totals. Home mappings supply numeric values; a linked task whose home project has no selected mapping contributes to `unmappedHomeTasks`, without borrowing same-named foreign fields. That count is mapping coverage before date filtering because an unmapped custom date is unknown. Root/all and selected people apply first.

For mapped tasks with no selected due/custom date, `missingDateTasks` records missing date coverage before the range filter; they are not assigned to an invented week. In-range tasks contribute once to team, person, category and one clipped calendar bucket. Current primary assignee owns generic values; participants/tags/children never multiply hours. All-active includes unassigned task values in an explicit Unassigned row; its capacity is unknown. An explicit person subset excludes unassigned tasks. Active people with no tasks remain visible through the capacity roster.

Plan and Actual standalone SUMs retain their own missing/null/zero/filled coverage. Paired comparison uses only the same tasks with both values, optionally done-only. These sums can differ: full-scope planned effort is not relabelled as the paired estimate. Shared exact rational arithmetic is reused from generic reports; durations must be nonnegative whole minutes, and rounding is presentation only.

Category identity is `(homeProjectId, fieldId, optionId)`, independent of labels. Two projects with options both called “Bugfix” remain separate unless a future explicit mapping merges them. Missing/null category contributes to an explicit Uncategorized group. Tags may filter in project reports but are not additive workspace percentages.

## Capacity and time meaning

Neutral working capacity is read in the same transaction and for the exact query people/dates. It uses the configured effective schedule minus company holidays and approved capacity-unavailable absences. A configured Mon–Fri 8h schedule yields 40h; one approved 8h absence yields 32h. Pending requests do not reduce it. A missing employment profile/schedule is **unknown**, never an invented 40h or zero. No leave reason, type or private note is returned. Member-level and bucket capacity retain this distinction; a bucket total is null if any selected member schedule is unknown.

Available/Plan/Actual can be displayed side by side, but task due/custom dates define **current task cohorts**, not actual worked dates. Moving a due date moves the whole current task value to another bucket. Field-edit timestamps, completion and cumulative Actual never become dated person worklogs. The response pins `dateSemantics: current_task_cohort`; true historical work-date trends and cross-project immutable snapshot series remain future sources from96.

Week buckets respect the workspace week-start setting and clip at range boundaries; month buckets clip at the same range. Capacity is calculated independently of task presence, so a member with no assigned task can still have 40h available. Category and paired accuracy do not measure product quality; no unsupported quality score is fabricated from hours.

## Authorization, bounds and consistency

The existing authorized shared workspace read barrier covers source references, field definitions/values, task presence, roster, labels and neutral capacity. Current workspace `reports.read` is checked before and after; current project existence and field scope/type/archive state are checked. Revoked/foreign subjects are concealed. Explicit former-member capacity follows the same leave-manager authorization as existing reports. No workspace report read bypasses visibility rules.

A changed source-report revision rejects with REVISION_CONFLICT. The response source digest binds request configuration, all selected source states/labels/field metadata, capacity inputs and workspace week start. Supplying an obsolete expectedSourceVersion rejects PREVIEW_STALE rather than mixing results. The complete server aggregate and bounded task detail rows are returned together, not reconstructed from client pages.

Bounds reject explicitly: >1000 active saved-report catalogue rows, >100 active catalogue members, >20 selected project mappings, >100 capacity people, >366 inclusive days and >5000 canonical source tasks. There is no silent catalogue or sum truncation. These are current capabilities, not a claim of arbitrary-size BI or multi-year worklog history.

## Verification owned by this implementation

Meaningful targeted cases cover canonical multi-project deduplication, mapping-only filters, full versus paired sums, zero/null/missing, undated/unmapped coverage, clipped buckets, duplicate-label category IDs, no-task capacity, unknown schedules, current authorization/revisions and read-only PostgreSQL conservation. Final actual command results and deployment status belong to the owner's acceptance document, not this proposed test list.
