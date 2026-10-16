# Daily task editing — bounded UI contract

Status: source implementation complete; component verification recorded below. Runtime/browser acceptance is pending for this slice. The accepted initial English/compact-view checkpoint is separate; this document does not claim Asana parity or a completed team pilot.

## Quick creation

The add-task action on a project section opens one inline root-task form for that section. The form accepts a title, an optional assignee and an optional due date. It uses the first ordered `todo` status, or the first existing status when the project has no `todo` status, matching the full task drawer. An empty status catalog prevents creation.

Enter, an explicit Add task button, or Cmd/Ctrl+Enter submits the existing task-create command. No task row or estimate is invented optimistically. Only a confirmed server response clears the draft and focuses the same section's input for another task. Confirmation after the editor was collapsed or unmounted never opens it or moves focus to it.

Escape and Collapse keep the draft in the page-owned create session. More details explicitly opens the existing drawer. A draft with additional drawer fields, a parent task, or a different origin is offered for resumption instead of being overwritten. Pending and unconfirmed quick creation remain bound to the original quick session; More details is unavailable until that command is resolved. Exact-key retry uses the original request through the existing mutation hook.

## Explicit cell edits

Normal, nonarchived tasks with a known `meetingId: null` expose status, assignee and due-date editors. Meetings and retained responses with an unknown task type require their existing detail flow. A viewer or archived project has no edit affordance.

Opening a cell captures the task snapshot the user saw. Saving calls the existing update-input builder and task-update mutation with that snapshot's `expectedRevision`. No work-package or participant revision is added for unrelated cell edits. Calendar dates remain plain date values and preserve the shared final start/due validation. Status, dependency, cutoff, permission and idempotency checks remain authoritative on the server.

Only the marked inline field may be saved from that editor. A richer drawer draft or a different cell's unsaved changes produce a Resume draft action instead of an update. Changing a select or leaving a field does not save. Save, Enter through the form, or Cmd/Ctrl+Enter is explicit; Escape collapses the editor and preserves its draft. A Draft indicator on the task keeps retained changes discoverable.

Conflicts preserve the original draft and require review through More details; the cell does not silently adopt a new revision. A denied or protected write is not treated as success. Pending and unconfirmed commands lock further task changes; an unconfirmed retry resends the original request and key. A collapsed-command notice keeps recovery available. Late confirmation cannot close another editor or steal focus. A page-owned weak confirmation ledger records the exact submitted session object, not merely a task ID or revision. A matching editor reopened during the request reconciles only that confirmed session, so its former draft cannot be restored or submitted again. Full create/edit drawers share this bounded reconciliation. Independent replacement drafts remain untouched; confirming the same session twice is inert.

## Presentation and language

The daily/all-columns presets do not change shared column settings. Explicitly selected weekly plan/actual columns remain visible; task creation and cell edits do not write weekly plans, actual hours, package budgets, custom values or meeting data. Selection checkboxes still select graph roots and do not complete tasks.

Project actions close after an action, outside pointer or Escape. Dialog controllers and drafts stay mounted. Modal close returns focus to the visible project-actions summary rather than a hidden trigger; nested dialogs retain their parent-modal focus behavior.

All new interface labels, validation and recovery copy use English JSON translation keys. Stable IDs/enums and stored task, member, section and project content are unchanged. Existing draft validation descriptors render under the currently selected locale.

## Verification

Source verification: the focused task/table/field/project/dependency/schedule suite plus existing P1a boundary regressions passed 153 tests across 24 files, including 23 daily-editing regressions. Scoped lint, web typecheck, localization audit and whitespace check passed. Documentation links resolve.

Browser acceptance remains pending for the current source. Required coverage:

- Component tests: exact create/update request and revision; no blur/optimistic write; rich/different-field draft protection; Escape/resume; exact-key unknown-result retry; conflict/denial/protected-status preservation; date-range rejection; confirmed-only focus and no late focus steal.
- Component tests: project action → modal → close → View interaction, outside/Escape behavior and draft preservation.
- Targeted web typecheck, lint and localization catalog/source audit.
- Browser checks on the coordinated built runtime: desktop/mobile add and edit, keyboard flows, uncertain-command recovery, original-demo preservation and separate current-access checks.

The existing complete project task process, baseline/weekly contracts, meeting rules and dependency policies remain defined in [task UX](05-client-and-ux.md), [P2a](13-p2a-contract.md), [P2b](14-p2b-contract.md), [meetings](15-p3a-contract.md), [dependencies](17-p4-contract.md), and [dates](18-p4b-contract.md).
