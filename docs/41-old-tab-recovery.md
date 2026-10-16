# Explicit recovery after an app update

## Bounded behavior

Lazy project, week, My tasks and integrations routes keep the existing asynchronous route boundary. A missing chunk already produced a recoverable card with retry and refresh; it did not blank the application shell. A retained old tab can still reference a hashed chunk removed by the next build, so retrying its original import URL cannot obtain the new file.

The boundary now distinguishes a rejected route import from an error rendering an already loaded page. Only an import failure starts one read-only check of the current document HTML. It compares the retained document's built module entry with the returned built module entry. A valid changed entry shows **Workloom has been updated** and promotes **Refresh tab**. An unchanged entry or an inconclusive check keeps generic file/connection guidance, retry and explicit refresh. A changed entry proves that the application entry changed; it does not prove the precise cause of the import failure.

The check uses GET with `cache: no-store`, same-origin mode/credentials, no redirects, and an HTML Accept header. Query and fragment state are omitted from this read. It accepts only a successful same-origin HTML response with one module entry, the app root, and a same-origin `/assets/index-<hash>.js` entry without credentials, query or fragment. It reads at most 128 KiB, stops after three seconds, and aborts when the card leaves or retry starts. HTML is parsed inertly; no returned script is executed or imported. Failed validation, transport errors and timeouts establish no update. Raw errors and response HTML never become UI copy.

## Drafts and commands

Nothing reloads, navigates or retries automatically. Retry remains an explicit action and refresh calls `window.location.reload()`, retaining the current page address, query and fragment. No blanket warning or extra empty-state confirmation is added.

The existing global [ProtectedNavigationGuard](../apps/web/src/app/ProtectedNavigationGuard.tsx) continues to read actual retained draft/command registries. It blocks cross-path departure while protected input remains, and its `beforeunload` listener asks the browser to confirm a reload while actual retained state exists. Staying on the current page keeps that state. Refresh does not persist or reconstruct in-memory drafts, pending commands or original exact-retry details after a user confirms departure. Native unload dialogs remain subject to browser rules; this slice adds no durable draft storage.

## Verification and limits

Source-only verification on 2026-10-16: the targeted AsyncRoute, routeRecovery and existing protected-navigation suites passed, **3 files / 34 tests**; web `tsc --noEmit` and scoped ESLint passed. Coverage includes changed/unchanged entries; origin, type and entry rejection; response overflow; timeout/departure cancellation; import versus render failures; explicit refresh without an automatic retry; stale check completion after retry; recovery action focus across update detection; actual retained draft/command unload protection; and the existing blocked-departure/query-draft regression.

The whole-repository localization audit was also attempted; it reported one unrelated hardcoded `title` value in the concurrently edited `features/tasks/tableEditing.ts`. That file is outside this slice.

No build, served asset replacement, live browser, database or worker action was performed for this source change. The recorded retained-tab failure at checkpoint 9460856 remains historical RED evidence until QA separately records explicit-refresh recovery and a subsequent upgrade using this source. This change cannot retrofit improved wording into an already loaded older entry. It also does not retain historical asset hashes or change deployment policy. Repeated retry can still fail when a stale chunk no longer exists; the validated update state explains the available explicit refresh.
