# Workspace/person Reports: proposed follow-up contract

**PROPOSED / NOT IMPLEMENTED.** Design follow-up, 19 October 2026. This document introduces no runtime behavior, accepted API or release claim; current project-dashboard implementation remains a separate bounded task. Existing contracts: [generic reports](88-generic-report-implementation-contract.md), [ordinary fields and reports direction](86-generic-fields-and-reports.md), [Time off/capacity](91-time-off-and-capacity.md).

## Recommendation

Add a workspace **Reports** entry later, reusing saved generic report definitions, field selection, coverage and snapshots. First ship cross-project/person comparisons of explicitly dated task cohorts; add true hours-worked trends only after an explicit dated-worklog source exists. A weekly/monthly selector is a display preset, never mandatory storage for Plan/Fact.

Official [Asana project dashboards](https://help.asana.com/s/article/project-dashboards?language=en-US) is a UX reference for a project Dashboard tab, chart selection and filters (checked 19 October 2026). It is not evidence of Workloom capabilities, completed implementation, data correctness or acceptance.

## Current source facts

- [generic-reports.ts](../packages/contracts/src/generic-reports.ts), filters/config: projectId, optional due-date/custom-date inclusive filter, numeric/duration measures and explicit Plan/Fact mapping. A report currently belongs to one project.
- The same contract’s number/result schemas: exact rational results, missing/null/zero coverage, canonical task identity, primary-assignee attribution, immutable initial snapshot and current/retained/added cohorts.
- [Generic report contract](88-generic-report-implementation-contract.md): one canonical task per report scope; foreign-home custom fields may be missing; tags currently filter, single-select field groups categories; participants do not duplicate generic hours.
- [Time off/capacity contract](91-time-off-and-capacity.md): capacity is schedule/holiday/approved-absence minutes over its own explicit interval. Task-level actual values do not provide dated worklogs.

## Three distinct kinds of chart

| Basis | Honest chart/label | What it does not establish |
| --- | --- | --- |
| Task cohort date: due date or selected custom date | “Current Plan/Fact on tasks due in each week” | Hours actually worked during those weeks |
| Immutable snapshot capture date | “Recorded total as of each saved snapshot” | What an uncaptured past state contained; differences are not work performed |
| Dated person worklog (future, explicit source) | “Hours recorded for work dates in each week” | Payroll, attendance or productivity without separately defined evidence |

Editing a due date can move the WHOLE current task value between cohort buckets. Editing Actual changes past-cohort charts when rerun. Display **Current values** and capturedAt/source version; offer an immutable saved result. `updatedAt`, field-edit audit timestamps and task completion status must never stand in for work date. Completion-date throughput is a later explicit event-derived source, not a currently available selector.

## Bounded proposed definition (typed catalogue; no expressions)

```ts
type WorkspaceTrendConfig = {
  scope: { kind: 'selected_projects'; projectIds: string[] };
  people: { kind: 'all_visible' } | { kind: 'selected'; membershipIds: string[] };
  source: 'task_cohort' | 'saved_snapshot_series'; // worklog source is a later version
  date: { from: string; to: string; basis: 'due_date' | 'mapped_date_field' };
  buckets: { unit: 'week' | 'month'; weekStartsOn: 1 | 7; timezone: string };
  hierarchy: 'root_tasks' | 'all_tasks';
  bindings: { homeProjectId: string; planFieldId: string; factFieldId: string;
    categoryFieldId?: string; dateFieldId?: string }[];
  groupBy: 'person' | 'category' | 'none';
  completion: 'done_only' | 'all_tasks';
};
```

This is a proposed shape, not an accepted API schema. Snapshot-series definitions instead require explicit snapshot IDs/series identity and identical scope/measure semantics; do not apply the task-cohort `date.basis` to their capture dates. Use a discriminated union in the eventual contract.

Require 1–20 selected projects, at most 100 people, at most 366 inclusive dates and 5,000 canonical tasks for an initial bounded implementation; reject overflow explicitly. All-time non-trend totals remain a separate valid view. For task date-only values compare local dates without instant conversion; timezone/week-start define bucket boundaries, not a shift of task dates.

Bindings are explicit stable field IDs by canonical HOME project, not label matching (“Hours Fact” in two projects is not an identity). Validate duration types/units and category single-select compatibility. A linked task with no permitted home mapping contributes missing/unsupported coverage; never borrow a same-named placement field. A future shared workspace field-definition model could reduce these mappings but is not prerequisite magic.

## Canonical task scope and attribution

1. Server unions permitted task presence across selected projects, then deduplicates by canonical taskId BEFORE filters, measures, grouping or pagination.
2. One canonical task contributes once to global/person/category totals regardless of placement count. Parent and child values remain independent; root/all selection is explicit, never automatic roll-up of both.
3. Current primary assignee owns generic task hours; Unassigned stays visible. Reassignment changes a current-cohort person chart. Historical attribution requires pinned snapshots or dated person worklogs; participants are not recipients of copied hours.
4. Per-project presence breakdown overlaps when tasks appear in multiple projects. Either label it non-additive or offer a separate explicit canonical-home allocation; do not make sum of project rows masquerade as the global total.
5. A single category mapping is additive; multi-tag grouping would require explicit overlap or allocation semantics. Missing category is Uncategorised, not dropped.

## Result, precision and comparison

Return bucket boundaries, source-kind label, exact numerator/denominator values with unit, current/capturedAt identity, authorised-scope coverage, missing-date counts, paired/eligible task counts and unassigned/category coverage. Plan/Fact/delta/ratio comparison must use the SAME eligible pairs; standalone field sums retain their own visible coverage and are not relabelled as paired comparison. Show missing Plan/Fact and zero-plan ratio as unavailable, not zero/infinity. Keep authoritative rational/minute arithmetic and apply one presentation precision at rendering; do not sum rounded chart labels.

Person category shares use recorded Fact of that person's same eligible cohort as denominator, not task count or planned hours; unknown/all-missing denominators stay unavailable. Category totals and shares must reconcile with the shown scoped recorded amount.

Capacity is an optional explicit **working capacity** series for the same people/calendar dates, including people with no tasks. Show gross, holiday, approved absence, available and unknown schedules separately. Cohort hours beside capacity is a comparison, not true utilisation or hours worked in that period; reserve that stronger ratio for aligned dated worklogs. Paid/unpaid names do not decide capacity: flags and approval state do. Availability remains neutral; no private leave type/note.

## Permissions, consistency and historical series

Apply current workspace membership/`reports.read` AND task/project/field visibility before aggregation; workspace report access never bypasses private-task policy. Resolve actor server-side and recheck current authority on capture/read/replay. A person selector changes a filter, not read permission; omit inaccessible names/IDs and never disclose hidden-task counts as coverage.

Bind result and all pages to definition revision, complete authorised canonical task/placement/value/definition revisions, permission epoch, date/bucket configuration and capacity's opaque source version. Reject changed expectedSourceVersion instead of mixing pages. Compute complete totals server-side, not from loaded pages. An initial snapshot for one project is not automatically a cross-project history point.

Snapshots pin definition, field versions, cohort/assignee/category membership and authoritative results; later changes to tasks, rules or unpaid intervals do not rewrite saved results. Reading old captures still checks CURRENT access; no grandfathered private data. Different schemas/measure mappings across captures require an explicit compatibility warning or separate series, never automatic comparison.

## Acceptance examples for the future slice

- One task linked into three selected projects counts once; inaccessible/private linked sources do not leak fields/counts.
- Moving a due date/reassigning/changing Fact moves a **current cohort** result but leaves an earlier authorised snapshot pinned.
- Missing/null/zero, empty scope, mixed units and missing bindings remain distinguishable; shares/paired deltas reconcile without double counting.
- 40h schedule minus one approved 8h absence gives 32h capacity; pending absence does not reduce it; unknown schedule is not zero.
- Revoked membership/changed permissions and stale continuation versions deny/refuse safely, including saved snapshots.
- No daily/weekly “worked hours” chart appears merely because a cumulative Actual field or its edit timestamp exists.
