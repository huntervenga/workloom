# Retained ordinary hours draft protection

## Reproduced gap

Six real ProjectPage/AppRoutes/data-router source tests reproduced the previous behavior before implementation: opening and closing a pristine weekly plan, fact or work-type dialog left a native unload warning; closing a dirty dialog left the protected-draft registry inactive and allowed a different pathname without a guard. The command registry was inactive in all six cases, and no write was sent. Private RED output is retained in the coordinator's source evidence handoff.

## Bounded owner and semantic inputs

[useTaskTimeTable](../apps/web/src/features/work-categories/useTaskTimeTable.tsx) continues to own the same plan, fact and recategorization sessions above Table/Board and dialog lifetimes. One [observable hours owner](../apps/web/src/features/work-categories/retainedHoursDrafts.ts) now publishes immutable session collections and the semantic dirty aggregate synchronously. It registers one slot in the existing protected-draft registry and one native unload handler that reads current retained input at event time. Closing a dialog does not dispose that owner. Actual pending/unknown writes remain independently protected by the existing command registry.

Plan dirtiness compares hours, allocation rows and active/removed state against the session's captured base. Fact dirtiness compares hours, reason and active/void state. Work-type dirtiness compares the selected option and reason with the captured log/binding. The same initial-session factories establish the baseline. Equivalent valid minute formats compare equally. Blank hours remain unknown and differ from explicit zero; blank allocation rows are omitted by the existing submit contract, while zero allocation rows remain explicit. Invalid nonblank input remains dirty and is never normalized away or rewritten. Reasons compare using the existing submit trim semantics. Stale/read metadata alone does not manufacture an input change.

Pristine open/close and a semantic revert leave no draft warning. A dirty closed dialog blocks cross-path navigation and actor switching through the existing unsaved-draft guard; Stay keeps its original values. Same-path period/person/view changes preserve each session's own context. There are no new discard controls: Close retains input, reverting releases actual dirtiness, successful confirmation removes the exact submitted session, and explicit guarded departure disposes the page owner.

## Confirmation and lifetime

The earlier key-only success cleanup could not distinguish a later replacement session under the same key. Each success closure now confirms its captured session identity before removing the entry or closing that session's dialog. A replacement, another period/person session, another draft kind and other owners remain protected. Request bodies, command IDs/keys, retry behavior and dialog writer implementations are unchanged.

The owner is scoped to actor, workspace and project. A new scope receives fresh session collections. Cleanup removes only that owner's subscription, registry slot and native listener. A late callback still targets its detached old owner and cannot protect or clear the new scope. Session objects and allocation maps continue to be replaced through the existing immutable update callbacks; arbitrary in-place mutation is not a supported notification API.

## Verification boundary

Focused tests include the original six RED cases, pristine/revert/confirmed-save behavior for all three dialog kinds, invalid raw input, null versus zero and allocation semantics, exact-session versus replacement confirmation, synchronous registry/native protection, independent owners, actor/workspace/project cleanup, truthful pending/unknown guard copy with original bytes/key retry, and a late acknowledgement while another week/person draft remains open. Existing time navigation, Board context and category flows remain regression gates. Final source verification on 2026-10-16: **7 focused suites / 35 tests passed**, including 26 new real-page, owner and pure-predicate cases. Web source `tsc --noEmit`, scoped ESLint and the repository localization audit passed. Exact hashes and private RED/GREEN log paths are recorded in the source freeze handoff.

No build, served asset replacement, live browser, runtime, API/database write, commit or deployment belongs to this slice. Source tests use fake APIs. Compiled browser Stay/Leave, actor-switch confirmation and native reload prompt behavior remain separate coordinated QA gates. Drafts remain in memory and are not restored after a user confirms departure or reload.
