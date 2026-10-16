# Loaded-task board projection

This slice provides an independent board component. It is not yet connected to the project route or task-table view switch. It introduces no query, mutation, route, persisted preference, drag-and-drop, automatic save, or server/domain change.

## Component contract

[TaskBoard](../apps/web/src/features/task-board/TaskBoard.tsx) accepts the current loaded tasks, status catalog and membership catalog, `partial`, `writable`, optional date-only `today`, optional `draftTaskIds` and caption, and three parent-owned callbacks:

- `onOpenTask(taskId)` opens a task or its immediate loaded parent through the existing page navigation.
- `onEditStatus(task)` receives the merged current task object, including the seen task revision. The parent can start its existing status-only inline editor.
- `renderStatusEditor(task)` returns that task's active editor or `null` when inactive. It is called once per rendered card per render. The supplied editor owns eligibility, draft lifetime, errors, seen-revision submission, and original-command retry. While a supplied editor is present, the board hides the separate Change status action. An existing editor remains mounted when the latest task becomes read-only or its type needs refresh, so recovery is not silently removed.

The parent must pass `writable=false` for a viewer or archived project, keep command and draft controllers above the view switch, and continue to expose first-page/next-page failures and explicit paging. The independent component does not own those concerns and does not imply that project integration is complete.

## Projection and identity

[The pure model](../apps/web/src/features/task-board/boardModel.ts) uses the existing `dedupeTasks` merge. Task fields and selected tags follow the highest task revision; the work-package estimate and participant set retain their independently newest revisions. A loaded task appears as one card in its exact status ID lane. Input order is retained within each lane.

Catalog statuses are ordered by position and then ID. Empty statuses and separate statuses in the same group, including multiple done statuses, remain separate lanes. A missing catalog status gets its own fallback lane keyed internally by its exact missing status ID. Its visible name is a localized Status unavailable ordinal; technical IDs are not shown. Missing status identities are never merged into a guessed default. The projection does not silently slice the loaded set or calculate project, effort, completion, or time totals.

A parent breadcrumb resolves only the immediate `parentTaskId` against the supplied loaded set. A loaded parent is an explicit native button; otherwise the card says Parent task not loaded. No recursion, hierarchy flattening, parent fetch, or cycle traversal runs. Cycles and self references therefore neither hide tasks nor duplicate cards.

The overall and lane counts explicitly describe loaded tasks in this view. A filtered input remains a filtered loaded subset. When `partial=true`, the board states that more matching tasks may be available; the parent still owns Load more and server pagination. These counts are not a claim about all project tasks.

## Controls and accessibility

Cards have separate native buttons for the task title, loaded parent, and Change status. Buttons are not nested and the card itself has no click handler. New Change status controls use the existing exact `canEditTaskInline` predicate plus `writable`: only an ordinary task with `meetingId===null` and `archivedAt===null` can start a new inline change. A meeting, an old response with missing task type, and an archived task can still open details; they do not receive a new status-edit action.

The parent may supply its existing [InlineTaskEdit](../apps/web/src/features/tasks/InlineTaskEdit.tsx), which keeps the seen revision, field-only update, guards, conflict handling and exact retry. The board never writes a status itself or infers that a callback succeeded.

The board is a labeled, focusable horizontal scroll region with named lanes and semantic card lists. Keyboard users can focus the region to scroll and reach every native button with Tab, then activate it with Enter or Space. Lane widths fit small screens; title and missing-status text wrap without line clamping. Scroll overflow is contained locally rather than expanding the page. Native button descriptions identify parent context and the task affected by Change status.

Responsible-person null is Unassigned; an unresolved non-null membership is Assigned person unavailable. Missing due dates remain explicit. Dates are displayed as date-only UTC values. Overdue is shown only when the caller supplies `today`, the due date is earlier, and the known current status group is todo or in_progress; no browser-clock day is inferred. Draft, archived, meeting and refresh-needed indicators are textual and localized. Task, parent, member and status names remain source data.

All component-owned copy is in [the English board catalog](../apps/web/src/i18n/locales/en/board.json). No translation snapshot is stored at module load.

## Verification boundary

Source regressions cover independent-revision deduplication, exact status assignment and counts, empty/multiple-done/missing-status lanes, an unsliced 151-task input, parent cycles and missing parents, native callback and keyboard behavior, read-only/type eligibility, supplied editor retention after a type/access change, explicit date/person states, and zero read or write requests from the projection.

These isolated checks do not establish project-route integration, browser geometry, actual server authorization, or mutation correctness. Integration, compiled desktop/mobile acceptance, paging/error behavior and existing exact-write regressions must be checked separately by their owners. Requirements remain in [the client plan](05-client-and-ux.md) and [daily task editing](29-daily-task-editing.md).
