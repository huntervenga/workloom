# Personal-column conflict and closed-save recovery

This source slice combines two personal-column fixes that came from separate contributors:

1. **Discard after a confirmed conflict refreshes the authoritative head.** Before this fix, **Discard changes** after a 409 cleared the draft and error but kept the stale cached row, so a new edit could start from a revision the server had already rejected.
2. **A closed definitive failure stays visible.** If a save fails definitively, or its current-head read fails, the notice now stays visible after **My task columns** closes, including Board, Graph and other views where the **Columns** trigger is hidden. Before this fix, the closed notice existed only while a command was held (pending or unconfirmed). Once the server definitively rejected the save (conflict, denial or validation), or acknowledged it but the following current-head read failed, the hold cleared. Every closed recovery control then disappeared while the unsaved draft or failed head remained.

## Discard after conflict

In `usePersonalTablePreference.ts`, `discard` checks whether the current command error is an `ApiError` of kind `conflict` before it clears anything. It then clears the draft and confirmation as before and resets the command unless the error is a denial or authentication failure. For a conflict only, it starts the existing `refreshHead`, which cancels the exact query and fetches the current row with `staleTime: 0`.

While the head is `loading`, the existing `frozen` rule disables checkboxes, reorder, Reset and Save, and makes `setDraft` and `save` no-ops. If the read succeeds, the head returns to `idle` and the next draft takes the fresh revision as `expectedRevision`. If it fails, the head becomes `failed`. Editing stays blocked until **Reload and review** succeeds, and the cached row is not treated as current. Discard without a conflict, including after a validation rejection, does not start a read. A denial is still not reset by Discard.

## Closed failure notice

`PersonalColumnsDialog` adds one closed notice with `role="status"`. It renders only when the dialog is closed, no command is held, and either the latest command error is set or the head state is `failed`. The localized copy is fixed and never includes server text:

| Condition (first match) | Key |
| --- | --- |
| Denied access (401/403), from either the command or a head read | `taskTable.personalColumns.unavailableView` |
| Revision conflict | `taskTable.personalColumns.collapsedConflict` |
| Any other definitive command rejection | `taskTable.personalColumns.collapsedFailed` |
| Head refresh failed after an acknowledged save, or after the conflict-discard refresh | `taskTable.personalColumns.collapsedHeadFailed` |

A denial always uses the existing neutral access copy, "Column settings are unavailable with your current access.". Access is checked before receipt replay, so a 403 on a retry after a lost ACK cannot prove that the first write was not saved. The copy therefore neither confirms nor denies an earlier save. This table reflects source `5af56a8` (see below). The earlier `collapsedDenied` ("not saved") row is removed, along with the claim that any command error proves the command was not saved.

The head-failed copy is neutral. It does not claim a save was confirmed, because the conflict-discard refresh can also end in `failed`. Inside the dialog, the same rule applies to the head copy. While the head is `loading`, `refreshingHead` now reads "Refreshing the current column settings…" for both the post-save and conflict-discard refreshes, rather than starting with "Saved.". When the head is `failed`, the dialog keeps `headFailed` ("The save was confirmed, …") only when the controller's `saveConfirmed` is set. After Discard, which clears it, the dialog uses the new neutral `headRefreshFailed` copy. Command semantics are unchanged.

When the dialog is denied, its `QueryErrorState` shows the actual denial cause. If the query error is a denial or authentication failure (the same rule the controller uses), that error is shown. Otherwise the command error is shown. A stale 503 query error can therefore no longer mask a current 403 command denial. Where the trigger is hidden, the notice adds a **Review columns** button (`taskTable.personalColumns.reviewColumns`) that only opens the dialog. In Table, the existing **Columns** trigger remains the single reopen action, and no second button is added.

The existing held notice is unchanged. The pending and unconfirmed copy, including **Resume column save**, still has priority while a command is held, so it never appears alongside the new notice. A conflict-discard refresh that is still `loading` shows no closed notice. Opening the dialog does not save, discard, reload or refresh. The draft, command error, revision and head state stay with the controller. Inside the dialog, the existing `SaveFeedback`, conflict/denial gating, **Reload and review**, Discard, uncertain retry and head rules apply. A denial stays blocked after reopening, discarding and closing. Focus is not moved when the notice appears. Dialog return focus remains owned by `DialogShell` and the page's `DialogReturnFocus` target. A normal save followed by a successful head refresh leaves no closed notice.

## Files

- `apps/web/src/features/task-table/usePersonalTablePreference.ts`: conflict-aware `discard`
- `apps/web/src/features/task-table/PersonalColumnsDialog.tsx`: closed notice, neutral head copy and denial-cause selection
- `apps/web/src/features/task-table/PersonalColumnsDialog.test.tsx`: two discard-refresh cases
- `apps/web/src/features/task-table/PersonalColumnsRecovery.test.tsx`: new suite with ten cases
- `apps/web/src/i18n/locales/en/taskTable.json`: six new keys under `taskTable.personalColumns`, including `headRefreshFailed`, and a neutral `refreshingHead` value; the existing `unavailableView` key is now used by the closed notice
- `tests/e2e/personal-columns-recovery.spec.ts`: forced clicks on disabled controls removed (see below)
- this document

