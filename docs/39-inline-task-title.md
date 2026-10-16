# Inline task title rename

The Tasks table offers a separate pencil beside the task title. Its accessible name is `Rename {current task title}`. The linked title still opens task details, the circle changes completion, and the square selects a Graph root. The pencil stays available to keyboard and touch users without hover. This slice adds no Board title editing, backend command, drag behavior or automatic save.

## Editing and commands

[TaskTable](../apps/web/src/features/task-table/TaskTable.tsx) replaces only the title text/action region with the existing [InlineTaskEdit](../apps/web/src/features/tasks/InlineTaskEdit.tsx). Hierarchy, package information and the existing title column width remain unchanged. Save, More details and Collapse remain available in that region; validation and save failures render below the input.

Task name is required and bounded to 500 characters, with the existing shared validation. Explicit Save, Enter or Cmd/Ctrl+Enter in the title input submits. Composition Enter, legacy composition key code 229, Shift+Enter and Alt+Enter do not submit. Blur does not save. Escape or Collapse retains the draft; More details explicitly opens the existing drawer. A trimmed unchanged title closes without a write. The displayed task title changes only after an authoritative server result.

The editor uses the page-owned task command, original task revision, `EditSession` identity and confirmation ledger. A rename body contains only `expectedRevision` and the trimmed `title`. It does not alter status, participants, dates, estimates, package revision or task type. Existing current authorization, archive/type restrictions, dependency and cutoff policies remain authoritative. Viewers, archived rows, meetings and retained responses with unknown task type cannot begin ordinary title editing.

An existing rich draft is never submitted through the pencil, including a drawer draft that changes only title. An existing different-field draft is also Resume-only. Only a title-origin session with title-only changes can resume directly in the title input. Pending or unknown commands retain their exact original session, body and idempotency key. Confirmation reconciles the matching session once even after collapse/reopen, without clearing an independent draft, duplicate update, late navigation or focus theft.

## View and recovery

[ProjectPage](../apps/web/src/routes/ProjectPage.tsx) uses one exhaustive [inline field-to-column mapping](../apps/web/src/features/tasks/tableEditing.ts) for editor visibility and global recovery. Title maps to the pinned title column, so hiding Due does not collapse title editing or hide recovery incorrectly. Board remains status-only. Switching away, filtering the task out or hiding its editor leaves the ordinary page-level Resume original editor action available. It opens the original draft in task details. A late confirmed result clears only its matching session and does not reopen an editor or change the active view.

All new interface copy uses the English JSON key `tasks.inlineEdit.editTitle`; existing field, validation, saving and recovery messages remain shared descriptors that translate at render time. User task titles remain literal content.

## Verification boundary

Source regressions cover title-only original-revision bodies; explicit save versus blur; Enter/Cmd/Ctrl+Enter and composition boundaries; blank, oversized and unchanged titles; retained rich/different-field sessions; exact retry and pending remount confirmation; current locale validation; viewer, archive, meeting and unknown-type boundaries. Actual ProjectPage cases cover distinct Graph selection/title opening/rename, hidden Due, focus after confirmation, Board and filtered-task recovery, no duplicate update and stale-revision review. Existing Board and completion tests remain part of the adjacent source gate.

Source checkpoint: 98 tests passed across six affected suites with contracts aliased to current source and one worker. Full web source type checking, scoped ESLint, localization audit and documentation links/diff checks passed. Compiled desktop/mobile keyboard, IME, hit targets and narrow-column geometry remain separate pending QA gates. No build, runtime restart or live database write was performed for this source slice. The [daily task editing contract](29-daily-task-editing.md) and [completion contract](35-task-completion.md) continue to apply.

The same owned ProjectPage change also forwards the separately approved hierarchy callback `onCreateChild(parent)` to the existing `startCreate({sectionId: parent.sectionId, parent})`. Its UI, tests and contract belong to the separately owned hierarchy slice; no creation controller was added here.
