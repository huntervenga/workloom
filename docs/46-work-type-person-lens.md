# Saved work-type team/person chart lens

The saved work-type report adds one native selector above its chart and category table: **All selected people** or a person recorded in that saved report. This is a local display choice. It does not change the report cohort, calculate a report, fetch another snapshot, or submit a command.

## Saved data and scope

The chart, adjacent category table, recorded-hours denominator and active-entry count change together. Team scope uses the saved run's `byCategory`, `totalActualMinutes` and `activeSourceCount`. Person scope uses that exact saved `byPerson` entry. Names, stable bucket IDs, labels, colors, minutes and percentages remain pinned to the saved report; live membership names or current category definitions do not replace them. Buckets with matching labels remain separate.

Uncategorized hours remain in the displayed denominator. A zero-hour active entry stays visible with an undefined saved percentage. A selection with no active entries has separate empty-state copy. Null percentages remain undefined even if recorded minutes are positive; the client does not invent or recompute a share. A missing category list is shown explicitly. These are shares of recorded hours in the saved report, not capacity, productivity or complete weekly effort.

The summary metrics are labeled as saved totals for all selected people. Existing per-person disclosures remain available. Historical source details and their explicit pagination remain report-wide, with visible wording that the chart selector does not filter them. Current task links retain their existing authorized revalidation and historical/current-title distinction.

## Selection and existing guards

Changing saved runs resets the chart to All selected people, even when both runs contain the same person. If a selected saved person becomes unavailable, the selector safely returns to All selected people with a notice and does not silently restore that person when data appears later. Locale changes preserve the selected saved membership identity while translating the controls.

The native label/select, chart image descriptions and semantic category table provide keyboard and screen-reader access. Existing report-loading, wrong-period and current-access-denial gates remain before the lens. No permissions, report setup drafts, idempotent command/recovery behavior, source pagination or report selection navigation are changed.

## Source verification

`WorkTypePersonLens.test.tsx` exercises synchronized chart/table/denominator/count changes; immutable cached report data and zero extra requests; snapshot names/colors and distinct bucket IDs; Uncategorized and active-zero/null/no-active-entry states; run and unavailable-person reset; locale retention; report-wide source pagination; and the existing wrong-period and access-denial gates. The existing work-category flow suite remains an adjacent regression gate.

This document records source behavior and focused unit verification. Compiled browser, visual/mobile layout and old-tab acceptance remain separate coordinator/QA gates. This slice performs no build, runtime restart, migration or main-database operation.