Concurrent `InlineTaskEdit`, `TaskTable` and `ProjectPage` work belongs to other contributors and is outside this slice.

The discard cases cover two paths after a 409:

- **Successful refresh.** A deferred refresh holds the head in `loading`, with the draft and error cleared, controls disabled, and controller `setDraft` and `save` attempts ignored without a PUT. Once the refresh resolves, the next save sends `expectedRevision` 2, not the stale 1.
- **Failed refresh.** A 503 leaves the head `failed` and not denied, with the stale revision 1 still cached and edits blocked. **Reload and review** then restores revision 2 and allows the save.

The recovery suite uses a page-like harness. One controller is shared while a toggle hides the trigger, as the project page does for its non-Table views. It covers a held Save, then closing the dialog and switching to a view without the trigger, followed by a 409, 403 or 422. It also covers an acknowledged save whose head read returns 503. For each case it checks:

- the safe copy is visible and server text is absent
- focus stays outside the dialog
- the dialog reopens explicitly
- the error and draft are retained
- read and write counts do not change on reopen
- a denial stays blocked after Discard
- Table has no extra reopen action

It also checks that unconfirmed (network-loss) copy stays distinct and that no notice follows a normal save with a fresh head.

Three further cases cover the copy corrections:

- **Denied head after an acknowledged save.** A 403 on the post-save read leaves `command.error` null, `saveConfirmed` set and `denied` true. The closed notice shows the neutral access copy, not `collapsedDenied`, `collapsedHeadFailed` or any "not saved" text. Reopening shows the hidden-project denial without the column list and without another read or write.
- **Stale query 503 with a current command 403.** A 503 refetch leaves a query error. The next Save is denied with 403. The dialog shows the hidden-project denial, not the load-failure or unavailable-service copy. After closing, the notice showed `collapsedDenied` at the time; since `5af56a8` it shows the neutral `unavailableView`.
- **Discard after a 409.** While the refresh is held, the dialog shows "Refreshing the current column settings…" and no status claims a save. A 503 then shows the neutral `headRefreshFailed` alert, not "The save was confirmed". After closing, the notice shows `collapsedHeadFailed`.

## Browser specification

The Discard-refresh case in `tests/e2e/personal-columns-recovery.spec.ts` no longer uses `force: true` clicks on the disabled **Tags** checkbox and **Save columns**. Its blocked-state oracle is the existing native `toBeDisabled` assertions on every checkbox, Save and Reset while the refresh is held, together with the unchanged `Tags` state, write count and server head. No JavaScript click, forced action or timing workaround replaces the forced clicks. Every enabled-action oracle is unchanged.

## Independent review

An independent Claude review (actual model `claude-opus-5-5`) read the uncommitted diff of the five source/test/locale files above. It did not run builds, tests, a browser, the API or the runtime. It found no blocking defect. Bounded observations:

- **Copy for a denied refresh.** If the post-save or conflict-discard head read itself returns 401/403, `denied` becomes true through `query.error` while `command.error` is null. The closed notice then used the neutral head-failed copy rather than access copy. Reopening still showed the denied `QueryErrorState`, and editing stayed blocked, so this was a copy precision issue, not a safety issue. *Resolved:* the closed notice now uses the neutral access copy (see the table above).
- **Coverage gaps.** No source test covered a 401/403 refresh after conflict-discard. No test closed the dialog after a failed conflict-discard refresh. *Partly resolved:* the new Discard case closes after a failed conflict-discard refresh, and the new denied-head case covers a 403 after an acknowledged save. A 401/403 refresh after conflict-discard specifically remains without its own test. It uses the same `denied` rendering.

Later bounded corrections found further copy issues, now resolved: "Saved." in the loading copy after Discard, "The save was confirmed" in the failed-head copy after Discard, and a stale query error masking the current command denial.
- **Repeated Discard.** Discard stays enabled during the `loading` refresh. A second click finds no conflict, because the error was already reset, so it starts no second read.

## Verification status

The user authorized sending code, tests and docs to Anthropic for this work. `.env`, secrets, credentials, `.local` and PostgreSQL data were excluded.

The authoring agents attempted RED/GREEN runs. CLI command-permission patterns stopped Vitest, ESLint, TypeScript and the localization audit from running in their sessions, so **no RED run was observed** for either fix.

The root session then ran these checks, all of which passed:

