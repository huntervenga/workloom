# Explicit task completion

Completion is a task-status command, separate from the square Graph selection. The pinned Task cell shows a round completion control beside its title, with Graph selection in a secondary labeled gutter. Hierarchy indentation applies to task content, leaving the selection gutter aligned. The existing title width, personal column identities, hierarchy, loaded scope and package totals are unchanged. Board receives the same page-owned completion action through an optional render slot; its existing Change status action remains available.

## Choices and confirmed state

The [pure decision](../apps/web/src/features/tasks/taskCompletion.ts) uses exact own-workspace/project status IDs and groups. A known unfinished ordinary task with one done status submits that status on explicit activation. Multiple done statuses require choosing Complete as with the stored status name. No done status produces an explained unavailable action. A done or cancelled task requires an explicit Reopen as choice from todo/in_progress statuses, even when only one exists. No prior status is guessed; cancelled is not presented as completed. Unknown status/type, meetings, archived tasks and read-only access cannot start a generic completion.

The [native action](../apps/web/src/features/tasks/TaskCompletionAction.tsx) supports pointer, Enter and Space activation. Choice menus support normal keyboard navigation and Escape. Its native button is retained across idle, pending and confirmed state within a row. While pending, aria-disabled communicates the lock while synchronous event and command guards refuse further writes, retaining keyboard focus. The circle, completed label and Board lane change only after confirmed server data. There is no optimistic completion, automatic save, blur save or new request on menu open, Escape, locale change or view navigation.

## Existing command and draft ownership

The [page-owned controller](../apps/web/src/features/tasks/useTaskCompletion.ts) uses the existing `commands.update`. Each explicit choice creates a new status-only `EditSession`, preserving the seen merged task revision, with a request containing only expectedRevision and statusId. The existing authorization, dependency policy, baseline/cutoff guards, exact idempotency key/body handling and confirmation ledger remain authoritative. The backend, public API and MCP are unchanged.

Before submitting, the handler rechecks current writable context, current loaded task identity/revision/status, current own-project catalog choices, a visible inline editor, retained drafts and any pending/uncertain task command. It never merges a kept rich, status or different-field draft into completion. Resume opens its existing editor. A currently visible field edit must first be finished or collapsed. Independent drafts for other tasks are preserved. A stale retained menu handler produces a non-writing Review notice; explicit Review acknowledges only that local notice and does not discard a draft or reset mutation errors.

[Feedback](../apps/web/src/features/tasks/TaskCompletionFeedback.tsx) belongs to the page above the view switch. Pending, refusal and unknown-outcome recovery remain reachable when a task is filtered out, Status is hidden or Tasks/Board changes. Unknown retry requires the same submitted variables object and current edit permission and resends the original command unchanged. It cannot retry a later foreign command through an old callback. Refusals use fixed task-save copy rather than server text; the original status draft remains available for review in the existing drawer. The controller does not reset foreign task mutation errors.

Confirmed results reconcile only their exact submitted session through the existing ledger. A confirmation through the original drawer also clears that completion attempt. Late results do not open a drawer, navigate, reopen a menu or focus another control. Discarding or replacing the original resolved draft clears its obsolete local feedback while retaining any independent draft.

## Adjacent scoped corrections

The ordinary Columns trigger is hidden in Board because it configures Tasks. Its controller and dialog stay mounted; unsent choices survive returning to Tasks, and a held column save exposes Resume column save without changing or abandoning the original command.

The Board lanes scroll region now establishes positioning for its absolutely positioned accessibility text. QA demonstrated that positioning this existing container removes the offscreen populated-lane overflow without deleting due labels or hiding page overflow globally. The pre-fix compiled mobile overflow and the DOM-only diagnostic are separate evidence; compiled geometry acceptance remains pending the next coordinated build.

## Verification boundary

Source tests cover exact revision-only writes, separate Graph selection, zero/one/multiple done statuses, explicit done/cancelled reopening, keyboard action and menu dismissal, retained rich/inline/independent drafts, current type/access eligibility, dependency refusal without optimism, committed unknown outcomes and exact retry across a hidden Board task, late acknowledgement without navigation/focus, stale callbacks and foreign-command preservation, current permission loss, explicit Review acknowledgement, live locale feedback and personal-column draft retention across Board.

Compiled desktop/mobile completion flows, actual server authorization/dependency behavior, populated offscreen Board lanes and geometry are separate QA gates. No browser, build, runtime restart or live database mutation is part of these source checks. Existing background constraints remain in [daily task editing](29-daily-task-editing.md), [personal columns](32-personal-table-columns.md) and [the Board contract](33-task-board.md).

Source checkpoint: 271 tests passed across 38 affected suites with current contracts aliased to source and one worker. This includes 18 actual ProjectPage completion/Columns interactions, seven completion-controller identity/lifetime tests, five pure completion-choice cases and live locale feedback. Full web source type checking, scoped ESLint, localization audit and local documentation links passed. The compiled completion and mobile populated-lane geometry gates remain pending.
