# Task table section collapse

The Tasks table has one native disclosure button in each section header. Collapse hides that group's task rows and quick-add editor while leaving its name, loaded count, permitted rename action and Add task action available. Enter, Space and pointer activation use the same button; focus stays on it as its expanded state changes. Task selection for Graph, completion and descendant disclosure remain separate actions.

## State and grouping

[ProjectPage](../apps/web/src/routes/ProjectPage.tsx) owns the collapsed group-key set above the Tasks/Board switch. Its existing actor/workspace/project content key scopes that state. Switching views, filtering, loading another page or renaming/reordering a section does not clear it. A different project or a fresh page owner starts expanded. This is in-memory interface state, with no API, preference schema, URL, local storage or automatic write.

Both page recovery and [TaskTable](../apps/web/src/features/task-table/TaskTable.tsx) use the existing `buildTaskGroups` and `visibleTaskRows` helpers. Group keys remain `section:<id>`, `missing:<id>` and `no-section`; no second hierarchy algorithm is introduced. Children follow their displayed root's group even when their own section differs. Missing-parent roots and cycle handling retain the existing tree semantics. New groups start expanded. A formerly unavailable section that later resolves uses the existing known-section key rather than migrating interface state between group kinds.

The table supports controlled page state and an internal fallback for standalone use. Descendant task collapse stays separate and is preserved through section collapse/re-expansion. Header buttons expose `aria-expanded`; valid table row-group markup remains intact. Duplicate stored section names and multiple unavailable groups get distinct accessible section-position labels, while their visible stored names remain unchanged. All new interface labels live in `taskTable.sections.*` English JSON messages.

Counts still include all loaded members of the group, including hidden descendants. Filtered or incomplete lists retain the existing loaded-only wording. The loaded team budget and package deduplication use all loaded tasks, never the remaining visible rows. Collapsing every group therefore changes neither totals nor the Graph selection. Empty, archived, unavailable and No section groups support disclosure while keeping their existing creation/rename restrictions. A collapsed empty group does not display a misleading empty-state row.

## Creation and editor recovery

Add task expands the actual quick-create target selected by the existing page logic. If another section's quick draft is already retained, that original section expands and the retained draft resumes; the clicked section does not manufacture a replacement draft. A standalone table expands its clicked group before invoking its creation callback. No task row appears before server confirmation.

A hidden ordinary inline editor retains its active field, focus claim, exact session and original revision. Re-expansion restores the same unsent or held values without taking focus from the disclosure button. The existing page-level Resume original editor action remains available while the editor is hidden; it opens the original task draft in the drawer. Board ignores section visibility and can still render its existing status editor. Other hidden fields keep their ordinary recovery path.

Quick drafts also remain retained when their section collapses. An unsent quick draft can resume through task details. For a pending or unknown quick command, the existing recovery deliberately keeps its original quick editor: Resume now expands that editor's original section before reopening it. Retry still uses the original key and body. No collapse operation sends, retries, discards or changes a command.

A confirmed response can arrive after a row editor unmounts. Existing exact-session reconciliation clears only the confirmed draft; it does not reopen a section, navigate, steal focus or enable a duplicate create/update. Section headers and recovery remain usable while the request is pending or unknown. The owner-level ordinary draft protection from [retained task drafts](44-retained-task-drafts.md) continues to protect unsent task input after its row disappears.

## Hours and custom fields

Time-row controls open dialogs owned by the existing `useTaskTimeTable` page controller, outside the table. Plan/fact/category drafts and original-hours notices survive row unmounting. Current week/person identity and exact held command inputs remain unchanged. Table custom fields are read-only displays; their actual editors live in TaskDrawer, with the existing page-owned field draft map, mutation and Open submission notice. Section collapse adds no alternate editor storage.

Separate pre-existing limitations remain: the hours controller registers a native reload warning but does not register its unsent drafts in the global protected-draft registry. Ordinary custom-field drafts similarly retain their value map but rely on the mounted custom-field editor for their native warning. This slice neither introduces nor repairs those departure-protection gaps. Actual pending/unknown time and field writes continue to use the shared protected-command registry. These limits must not be reported as complete unsent-draft navigation coverage.

## Verification boundary

[Component tests](../apps/web/src/features/task-table/TaskTable.test.tsx) exercise native Enter/Space/focus, loaded counts and totals, cross-section children, descendant independence, standalone Add expansion, empty/archived/unavailable/No section groups and duplicate disclosure labels. [Actual page tests](../apps/web/src/routes/ProjectSections.test.tsx) exercise Tasks/Board/filter/paging retention, metadata rename/reorder, fresh/project scope, Graph selection, ordinary draft recovery, unknown task and quick-create exact retry, late confirmations without focus/navigation changes, viewer access, and existing ordinary/held hours and custom-value recovery outside the collapsed rows.

Source tests do not establish compiled desktop/mobile layout, touch hit targets or real native browser prompts. Those remain separate coordinated QA gates. No build, runtime restart, API database mutation or deployment is part of this source slice. [Daily editing](29-daily-task-editing.md), [personal columns](32-personal-table-columns.md), [Board](33-task-board.md) and [inline title](39-inline-task-title.md) contracts continue to apply.

Source checkpoint: 146 tests passed across 12 affected suites with current contracts aliased to source and one worker. This includes 13 actual ProjectPage section flows and 21 table component cases, with four new disclosure cases; adjacent task, Board, completion, hierarchy, locale, time and custom-field recovery suites also passed. Full web source type checking, scoped ESLint, localization audit, documentation links and diff checks passed. Compiled browser section controls remain pending the next coordinated QA window.