- **Vitest:** 28 of 28 cases across three personal-columns suites in 6.53 seconds. The suites are `PersonalColumnsDialog.test.tsx` (14 cases), `PersonalColumnsRecovery.test.tsx` (7) and `personalColumns.test.ts` (7). The log is `/private/tmp/workloom-claude-columns-root-tests.log`.
- **Scoped ESLint:** passed on the four changed TypeScript files.
- **Localization audit:** 206 sources, 2,634 calls and 2,590 English messages.

This review relies on that reported evidence and did not reread the log. An owned-file hash freeze recorded earlier by the recovery author was not rechecked.

For the copy corrections, the correcting session ran these checks directly:

- **RED:** with the dialog and `refreshingHead` changes temporarily reverted, the three new recovery cases failed and the other seven passed.
- **GREEN:** 31 of 31 cases across the same three suites in 7.23 seconds (`PersonalColumnsDialog.test.tsx` 14, `PersonalColumnsRecovery.test.tsx` 10, `personalColumns.test.ts` 7).
- **Scoped ESLint:** passed with `--max-warnings=0` on `PersonalColumnsDialog.tsx`, `PersonalColumnsRecovery.test.tsx` and `tests/e2e/personal-columns-recovery.spec.ts`.
- **Localization audit:** 206 sources, 2,634 calls and 2,591 English messages.
- **Root TypeScript:** `tsc -p tsconfig.json` passed.

The hook and its tests were not changed. No build, full test run, browser, API, runtime or database command was run, and the edited E2E specification was not executed.

These are fake-API source tests only. Native browser acceptance of both fixes is pending a separate compiled gate; the compiled `0fc9feb` browser gate remains frozen. E2E preparation is separate. No build, API, runtime, PostgreSQL, migration, seed, authenticated-flow, private-ACL or production claim follows from this slice.

## Compiled browser acceptance at `54005e1`

The paragraphs above record the source-only state at the time and stay unchanged. Later, root ran the normal gates on compiled HEAD `54005e1`: web build, all types and global lint passed, with 954 web cases in 128 suites (maxWorkers 1). Root then ran the four cases in `tests/e2e/personal-columns-recovery.spec.ts` (two flows at 1440/390) against the real API and PostgreSQL. All four passed in 9.5s within the 14:49:57.057–14:50:53.111 UTC window, with all served assets byte-identical.

- **Discard after conflict.** An actual concurrent server 409 is followed by Discard. The held current-head refresh blocks stale edits, and the next Save uses the fresh revision.
- **Closed failure notice.** A delayed real 409 arrives after Save, Close and Board, and the closed feedback stays visible. An explicit reopen from Graph keeps the draft, with no automatic write.

The 403/503 closed-notice and denial-cause paths were not exercised natively and remain covered only by the fake-API source tests above. No separate archive was created; the logs and browser results stay at their original paths. Exact provenance is in [25](25-ux-verification.md).

## Reload without rebasing and neutral denial — `5af56a8`, accepted on `35ec787`

An independent, read-only Claude review of the column-recovery source reported three P3 column-recovery scenarios and no inline-editor finding. It made no native claims. Source `5af56a8` changes `usePersonalTablePreference.ts`, `PersonalColumnsDialog.tsx` and the English catalog. The shared `useIdempotentMutation` hook is unchanged.

- **Only a confirmed conflict rebases.** `reload` records the command error before its read. After a successful read it moves a retained draft to the fresh revision only when that recorded error was a 409. After an ordinary 503 or an access recovery, the draft keeps its original `expectedRevision`, so a later save still detects an intervening change.
- **Reads never disturb a held command.** A reload is allowed while a save is pending or unconfirmed. After the read, the hook checks the latest held command and error. If a command is held or the error changed during the read, it keeps the draft, command, body and key, and resets nothing. Root reviewed this guard in source; no native race claim is made.
- **Denial copy is neutral.** Any denial uses `unavailableView` (table above). The unused `collapsedDenied` key was removed, so the audit's English message count drops from 2,591 to 2,590.

The author observed a real RED on the original source: three cases failed and ten passed. After the fix, the three personal-columns suites passed 34 cases, and the author's web types, lint and localization audit passed. On compiled `35ec787`, root's full web suite passed, and the four real-409 personal-columns cases passed again natively. An independent read-only re-review of four source files found all three P3 findings resolved, with no new blocking issue. It confirmed the bounded guard in source. The change is accepted on that basis: the source tests, the review and the 409 native regression. The non-conflict reload, the 403/503 paths and a direct concurrent reload race remain untested natively. Test-only `6099cea` later added jsdom coverage of the race. A reload GET is held while a user save is pending. When the new head arrives, the pending command and the draft's original revision stay as they were. After a lost ACK, the retry sends exactly the same key and body. Root's three personal-columns suites passed 35/35. A lost ACK that arrives before the reload reply is not covered separately. These native limits stand, and no touch or broader approval is claimed. Exact results are in [25](25-ux-verification.md).

Related: [personal table columns](32-personal-table-columns.md), [contextual toolbar](59-contextual-project-toolbar.md), [Graph dragging](60-graph-dragging.md).
