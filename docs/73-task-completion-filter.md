# Task completion filter

**Status: accepted bounded local UX on `7b9a712`; feature source `a906767`.** This is a bounded server-backed task-list filter. Source, isolated PostgreSQL, full-web and scoped compiled-native checks are recorded separately in [71](71-night-verification.md). It is not full Asana parity or a new completion command. Later `2f71ad8` / BRg changes Graph disclosure wrapping; current `bd8ce21` / Tdb changes Graph locale/accessibility labels. These feature gates remain attributed to `7b9a712` / DG rather than silently rerun; the separate follow-up evidence is in [71](71-night-verification.md).

## User interaction and meaning

The prominent **Task completion** picker offers **All tasks** and **Incomplete tasks**. It uses the existing keyboard-operable choice picker. All tasks is the default. Incomplete tasks requests `completion=open` from the server; All tasks omits that parameter. The active-filter summary exposes the choice, and its clear action returns to All tasks. **Clear filters** clears this choice with the other task filters.

Open means the task's **current status group is `todo` or `in_progress`**, including every custom status assigned to either group. `done` and `cancelled` groups do not match, regardless of the status's display name. Completion is per task: an open child of a closed parent can match independently. This filter does not infer completion from estimate, dates, parent completion, reports or a local loaded-row test.

The SQL repository applies this condition **before pagination**, together with the ordinary authorized workspace/project conditions. It is ANDed with exact status, section, participant, tag, search and archived-task filters. Choosing an exact closed status together with Incomplete tasks can correctly produce no matches. Archived open tasks remain excluded by default and appear only if the separate archive filter includes them. It neither changes status nor performs a write.

## Strict server input and compatibility

The existing task-list schema gains exactly one optional input:

```ts
completion?: 'open'
```

Absent means the unchanged all-task query. There is no wire `all`, `closed`, boolean, empty string or case-insensitive alias. The strict HTTP/domain input rejects unsupported, malformed, repeated or unknown parameters; the existing authorized task search facade shares this same optional filter. Repository code defensively rejects unsupported completion input as well.

No default/null/false completion key is injected when absent. The old normalized request/query shape, canonical query hash, manual **v1** cursor bytes and due-sorted **v2** cursor binding remain unchanged for requests that omit completion. Explicit `open` becomes part of its own query hash. A cursor cannot cross between open/all, another filter, sort, actor, workspace or permission epoch. Current authorization and owned filter scope are checked before cursor decoding. No schema migration, command hash or mutation receipt changes are required.

Source boundaries are [the shared schema](../packages/contracts/src/tasks.ts), [authorized task service](../packages/domain/src/tasks/service.ts) and [task repository](../packages/db/src/repositories/task-repository.ts). The [isolated PostgreSQL contract](../tests/integration/task-completion-filter.test.ts) covers custom groups, AND filters, open children, pagination through closed interleaving, literal old hashes/cursors and a read-only digest; its actual gate result is in [71](71-night-verification.md).

## Page URL and safe invalid values

The project page persists the choice as a single `completion=open` parameter. Back, Forward and reload restore a valid choice; the first request from a filtered URL is already open-filtered. Choosing All tasks deletes only `completion`; view, sort, week/person, open-task locator, unrelated parameters and the hash retain their own owners. Search text remains in memory and is not added to the URL.

The page URL parser deliberately differs from strict API validation: only **one exact `open`** activates the narrowing. Invalid values (`closed`, `all`, `OPEN`, empty) or any repeated `completion` key safely display **All tasks**, send no completion input to the API and leave the original URL unchanged. Reading malformed page state never rewrites browser history or coerces it into a valid server query. A later explicit filter choice can update that owned parameter through normal navigation.

[TaskFilters](../apps/web/src/features/tasks/TaskFilters.tsx) patches only fields whose values actually changed, against the current URL. This preserves unrelated keys and combines rapid independent filter changes rather than replacing the whole query string from an older render.

