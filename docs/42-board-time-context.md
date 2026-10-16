# Board density and retained time context

## Bounded behavior

Board cards expose task/parent opening, ordinary-task completion and explicit status editing. They do not display or edit weekly hours. Board therefore shows the existing task search and filters without the table's Week, Person and About hours controls. Its project-specific caption remains an accessible level-two heading and names the Board landmark, while visually only the loaded-task count and any partial-data explanation precede the lanes. Counts continue to describe the deduplicated loaded set; no result totals are inferred.

The time controller remains mounted once by ProjectPage in every view. The URL's week/person, Week navigation link, meeting selection/deep-link context, drafts, exact pending/unknown commands and dialogs retain their existing lifetimes. Switching back to Tasks restores the selected controls and time columns. This change does not disable time reads or promise lower request volume.

[`useTaskTimeTable.notices`](../apps/web/src/features/work-categories/useTaskTimeTable.tsx) contains the existing period/projection/access/opening errors and held-save recovery controls. Tasks includes this fragment inside its existing time control section; Board renders the fragment directly instead of that section. Each view renders it once. An empty Board has no empty time-control box; an unresolved save or retained time query failure remains visible and recoverable. Recovery uses the original session's week/person and original request/key, including after a view switch.

## Verification boundary

Source-only verification on 2026-10-16: **7 targeted test files / 38 tests passed**, with web `tsc --noEmit`, scoped ESLint and the repository localization audit passing. The [Board/time integration regression](../apps/web/src/routes/ProjectBoardTimeContext.test.tsx) and existing Board/time suites cover the accessible compact caption, unchanged time-control callbacks, restored week/person and retained meeting URL context, one pending/unknown hours notice in each view, exact lost-save retry across Board, and retained time-read error retry. Existing Board editing and ordinary time workflows remain regression gates.

No build, served asset replacement, runtime, browser, API or database operation is part of this source slice. The previous mobile screenshot established redundant controls/caption space; the resulting vertical layout and overflow still require a compiled browser check. No measured pixel saving is claimed from source tests.
