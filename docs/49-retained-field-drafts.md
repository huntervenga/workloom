# Retained custom-field draft protection

The page now owns an observable custom-field draft store for each actor, workspace and project. Closing a field editor, closing the whole task drawer, switching tasks, or hiding a meeting pane keeps the original field input and its departure protection. No backend, command payload, schema, idempotency key or shared navigation registry changes are introduced.

## Actual regression and ownership

The real AppRoutes/ProjectPage regression first demonstrated the gap: an invalid raw number draft survived Close and reopen, but after the whole drawer closed, native `beforeunload` was not prevented, the unsent-draft registry was inactive, and cross-path navigation left immediately. The ordinary task form and pending-command registry were clean. The same test now verifies native protection, the real router confirmation, Stay, and exact raw input on reopen.

`useFieldValueDrafts` owns a Map-compatible `.current` store, a single unsent-draft registry entry and an event-time native listener. Registration outlives the drawer. Scope changes and unmount remove only that owner's protection; a detached callback can update its old store without protecting, changing or clearing the new owner. Other current owners remain independently protected. The registry and native handlers read current retained input, including synchronous changes earlier in the same event turn.

ProjectPage supplies its matching field mutation and store to the ordinary/meeting drawer. The meeting workspace uses the same hook for the Weekly fallback. MeetingDrawer never combines a supplied mutation with the controller's unrelated store. Existing both-or-neither callers keep their behavior. An optional external mutation without an external store uses only the component-local fallback; that partial override has mounted-editor protection and the command registry, but does not claim retained unsent-draft protection after unmount. A supplied store without a supplied mutation is ignored in favor of the controller pair.

## Raw input, confirmation and recovery

TaskCustomFields writes subscribed immutable session snapshots synchronously. Existing `isSessionDirty` remains the source of dirty semantics. The store does not parse or normalize values: raw invalid number/date/URL input, explicit null, false, zero, empty arrays and an absent value row retain their existing distinctions. Pristine open/close does not create protection; reverting input or explicit Discard draft releases only the appropriate dirty slot.

Each edit has an original identity retained across its immutable updates. Only after successful validation and a genuine change, immediately before the first mutation send, the field form captures the submitted session. Exact retry bypasses that capture and reuses the original command. Confirmed success retires only the same task/field identity with the original draft and base still present. A newer same-slot session/input or any other field/task draft survives. Confirmation while the drawer is closed still reconciles the store; it does not navigate or focus another task. Discard creates a fresh clean session for that field from current loaded data.

Pending and unknown writes remain in the existing command registry. Departure copy still distinguishes unsent input from a possibly saved command. The field form remains disabled for its held payload, and Retry submission sends the same original key/body. The page-owned store does not invent a receipt, clear an unknown command, or authorize a write.

## Source evidence and limits

Focused actual-page tests cover clean open/close, invalid retained input, native departure and router Stay, actual actor-switch Stay with no session POST, explicit discard, pending-to-unknown exact retry and a second field remaining dirty. An actual Weekly meeting close/Stay/reopen test covers the fallback owner with no writes. A partial external-mutation test proves its receipt cannot confirm or alter the controller's unrelated retained draft. Store/hook tests cover raw/null/false/zero semantics, submitted-versus-replacement identity, independent fields/tasks/owners, same-turn warnings and actor/workspace/project cleanup. Adjacent field input/value, retained ordinary task and meeting discussion suites remain regression gates.

The bounded source gate passes 45 tests across seven suites with two workers. The final expanded actual-page file passes all six cases after adding the partial-override regression (46 unique verified tests in total). Web noEmit, scoped lint and localization audit pass. This is source verification; compiled browser, native-browser prompts, visual/mobile and retained-tab acceptance remain separate QA/coordinator gates. No build, runtime restart, migration or main-database operation was performed for this slice.