## Query, presentation and pagination scope

[Task API normalization](../apps/web/src/features/tasks/api.ts) preserves the legacy identity when completion is absent/undefined and serializes explicit `open` with the other normalized server filters. Unsupported runtime values are forwarded to strict validation, never silently downgraded into All tasks. The infinite task-list query includes normalized completion in its actor/workspace/project key; it starts a newly selected query at page one and never carries the other choice's cursor into it. Returning to an existing cache follows the ordinary query cache policy while keeping the two choices' page chains separate.

The [project presentation identity](../apps/web/src/routes/ProjectPage.tsx) also includes completion, so delayed inline focus/receipt intent from an older presentation cannot take over the new list. Sorting and the other filters continue to participate in their normal keys. Loaded pages are the server's filtered answer, not a full unfiltered set hidden with client-side filtering.

Table, Board and Timeline use that server-filtered loaded task list. Budgets and counts keep their loaded-scope meaning. A filtered Board is explicitly **partial**, even when all currently matching pages are loaded; it is not an authoritative complete-project or all-status count. A fully loaded unfiltered Board retains its ordinary complete-loaded-list wording. Timeline's date and move rules remain [18](18-p4b-contract.md) and [72](72-gantt-date-move.md).

The completion choice does not change the dependency graph endpoint, topology, layout writes or explicit selected-root ownership. A previously selected graph root remains selected even if that task leaves the current open list; the selected graph can still request both open and closed roots under existing authorization. No claim is made that every default graph projection is a completion-filtered task list.

## Retained tasks and write safety

Changing this filter is read/navigation state and sends no mutation. Existing explicit complete/reopen actions still use the guarded status command and retained request rules from [68](68-asana-table-editing.md). The list removes a newly closed task only after the server's filtered refetch; the filter does not locally invent a removal or rewrite a cached status. A retained drawer can continue to own a task that leaves the list and can explicitly reopen it; a confirmed server refetch can then return that row.

Task title/description drafts remain with their page-level owner when a filter hides their row. Closing/reopening the drawer or switching All/Incomplete does not overwrite the exact retained inputs or silently save/discard them. Pending/unknown commands keep their exact method/path/body/key, require explicit recovery and are not resent by filter changes. The filter grants no authorization and the head-polling/protection boundary remains [70](70-workspace-live-refresh.md). Browser reload/confirmed departure still has the existing in-memory draft limits; this feature adds no persistent draft storage.

## Verification boundary and limits

Frozen source tests cover [normalization and page-chain separation](../apps/web/src/features/tasks/completion-filter-query.test.tsx), [URL/UI/Board/retained-drawer behavior](../apps/web/src/routes/ProjectCompletionFilter.test.tsx) and the real isolated HTTP/domain/PostgreSQL/search-facade cases linked above. The [four native source cases](../tests/e2e/task-completion-filter.spec.ts) specify 1440/390 keyboard selection, URL/history/reload, Table/Board/Timeline server-result parity, explicit Graph root retention, partial counts and retained complete/reopen/draft flows. Root executed all four cases on the compiled UI: **4/4 passed in 13.2s** at 1440/390 (`/private/tmp/workloom-final-native-task-completion-filter.log`).

On the CP8 baseline before the later daily-entry fixes, root also verified **1,359 web tests / 169 suites**, **1,350 backend tests / 84 suites** and **9 actual isolated PostgreSQL cases** in their separate gates. These are not added to the four native cases. The final DG full web passed **1,367/171**, and completion native passed **4/4 in 12.8s** in `/private/tmp/workloom-daily-recovery-native-task-completion-filter.log`, within the complete 97-case sequence; four additional separate legacy meeting cases bring final distinct compiled coverage to 101. Exact scopes and preserved REDs are in [71](71-night-verification.md). Real Auth/private ACL, production, physical touch/IME, Safari, authoritative project totals, saved named views and full Asana migration/parity are outside this slice.
