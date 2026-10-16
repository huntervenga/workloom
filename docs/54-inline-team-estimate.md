# Inline shared team estimate

The Table's **Team estimate** value opens an explicit inline editor for an ordinary, unarchived task when current UI authorization permits editing. The action is separate from task opening, completion, Graph selection and weekly plan/actual hours. Meetings and retained unknown task types do not gain a generic estimate editor. Existing personal column visibility still controls whether the column appears; Board cards do not add a new estimate action.

The field is **Team estimate (hours)**. Its visible helper always says that it changes the shared budget for the whole team and every task in the work package. A root row, a single loaded task, a filtered result or one assignee group is not evidence of an exclusive package. Existing detail subtasks may edit that same whole-package budget. New detail-task creation still inherits the parent's package and omits an estimate; this slice does not change creation semantics.

## Input and exact command

The existing estimate parser accepts decimal/comma hours and `h:mm`, with exact whole-minute validation and the existing upper bound. Blank means unknown (`null`), while `0` means an estimate of zero. Invalid text stays exactly as typed with a visible, associated validation message. No numeric-input coercion, rounding or silent truncation is introduced. Semantically unchanged text such as `2.00` versus `2:00` sends nothing.

Save, Enter or the existing Ctrl/Cmd+Enter shortcut explicitly submits; blur does not save. Composition and modified-Enter boundaries follow title editing. Escape collapses while preserving a changed draft. The cell's More details action explicitly resumes the existing rich editor. A rich or different-field retained draft is Resume-only and cannot be saved through the estimate cell.

A changed estimate uses the existing task update command and emits only `expectedRevision`, `estimateMinutes` and `expectedWorkPackageRevision`. All values/revisions come from the exact seen editor session. The backend continues to authorize, enforce locks/cutoffs and validate revisions. There are no optimistic row or footer updates. An estimate-only write advances the work-package revision while leaving the task's core revision unchanged; that independence is deliberate.

## Loaded projection and confirmation

The table's existing work-package reconciler receives original loaded DTO copies before row deduplication. Contradictory equal-revision copies therefore remain visible as a conflict, while grouping/Graph selection/counts still show each task once. The loaded team-budget footer counts each package once and remains unavailable during a conflict. It is not an authoritative project/period total or a per-assignee allocation.

Fresh estimate editing requires that the row/editor base exactly matches the known nonconflicting loaded package ID, revision and value. A newer or contradictory loaded package projection cannot open a fresh editor or send a fresh save. An already edited raw draft remains retained, with a localized refresh-required message and access to More details. This check only describes available authorized projections; the server's source revisions remain authoritative for unloaded or concurrent changes.

Pending/unknown commands use the existing page-owned session ledger and idempotency key. An explicit uncertain retry resends the original request even if a later read sees a newer package projection; it does not rebuild a request from that newer projection. Current server authorization still applies before replay. Hiding the column, collapsing its group or switching to Board retains the existing global recovery path to the original task editor.

The page's confirmation comparator has an explicit estimate branch: task identity/core revision plus work-package identity/revision/minutes. It never indexes a nonexistent `TaskDto.estimate` property. Focus restoration also requires the current loaded package summary to agree; a newer sibling package projection cancels restoration. Existing presentation generations and outside pointer/focus/window-blur leases prevent late receipt or delayed-head focus takeover. A confirmed command still reconciles its exact submitted session once across editor remounts.

## Verification

Source-only verification passed 139/139 cases in eight affected suites (48.18s, one worker), source-aliased web TypeScript noEmit and scoped ESLint. New coverage comprises 25 actual ProjectPage cases and three pure estimate session/projection/receipt cases; the existing parser, table, title, Board, grouping and shared inline suites remain green. The tests include contradictory duplicate DTOs for one task (one row/count/Graph selection, withheld conflicting total, fresh estimate disabled), package-only revisions, a newer sibling package projection, draft/unknown-command remounts, rich Resume-only behavior and explicit source-head/focus ordering.

The first actual-page regression was RED against the read-only column: no Edit team estimate action existed. Focused new page/pure cases and the existing estimate parser subsequently passed 37/37 before the broader final run. Initial new-test helper-text/render-settlement mistakes were corrected without changing input or source-safety expectations. Evidence: `/private/tmp/estimate-before-red.log`, `/private/tmp/estimate-final-tests.log`, `/private/tmp/estimate-final-tsc.log`, `/private/tmp/estimate-final-lint.log` and `/private/tmp/estimate-final-audit.log`. Estimate-owned localization checks are clean; the last global audit reported only two concurrent Graph-source strings, tracked by that owner. JSON/local document links and diff whitespace are checked separately in the freeze manifest.

Compiled browser/mobile layout, real backend lock/retry flows and physical keyboard/IME behavior remain pending the next parent-controlled build/QA window. Source checks use fake APIs and do not constitute real-write or compiled acceptance. No backend, database, runtime or deployment change belongs to this slice.

Related contracts: [inline title editing](39-inline-task-title.md), [assignee grouping and inline focus](50-assignee-grouping.md), [retained task drafts](44-retained-task-drafts.md), [personal columns](32-personal-table-columns.md), [task section collapse](45-task-section-collapse.md).
