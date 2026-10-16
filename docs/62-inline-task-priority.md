# Inline task Priority

This bounded client change adds Priority to the existing inline task editor. The native selector exposes the shared `none`, `low`, `medium`, `high` and `urgent` values with the existing localized labels. Selecting a value retains a draft; only explicit Save (or the existing form shortcut) submits it. An unchanged value closes without a command. Clearing Priority sends `priority: "none"`, never null or omission.

The existing builder emits only `{expectedRevision, priority}` for a Priority-only change. The existing update command, parsed input contract, authorization, server guards, exact idempotency key and unknown-response retry remain authoritative. No new endpoint, command, backend behavior or sort preference is introduced. Receipt matching requires the same task identity, task revision and Priority value before page-owned focus can return.

Only ordinary, active tasks with known `meetingId: null` and current write access offer the fresh inline action. Retained drawer edits and drafts for other fields remain Resume-only; a cell cannot submit them. A pending or uncertain change freezes the selector. Collapse, hidden columns and other project views keep the page-owned command available through existing recovery. Confirmation waits for the current list head; a newer Priority/revision or focus elsewhere cancels late focus restoration.

## Integration boundary

The visible Priority cell now uses the existing `cell('priority', ...)` path and its localized `Edit priority for {{title}}` action. The accepted title/depth layout is preserved. No new production ProjectPage path or separate inline command bridge was needed. Priority remains an optional personal column; its existing default visibility and column preferences are unchanged.

The one additive message key is `tasks.inlineEdit.editPriority`: `Edit priority for {{title}}`. The selector and all five option labels reuse `tasks.taskFields` messages. No new locale, resource registry, menu system or translation service is needed.

## Verification status

Source-only editor/field-contract verification passed 20 cases across two new suites; the combined new and existing inline regressions passed 57 cases across four suites. Owned-file ESLint and source-alias no-emit web types passed. These cover all five enum values, exact payload revision, no write on selection, unchanged Save, Escape/reopen, lost-response retry using identical original payload/key, retained rich draft protection, access/type guards, safe conflict copy, exact receipt matching and external focus preservation. The actual ProjectPage regression first captured RED for the missing action after explicitly confirming that the Priority column was visible. After the two-line cell/action wiring and catalog addition, all 19 actual-page cases and the 20 new editor/field-contract cases passed (39 across three suites). Page cases cover exact saves and clearing, no-op Save, rich-draft Resume, Board and hidden-column unknown retry, stale head/receipt focus guards, safe refusals and access/type restrictions. Normal build, actual browser layout, authenticated flows, retained old-tab behavior and runtime acceptance remain separate gates.

The combined affected source run finished with 150 passing cases and one failing pre-existing footer-copy assertion in `TaskTable.test.tsx` (it still expects “Partial project”). All 39 new Priority cases passed. The changed guidance catalog/footer wording is owned by the concurrent table-guidance task; that assertion remains for its owner to reconcile before the global build gate.

Relevant sources are [the existing inline editor](../apps/web/src/features/tasks/InlineTaskEdit.tsx), [field/session helpers](../apps/web/src/features/tasks/tableEditing.ts), [actual page regressions](../apps/web/src/routes/ProjectPriorityEditing.test.tsx) and [retained task draft behavior](44-retained-task-drafts.md).

## Compiled browser status — partial, desktop recovery blocked

The `0fc9feb` combined gate first stopped on two harness setup omissions: normal fresh-project defaults hide optional Priority. After root-approved setup-only personal preference PUTs made it visible in fresh QA projects, mobile passed the complete case in 4.281s. All five native choices, no write on selection/blur, no-op Save, Escape retention, High, genuinely committed Urgent lost ACK, exact Board-hidden original key/body retry, outside focus, explicit clear to None and independent rich-draft retention pass. Four browser PATCH attempts represent three accepted commands; Medium is fixture input, not a default change.

Desktop passes through committed/lost Urgent, then exposes a real layout defect: the sticky estimate cell intercepts the enabled Collapse editor control in a very narrow feedback panel. Original trace call `ziru@255`, screenshot and partial execution remain archived; no forced click, timeout increase or alternate recovery replaces this failure. Desktop retry/clear and full Priority acceptance remain pending a product fix and compiled regression. Exact provenance and paths are in [25](25-ux-verification.md), archive `workloom-evidence/v12-table-complete/manifest.json`. Worker stayed OFF; other accepted title/guidance cases do not make this gate complete.
