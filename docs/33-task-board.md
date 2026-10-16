# Loaded-task board projection

The independent board component is connected to the project route through exact `view=board`, alongside Tasks, Graph and Timeline. The route reuses the existing task query, drawer and status command; the board introduces no independent query, mutation, persisted preference, drag-and-drop, automatic save or server/domain change.

## Component contract

[TaskBoard](../apps/web/src/features/task-board/TaskBoard.tsx) accepts the current loaded tasks, status catalog and membership catalog, `partial`, `writable`, optional date-only `today`, optional `draftTaskIds` and caption, and three parent-owned callbacks:

- `onOpenTask(taskId)` opens a task or its immediate loaded parent through the existing page navigation.
- `onEditStatus(task)` receives the merged current task object, including the seen task revision. The parent can start its existing status-only inline editor.
- `renderStatusEditor(task)` returns that task's active editor or `null` when inactive. It is called once per rendered card per render. The supplied editor owns eligibility, draft lifetime, errors, seen-revision submission, and original-command retry. While a supplied editor is present, the board hides the separate Change status action. An existing editor remains mounted when the latest task becomes read-only or its type needs refresh, so recovery is not silently removed.

The parent must pass `writable=false` for a viewer or archived project, keep command and draft controllers above the view switch, and continue to expose first-page/next-page failures and explicit paging. The independent component does not own those concerns; the project route integration described below supplies them.

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

The isolated projection checks do not establish browser geometry or actual server authorization. Compiled desktop/mobile acceptance and real server writes remain separate QA gates. Requirements remain in [the client plan](05-client-and-ux.md) and [daily task editing](29-daily-task-editing.md).

## Project route integration

[ProjectPage](../apps/web/src/routes/ProjectPage.tsx) passes the same filtered, infinitely paged loaded task scope to Tasks and Board. It merges independent revisions before rendering or opening a status editor. Search, status, participant, tag and archive filters remain mounted while switching views; switching neither writes personal table preferences nor installs a separate task query. Only exact `view=board` selects Board. First-page errors hide the task view; a next-page error keeps existing cards and offers explicit Try again. Load more tasks uses the existing next cursor. The more-matching notice is shown only when the loaded scope has further pages, including filtered scopes; a complete filtered set does not claim additional matching tasks exist.

Task-title buttons open the existing drawer. Change status starts the existing `InlineTaskEdit` for `statusId`, using the seen task revision and explicit Save. The route owns the command/session above both views. There is no optimistic move: the card changes lane only after a confirmed result. Current dependency policy, task type, archive/access guards, pending locks, conflict review and exact idempotency-key/body retry are unchanged. Viewer, meeting, archived and unknown-type tasks cannot start a generic status change.

Status editors can survive a view switch even if the personal table preference hides Status. A hidden non-status editor, hidden quick-add draft or filtered-out task exposes the existing Resume original editor recovery. Confirmation reconciles only its exact submitted session; it cannot restore a stale draft, create a duplicate write, reopen a closed editor or navigate to a hidden task. One page-owned focus claim per deliberate inline open prevents lane/view remounts and late acknowledgements from stealing focus. A deliberate new open still focuses its field or applicable recovery control.

[Project route tests](../apps/web/src/routes/ProjectBoard.test.tsx) cover these interactions with the real page and fake API, including independently revised overlapping pages, lost acknowledgement/retry, filtered-out pending writes, hidden drafts, read-only/type eligibility, empty and multiple done lanes, unknown statuses, next-page failure and complete filtered counts. The lazy page module is preloaded before the first DOM assertion so these interaction tests do not time source compilation as a UI wait. Browser and real API verification remain pending the coordinated compiled checkpoint.

## Adjacent rapid week-navigation correction

Project query writers and the existing time lens now use [a bounded router-head helper](../apps/web/src/lib/useCurrentSearchParams.ts). The installed React Router 7.18.4 `useSearchParams` implementation passes its render-captured search parameters to a functional setter. That setter can revive an old task locator when a retained Week/Person handler fires immediately after drawer Close. The helper reads the current data-router location, or declarative router history location, when the event fires and applies functional intents through normal navigation. View changes patch only their view parameters, task opening/closing patches its locator, and each individual Week or Person picker changes only its own parameter. An explicit held-session Resume alone sets its original week/person together. It preserves unrelated query parameters and the hash, refuses a handler from another pathname, and returns a controlled refusal if the router exposes no authoritative head. It does not read or mutate browser history directly. Existing selected-person defaults and time-write rules are unchanged.

[The deterministic router tests](../apps/web/src/lib/useCurrentSearchParams.test.tsx) exercise same-act Close then a retained time callback in both `createMemoryRouter` and declarative `MemoryRouter`, preservation of the closed locator and unrelated parameters, Back history, a changed pathname, data-router blockers and an unsupported navigator. Additional deterministic cases cover retained Close→Tasks/Board/Graph/Timeline/Import callbacks, time-context→view changes, both orders of independent week/person changes, null-returning async guards and replace navigation without an extra history entry. The real table-hook callbacks are also retained across both picker events in one act to verify the production partial intents. The original rapid browser sequence remains a separate QA regression without inserted settling waits.

Source checkpoint: 240 tests passed across 35 affected suites with contracts aliased to current source, including 16 ProjectPage Board interactions, 23 shared-router cases and two real retained time-picker cases. Full web source type checking, scoped ESLint, JSON localization audit and documentation link checks passed. These are source checks; compiled desktop/mobile Board and rapid-navigation acceptance are pending the coordinated QA build.
