# My tasks applied URL lens

**Current acceptance:** source `fd0fa07` is included in the compiled `bafc9d6` checkpoint. The later [QA ledger](25-ux-verification.md) records the complete 8/8 desktop/mobile completion/cutoff/My tasks gate, including applied URL filters, separate unsent search, Open→Back/reload, malformed/duplicate values and ignored foreign identity keys with zero browser writes. The source-only checkpoint below preserves its original scope; its compiled-pending tail is superseded by that separate browser evidence.

My tasks keeps its applied relation, completion, archive and search filters in the current route URL. Opening a task and using browser Back restores the same personal list; loading that URL afresh applies the same lens. This is one current applied lens, not a named view or a global sidebar preference. The ordinary sidebar link can still open the default personal list.

## Validation and identity

[The lens](../apps/web/src/features/my-tasks/navigation.ts) reads only relation, completion, includeArchived and search, using the existing `myTasksQuerySchema` field validators. Missing or invalid relation defaults to all; completion defaults to open; archive defaults to false. Explicit string false is false. Repeated owned keys are ambiguous and receive the same safe per-field defaults. Other valid fields are retained when one field is invalid.

Search uses the existing trimmed, at-most-200-character contract. Empty search is omitted. An oversized URL search falls back to empty rather than being truncated into a different query. Mounting a malformed or noncanonical URL does not navigate or write a corrected URL. User actions change only their own key, removing that key for the default value. Unrelated parameters and the hash are preserved.

Actor and workspace identity come from the current authenticated workspace outlet. URL-selected actor, membership, project, workspace, limit or cursor parameters are not copied into the API query. The existing self-only endpoint, actor/workspace query-key scope, current authorization, paging and query errors remain unchanged. Opening a shared lens URL under another actor reads that actor's own tasks; it does not impersonate the URL's author. Existing session switching still clears prior actor data and leaves prior routes.

## Search draft and navigation

[MyTasksPage](../apps/web/src/routes/MyTasksPage.tsx) keeps text being typed locally. Typing alone neither updates the URL nor queries the server. Explicit form submission reads the current form value, validates it and changes only the applied search parameter. A relation, completion or archive change preserves unsent search text and continues querying with the currently applied search.

The local draft resets to the new applied search only when that applied search, actor or workspace changes. The input stays mounted, preserving normal keyboard focus. Back/Forward changes therefore restore the applied text rather than reviving an older unsent draft. A navigation blocker leaves both the applied query and the current typed draft unchanged. Unsubmitted text is intentionally not durable across leaving the page or reload.

Every control uses the shared authoritative current-router updater. Retained callbacks patch the current URL rather than a render-captured copy, so two rapid independent filter changes preserve each other in either order. Normal router history and blockers remain active; there are no browser-history mutations, local storage, mount-time cleanup writes, new backend commands or task mutations.

## Verification boundary

[Router regressions](../apps/web/src/routes/MyTasksNavigation.test.tsx) exercise the real application route through task open, Back and fresh mount; search draft versus applied state and input focus; malformed and repeated keys; explicit false; 200/201-character boundaries; ignored identity/paging inputs; current actor changes; and refusal by a normal data-router blocker. Four retained-callback cases use the production lens hook against an actual router to check both relation/completion orders and both search/archive orders without waiting for a render, with unrelated parameters, hash and Back history preserved.

The existing personal-list tests also cover explicit Submit, read denial, safe errors and paging. Source-only checks do not establish compiled browser coverage. Runtime builds, browser QA and live database writes are outside this slice. Existing self-list behavior remains in [the My tasks contract](28-my-tasks.md).

Source checkpoint: 40 tests passed across three affected suites with current contracts aliased to source and one worker: 13 new My tasks navigation cases, four existing self-list cases and 23 shared current-router regressions. Full web source type checking, scoped ESLint, localization audit and documentation link/diff checks passed. Compiled browser verification remains pending its coordinated QA window.
