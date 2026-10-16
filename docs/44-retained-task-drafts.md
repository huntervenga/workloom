# Retained ordinary task draft protection

Ordinary task drafts live in memory on the project page. Closing an editor or opening its parent retains input but unmounts that editor. The page owner must therefore protect the retained input independently of the mounted form. This applies to task detail edits, inline edits, quick creation and child creation; it does not make drafts durable across reload or deliberate departure.

## Observed gap and bounded correction

Three source reproductions used the real ProjectPage, application routes, data router and global navigation guard: dirty task edit → Close; dirty child description → Open parent; and unsaved child creation → Back to parent. Each retained the draft, then lost its native reload warning. Both the draft registry and command registry were inactive, and a different pathname opened without confirmation. None of the reproductions sent a write. The original three cases failed before this correction and pass with the owner protection below.

[useTaskCommands](../apps/web/src/features/tasks/useTaskCommands.ts) owns one [retained-session store](../apps/web/src/features/tasks/retainedTaskSessions.ts). Existing create `.current` assignment and edit `Map` operations keep their caller API and original session objects. Supported Map set/delete/clear operations synchronously recompute the aggregate and update only this owner's slot in the existing protected-draft registry. This registration is distinct from the registry for actual pending or uncertain commands. Unsent input never pretends a command was sent.

An edit session is dirty only when the shared semantic `changedKeys(draftFromTask(base), draft)` comparison finds a change. Merely retaining a clean opened edit form does not protect it. For creation, a nonnull create session is the existing writer contract for explicitly retained input or an unresolved creation. It must not be reclassified by comparing its current status against itself: even an empty-title form can contain an explicit unsaved status choice. Valid submitted creates already contain a nonblank title; the actual command registry independently protects pending or uncertain writes.

[QuickTaskAdd](../apps/web/src/features/tasks/QuickTaskAdd.tsx) now retains a create session on More details only when it actually has dirty or unresolved input. A clean handoff uses the existing callback's explicit section and does not manufacture a retained draft. Opening a clean drawer, quick form or child form therefore leaves protection inactive.

## Lifetime, navigation and reload

The owner registers one native `beforeunload` handler for its lifetime. That handler reads the current aggregate at event time, covering a session mutation earlier in the same turn without waiting for a form or React effect to rerender. Existing mounted-form and global-navigation warnings may coexist; hiding one form cannot remove the owner's protection.

Same-path task, parent, view, week and person navigation remains allowed. A cross-path attempt with only retained unsent input uses the existing `Leave this page?` / `Leave without saving` / `Stay` dialog and truthful unsaved-draft copy. Stay leaves the original page and drafts intact. Actual pending or unknown writes continue to use the existing command warning and exact retry behavior. Native reload/close asks while either current retained input or an actual unresolved command needs protection.

Reverting or explicitly discarding a draft, deleting or clearing its entry, and confirming its exact submitted identity recompute the aggregate. Clearing one entry never releases another dirty edit, create session or owner. Confirmation still records the exact session in the existing weak identity ledger; it does not clear an independent replacement draft or change its key/body. Successful confirmed sessions stop warning only when no other protected input remains.

Actor/workspace scope changes create a fresh owner store. Project changes or explicit departure unmount the existing page owner. Cleanup removes only that owner's registry entry, subscription and native handler. A late mutation of a detached store cannot protect a new page or release another owner. Nothing is persisted to local storage, no route is changed automatically, and no backend or TaskDrawer behavior is modified here.

## Verification boundary

[Actual page tests](../apps/web/src/features/tasks/RetainedTaskDrafts.test.tsx) cover the original three regressions, Stay with retained values, a pristine currently open parent, native reload protection, clean quick → More details with its original section, an empty-title status-only create, revert/discard/explicit departure, a collapsed inline title, and actual pending/unknown task retry with original bytes/key. [Owner tests](../apps/web/src/features/tasks/useTaskCommands.retained.test.tsx) cover same-turn native/registry state, multiple drafts and owners, exact confirmation versus replacement drafts, scope change and late detached callbacks. [Pure store tests](../apps/web/src/features/tasks/retainedTaskSessions.test.ts) cover Map behavior, semantic equality, synchronous notifications and explicit retained create intent.

Source verification does not establish compiled browser dialog behavior or a real browser's native reload prompt. Those remain separate coordinated QA gates. No build, runtime restart, API database mutation or deployment belongs to this source slice. Existing [daily editing](29-daily-task-editing.md), [task detail hierarchy](40-task-detail-hierarchy.md) and [inline title](39-inline-task-title.md) contracts remain unchanged.

Source checkpoint: 113 tests passed across ten affected suites with current contracts aliased to source and one worker, including 16 new cases (eight actual page flows, four owner/lifetime cases and four pure session-store cases). Full web source type checking, scoped ESLint, localization audit, documentation links and diff checks passed. Compiled browser verification remains pending the next coordinated QA window.
