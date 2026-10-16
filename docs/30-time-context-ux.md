# Explicit time context and attendance ergonomics

This slice preserves the selected week and person across project and weekly views, and simplifies time-entry and attendance forms. It changes client behavior only. Domain commands, API payloads, database schemas, cutoff checks, source history, and idempotency rules are unchanged.

## Time context

- The project Week link carries the table's selected `week` as weekly `period`, plus its selected `worker`. A table without a selected week sends an explicit empty `period=`. The weekly page then asks the person to choose a week. Existing standalone weekly links without a period retain their existing current/upcoming/past suggestion behavior.
- Back to task table maps `period` back to `week` and preserves the explicit person. A work-package breakdown links using its own period and person, independently of the currently selected table controls.
- [The URL mapper](../apps/web/src/features/planning/navigation.ts) carries only period and person. It does not copy view names, report IDs, task IDs, or pending-command state between routes.
- The weekly screen labels the person used for new entries as **Time entry for**. Report people remain an independent, explicit report selection. A carried unavailable person remains unavailable; it is not replaced with the acting user.
- New weekly plan and actual-hour drafts are scoped to period and person. Choosing a different person resumes that person's draft. Fixed-person forms show a read-only context summary, so switching the person happens through the page control rather than retargeting an open form.
- Resuming a pending or uncertain save finds the original draft using the submitted period, task or work package, and membership identity. It restores the visible context without changing the submitted values or idempotency key.

## Time-entry forms

The existing task-table plan and actual-hour actions already establish a fixed task/person/period. These forms now show that target in a compact summary instead of disabled selectors. The hours input remains the first editable field and receives focus. Weekly forms still require an explicit task/work selection; only their person is fixed by the page context.

Blank, confirmed zero, active, removed, and void states retain their existing meanings. Corrections and recategorization retain their existing reason and revision requirements.

## Meeting attendance

- Saved actual meeting details are summarized with start and duration. Their editor can be opened explicitly.
- Missing, locally edited, pending, or uncertain actual details keep the editor open. Closing and reopening the drawer preserves an unsaved actual edit through the existing page-owned draft.
- Individual attendance appears before team attendance. The team action remains separate and still requires explicit outcomes and review.
- If neither an explicitly requested attendance entry nor the acting person's row is available, the selector asks for a person. It does not choose the first roster entry. Clearing a person selection also keeps it empty.
- Saving actual meeting details and confirming attendance remain separate explicit commands. Planned start/duration are copied only through the existing explicit fill action. Opening any view records no hours.

## Verification and limits

The targeted checks cover URL mapping, empty-period behavior, independent person drafts, an unresolved save resumed under its original identity/key, unavailable people, an explicit attendance target, preserved unsaved actual details, and actual-details retry without attendance writes. Existing cutoff, unknown-write, zero, void, correction, and source-history tests remain in scope.

Component checks use fake API responses and do not write to the running local database. Browser acceptance and production build verification are recorded separately by the run owner; source checks alone do not establish browser acceptance.

Comments/activity, shared authentication, private ACLs, and new collaboration commands are outside these slices. Related requirements remain in [the client plan](05-client-and-ux.md) and [the implementation plan](06-implementation-plan.md).


## Saved report task links

Weekly comparison rows describe a saved work-package/person group and can link to several tasks. The work-type report links each saved source to its exact task. Both show **Title in saved report** separately from **Current task title**. The saved title, source revisions, original estimate, unknown/zero/void states, cutoff, chart, percentages, and authoritative server totals remain unchanged when current task information is read.

[The linked-task panel](../apps/web/src/features/planning/ReportTaskLinks.tsx) opens only through an explicit action. It reveals at most ten additional tasks per action, shows how many linked tasks are visible, and lets the person reach every task ID without selecting the first task automatically. Current task access is rechecked through the existing task GET before any current title or link appears, even when a fresh task is already cached. A denied, missing, failed, or mismatched task response exposes no cached current title or destination. Other available task links remain usable.

Each ordinary task link visibly says it opens in a new tab and uses `target="_blank" rel="noopener"`. The saved report stays mounted in its original tab with its selected run, cohort, expanded details, drafts, and pending or uncertain commands. Opening the panel performs reads only; opening a task records no hours and changes no report.

The destination uses the currently authorized task's project and ID. Its hours context uses the saved row's person (`row.membershipId` for a weekly comparison or `row.workLog.membershipId` for a work-type source), independently of the source page's time-entry selector. The period crosses only when the current task is still in the report's project; an old project's period is never attached to a moved task. Membership context crosses only within the same workspace. The source URL and its selected person do not change.

Fake-API regression coverage includes a 23-task row revealed in batches of ten, an empty row, fresh-cache revalidation, access loss after an authorized read, partial task-read failures, moved-project and wrong-workspace responses, saved-row person versus ambient person, and unchanged pinned weekly and work-type summaries while current titles and later source pages load. Browser new-tab behavior is verified separately by the run owner.


## Results-first report setup

An explicitly selected saved comparison or work-type breakdown now shows its results below a compact heading and saved-report selector. Clean creation settings stay behind **Set up new report**. With no selected result, setup remains visible. Opening setup, changing the selected saved result, or loading a period never calculates a report.

**New report settings** are separate from the already-saved result. Editing a baseline, known-plan option, or report people keeps setup open with an unsaved-settings status. Pending, uncertain, and failed calculations also keep their configuration visible and recoverable. The existing original-period recovery actions and exact-request retries remain in place. The source report's totals and history do not become live projections of the setup inputs.

WeeklyContent owns each period's selection and disclosure state together. This state survives report components unmounting while period queries load, not only hidden tabs. Confirmation compares the submitted period and a stable identity of its actual inputs before clearing dirty/open state. A late acknowledgement for an older configuration cannot clear a newer configuration or another period's draft. Membership order does not change that identity; baseline, known-plan choice, and membership selection do.

Fake-API checks cover clean open/close without writes, selected results with initially collapsed setup, both report types' unsent drafts across an actual period-loading unmount, and pending/unknown calculations retried with their original path, body, and idempotency key. A pure state regression verifies late acknowledgement handling and period isolation. Browser viewport measurements remain a separate acceptance check.


A confirmed calculation refreshes its original period without replacing navigation chosen while it was pending. Its result is selected automatically only if the latest URL still shows the submitted period, corresponding report view, and same saved-run selection as at submission. Explicit saved-report selection and original-command Resume remain navigation actions. Page-level regressions cover a late acknowledgement after choosing another period, another view, or another saved result; exact Resume/retry still opens the confirmed result when the resumed context remains selected.
